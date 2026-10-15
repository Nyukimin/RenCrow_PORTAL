package portal

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestAccessLogRecordsForwardedRequest は proxy したリクエストを
// 記録することを確認する
func TestAccessLogRecordsForwardedRequest(t *testing.T) {
	var buf bytes.Buffer
	handler := withAccessLog(newAccessLogger(&buf), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/Chat/viewer/send", nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	entry := decodeAccessLog(t, buf.String())
	if entry.Event != "proxy.request.completed" {
		t.Fatalf("event = %q, want proxy.request.completed", entry.Event)
	}
	if entry.Method != http.MethodPost || entry.Path != "/api/Chat/viewer/send" {
		t.Fatalf("unexpected method/path: %+v", entry)
	}
	if entry.Status != http.StatusOK {
		t.Fatalf("status = %d, want %d", entry.Status, http.StatusOK)
	}
	if entry.Module != "RenCrow_PORTAL" {
		t.Fatalf("module = %q, want RenCrow_PORTAL", entry.Module)
	}
	if entry.SchemaVersion != 1 {
		t.Fatalf("schema_version = %d, want 1", entry.SchemaVersion)
	}
}

// TestAccessLogRecordsDeniedRequest は PORTAL 自身が拒否したリクエストを
// 記録することを確認する
//
// docs/10_ログ仕様.md: mode不許可、endpoint非許可、cross-origin拒否、
// CORE到達不能は CORE に到達しないため PORTAL が唯一の証拠元である。
func TestAccessLogRecordsDeniedRequest(t *testing.T) {
	var buf bytes.Buffer
	handler := withAccessLog(newAccessLogger(&buf), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "このmodeでは許可されていない操作です", http.StatusForbidden)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/IdleChat/viewer/send", nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	entry := decodeAccessLog(t, buf.String())
	if entry.Status != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", entry.Status, http.StatusForbidden)
	}
	if entry.Level != "warn" {
		t.Fatalf("level = %q, want warn (拒否は警告として記録する)", entry.Level)
	}
}

// TestAccessLogRecordsGatewayError は CORE 到達不能を error として
// 記録することを確認する
func TestAccessLogRecordsGatewayError(t *testing.T) {
	var buf bytes.Buffer
	handler := withAccessLog(newAccessLogger(&buf), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "COREへ接続できません", http.StatusBadGateway)
	}))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/Chat/viewer/events", nil))

	entry := decodeAccessLog(t, buf.String())
	if entry.Level != "error" {
		t.Fatalf("level = %q, want error", entry.Level)
	}
}

// TestAccessLogCarriesCorrelation は相関IDを記録することを確認する
//
// viewer_client_id はクエリまたはヘッダから受け取る。CORE のログと
// 突き合わせるための唯一の手がかりになる。
func TestAccessLogCarriesCorrelation(t *testing.T) {
	var buf bytes.Buffer
	handler := withAccessLog(newAccessLogger(&buf), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/Chat/viewer/events?viewer_client_id=portal-abc", nil)
	req.Header.Set(interactionProfileHeader, "portal-chat")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	entry := decodeAccessLog(t, buf.String())
	if entry.ViewerClientID != "portal-abc" {
		t.Fatalf("viewer_client_id = %q, want portal-abc", entry.ViewerClientID)
	}
	if entry.InteractionProfile != "portal-chat" {
		t.Fatalf("interaction_profile = %q, want portal-chat", entry.InteractionProfile)
	}
	if entry.OperationSource != "RenCrow_PORTAL" {
		t.Fatalf("operation_source = %q, want RenCrow_PORTAL", entry.OperationSource)
	}
}

func TestAccessLogRecordsCoreSendCorrelation(t *testing.T) {
	var buf bytes.Buffer
	handler := withAccessLog(newAccessLogger(&buf), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"ok":true,"root_task_id":"tsk_01h000000000000000000001","trace_id":"trace-456","viewer_client_id":"portal-789"}`))
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/Chat/viewer/send", nil)
	req.Header.Set(interactionProfileHeader, "portal-chat")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	entry := decodeAccessLog(t, buf.String())
	if entry.TaskID != "tsk_01h000000000000000000001" {
		t.Fatalf("task_id = %q, want tsk_01h000000000000000000001", entry.TaskID)
	}
	if entry.TraceID != "trace-456" {
		t.Fatalf("trace_id = %q, want trace-456", entry.TraceID)
	}
	if entry.ViewerClientID != "portal-789" {
		t.Fatalf("viewer_client_id = %q, want portal-789", entry.ViewerClientID)
	}
}

// TestAccessLogSkipsHealthProbes は監視用の probe を記録しないことを確認する
//
// 30秒ごとの liveness probe を記録すると、調査に必要な行が埋もれる。
func TestAccessLogSkipsHealthProbes(t *testing.T) {
	var buf bytes.Buffer
	handler := withAccessLog(newAccessLogger(&buf), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/health/live", nil))

	if strings.TrimSpace(buf.String()) != "" {
		t.Fatalf("health probe should not be logged, got: %s", buf.String())
	}
}

type accessLogEntry struct {
	SchemaVersion      int    `json:"schema_version"`
	Level              string `json:"level"`
	Event              string `json:"event"`
	Module             string `json:"module"`
	Method             string `json:"method"`
	Path               string `json:"path"`
	Status             int    `json:"status"`
	DurationMS         int64  `json:"duration_ms"`
	ViewerClientID     string `json:"viewer_client_id"`
	InteractionProfile string `json:"interaction_profile"`
	OperationSource    string `json:"operation_source"`
	TaskID             string `json:"task_id"`
	TraceID            string `json:"trace_id"`
}

func decodeAccessLog(t *testing.T, raw string) accessLogEntry {
	t.Helper()
	line := strings.TrimSpace(raw)
	if line == "" {
		t.Fatal("access log is empty")
	}
	var entry accessLogEntry
	if err := json.Unmarshal([]byte(line), &entry); err != nil {
		t.Fatalf("access log is not valid JSON: %v (raw=%s)", err, line)
	}
	return entry
}

type websocketAccessLogWriter struct {
	lines chan<- string
}

func (w websocketAccessLogWriter) Write(data []byte) (int, error) {
	w.lines <- string(data)
	return len(data), nil
}

// TestAccessLogPreservesWebSocketUpgrade proves that PORTAL's access-log
// ResponseWriter supports a real 101 upgrade across httputil.ReverseProxy.
// A wrapper that lacks Hijack/Unwrap blocks all Chat STT WebSocket sessions.
func TestAccessLogPreservesWebSocketUpgrade(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("upstream hijack: %v", err)
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		_, err = rw.WriteString("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\\r\\n\\r\\n")
		if err != nil {
			t.Errorf("write upstream upgrade: %v", err)
			return
		}
		if err := rw.Flush(); err != nil {
			t.Errorf("flush upstream upgrade: %v", err)
			return
		}
		data := make([]byte, 4)
		if _, err := io.ReadFull(rw, data); err != nil {
			t.Errorf("read upstream payload: %v", err)
			return
		}
		if _, err := rw.Write(data); err != nil {
			t.Errorf("echo upstream payload: %v", err)
			return
		}
		if err := rw.Flush(); err != nil {
			t.Errorf("flush upstream payload: %v", err)
		}
	}))
	defer backend.Close()
	upstreamURL, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}

	logs := make(chan string, 1)
	proxy := httputil.NewSingleHostReverseProxy(upstreamURL)
	portal := httptest.NewServer(withAccessLog(newAccessLogger(websocketAccessLogWriter{lines: logs}), proxy))
	defer portal.Close()
	portalURL, err := url.Parse(portal.URL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("tcp", portalURL.Host, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	request := "GET /api/chat/stt HTTP/1.1\\r\\nHost: " + portalURL.Host +
		"\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13" +
		"\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("read WebSocket upgrade response: %v", err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		t.Fatalf("status = %d, want 101 (response %q)", response.StatusCode, body)
	}

	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write through proxy: %v", err)
	}
	echoed := make([]byte, 4)
	if _, err := io.ReadFull(reader, echoed); err != nil {
		t.Fatalf("read through proxy: %v", err)
	}
	if string(echoed) != "ping" {
		t.Fatalf("proxied payload = %q, want ping", echoed)
	}
	_ = conn.Close()
	select {
	case raw := <-logs:
		entry := decodeAccessLog(t, raw)
		if entry.Status != http.StatusSwitchingProtocols {
			t.Errorf("upgrade access log status = %d, want 101", entry.Status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for completed WebSocket access log")
	}
}
