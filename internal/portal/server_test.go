package portal

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPortalServesViewAsCanonicalLiveAlias(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, `{"ok":true}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/?mode=live", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `data-mode="view"`) {
		t.Fatalf("live alias should render canonical view mode: %s", rec.Body.String())
	}
}

func TestPortalViewAllowsReadAndRejectsWrite(t *testing.T) {
	var calls atomic.Int32
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/viewer/events" {
			t.Fatalf("core path = %q", r.URL.Path)
		}
		_, _ = io.WriteString(w, "data: {}\n\n")
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	readReq := httptest.NewRequest(http.MethodGet, "/api/view/viewer/events", nil)
	readRec := httptest.NewRecorder()
	handler.ServeHTTP(readRec, readReq)
	if readRec.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("read status=%d calls=%d", readRec.Code, calls.Load())
	}

	writeReq := httptest.NewRequest(http.MethodPost, "/api/view/viewer/send", strings.NewReader(`{"message":"hello"}`))
	writeRec := httptest.NewRecorder()
	handler.ServeHTTP(writeRec, writeReq)
	if writeRec.Code != http.StatusForbidden {
		t.Fatalf("view write status = %d, want 403", writeRec.Code)
	}
	if calls.Load() != 1 {
		t.Fatalf("blocked write reached core: calls=%d", calls.Load())
	}
}

func TestPortalLabAllowsOnlyExplicitOperationEndpoints(t *testing.T) {
	var gotPath string
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusAccepted)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	sendReq := httptest.NewRequest(http.MethodPost, "/api/lab/viewer/send", strings.NewReader(`{"message":"hello","to":"mio"}`))
	sendReq.Header.Set("Origin", "http://example.com")
	sendRec := httptest.NewRecorder()
	handler.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusAccepted || gotPath != "/viewer/send" {
		t.Fatalf("send status=%d path=%q", sendRec.Code, gotPath)
	}

	debugReq := httptest.NewRequest(http.MethodGet, "/api/lab/viewer/debug/system", nil)
	debugRec := httptest.NewRecorder()
	handler.ServeHTTP(debugRec, debugReq)
	if debugRec.Code != http.StatusForbidden {
		t.Fatalf("debug status = %d, want 403", debugRec.Code)
	}
}

func TestPortalLabRejectsCrossOriginWrite(t *testing.T) {
	var calls atomic.Int32
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "http://portal.example/api/lab/viewer/send", strings.NewReader(`{"message":"hello"}`))
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if calls.Load() != 0 {
		t.Fatalf("cross-origin write reached CORE: calls=%d", calls.Load())
	}
}

func TestPortalReadinessReflectsCoreHealth(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", rec.Code)
	}
}
