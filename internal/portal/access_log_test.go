package portal

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
