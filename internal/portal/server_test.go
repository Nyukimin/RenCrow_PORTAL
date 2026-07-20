package portal

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPortalServesLiveAsDistinctMode(t *testing.T) {
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
	body := rec.Body.String()
	if !strings.Contains(body, `data-mode="live"`) {
		t.Fatalf("live mode should remain distinct: %s", body)
	}
	if !strings.Contains(body, `data-surface="live"`) {
		t.Fatalf("live surface marker is missing: %s", body)
	}
	if strings.Contains(body, `class="theme-modern live-mode lab-mode`) {
		t.Fatalf("live mode must not include lab-mode class: %s", body)
	}
}

func TestPortalLabRendersAIVTuberRoom(t *testing.T) {
	cfg := DefaultConfig()
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/?mode=lab", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, marker := range []string{
		`data-mode="lab"`,
		`data-surface="lab"`,
		`class="theme-modern live-mode lab-mode`,
		`class="lab-stream-shell"`,
		`class="lab-world"`,
		`class="lab-mio-portrait"`,
		`class="lab-shiro-portrait"`,
		`id="chat"`,
		`id="labInp"`,
		`id="labModeMioChip" type="button" data-lab-switch="mio" aria-current="true"`,
		`id="labModeShiroChip" type="button" data-lab-switch="shiro" aria-current="false"`,
		`id="labModeMidoriChip" type="button" data-lab-switch="midori" aria-current="false"`,
		`id="labAudioBtn"`,
		`id="labMicBtn"`,
		`id="labAttachBtn"`,
		`id="labScreenBtn"`,
		`id="labCameraBtn"`,
		`id="labCameraLivePreview"`,
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("AI VTuber room marker %q is missing", marker)
		}
	}
	if strings.Contains(body, `class="lab-icon-btn portal-send-btn"`) {
		t.Fatal("Lab footer must use the established five controls, not a replacement send button")
	}
}

func TestPortalLabSwitcherUsesConfirmedCoreState(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, marker := range []string{
		`setChip('labModeMioChip', !isIdle && selectedRecipient === 'mio');`,
		`setChip('labModeShiroChip', !isIdle && selectedRecipient === 'shiro');`,
		`setChip('labModeMidoriChip', !isIdle && selectedRecipient === 'midori');`,
		`const nextRecipient = isIdle ? selectedRecipient : (normalizeActor(partner) || selectedPartner);`,
		`setModeSwitcherBusy(true);`,
		`await refreshStatus();`,
		`setModeSwitcherBusy(false);`,
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("Lab switcher contract marker %q is missing", marker)
		}
	}
}

func TestPortalLabAlwaysDisplaysSinglePortrait(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	js := string(script)
	css := string(stylesheet)
	for _, forbidden := range []string{
		`body.classList.add('lab-partner-mio', 'lab-partner-shiro');`,
		`body.dataset.labPartner = isIdle ? 'both' : selectedRecipient;`,
	} {
		if strings.Contains(js, forbidden) {
			t.Errorf("Lab must not select multiple portraits: %q", forbidden)
		}
	}
	for _, required := range []string{
		`body.classList.add(` + "`lab-partner-${portraitRecipient}`" + `);`,
		`body.dataset.labPartner = portraitRecipient;`,
		`body.lab-mode.live-mode.lab-idle-mode .lab-mio-portrait,`,
		`body.lab-mode.live-mode.lab-idle-mode.lab-partner-mio .lab-mio-portrait`,
		`body.lab-mode.live-mode.lab-idle-mode.lab-partner-shiro .lab-shiro-portrait`,
		`body.lab-mode.live-mode.lab-idle-mode.lab-partner-midori .lab-midori-portrait`,
	} {
		if !strings.Contains(js+css, required) {
			t.Errorf("single portrait contract marker %q is missing", required)
		}
	}
}

func TestPortalRendersNamedAgentHandoffSpeakers(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, marker := range []string{
		`coder1: {label: 'Coder1'`,
		`coder2: {label: 'Coder2'`,
		`coder3: {label: 'Coder3'`,
		`coder4: {label: 'Coder4'`,
		`coder_loop: {label: 'CoderLoop'`,
		`text === 'heavy'`,
		`text === 'wild'`,
		`/^coder[1-4]$/.test(text)`,
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("Agent handoff speaker marker %q is missing", marker)
		}
	}
}

func TestPortalLiveAllowsReadAndRejectsWrite(t *testing.T) {
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

	readReq := httptest.NewRequest(http.MethodGet, "/api/live/viewer/events", nil)
	readRec := httptest.NewRecorder()
	handler.ServeHTTP(readRec, readReq)
	if readRec.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("read status=%d calls=%d", readRec.Code, calls.Load())
	}

	writeReq := httptest.NewRequest(http.MethodPost, "/api/live/viewer/send", strings.NewReader(`{"message":"hello"}`))
	writeRec := httptest.NewRecorder()
	handler.ServeHTTP(writeRec, writeReq)
	if writeRec.Code != http.StatusForbidden {
		t.Fatalf("live write status = %d, want 403", writeRec.Code)
	}
	if calls.Load() != 1 {
		t.Fatalf("blocked write reached core: calls=%d", calls.Load())
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

func TestPortalProxyAddsTrustedOperationSourceAndClientIP(t *testing.T) {
	var gotClient, gotForwardedFor, gotUserAgent string
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotClient = r.Header.Get("X-RenCrow-Client")
		gotForwardedFor = r.Header.Get("X-Forwarded-For")
		gotUserAgent = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://portal.example/api/lab/viewer/send", strings.NewReader(`{"message":"hello","to":"mio"}`))
	req.RemoteAddr = "203.0.113.42:4567"
	req.Header.Set("Origin", "http://portal.example")
	req.Header.Set("User-Agent", "Mozilla/5.0 test-browser")
	req.Header.Set("X-RenCrow-Client", "spoofed-client")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 body=%s", rec.Code, rec.Body.String())
	}
	if gotClient != "RenCrow_PORTAL" {
		t.Fatalf("X-RenCrow-Client = %q, want RenCrow_PORTAL", gotClient)
	}
	if !strings.Contains(gotForwardedFor, "203.0.113.42") {
		t.Fatalf("X-Forwarded-For = %q, want source IP", gotForwardedFor)
	}
	if gotUserAgent != "Mozilla/5.0 test-browser" {
		t.Fatalf("User-Agent = %q", gotUserAgent)
	}
}

func TestPortalLabAllowsOnlyPublicRecipientAndAudioControlContracts(t *testing.T) {
	tests := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/viewer/recipient-selection"},
		{http.MethodPost, "/viewer/active-control"},
		{http.MethodGet, "/viewer/tts/audio"},
		{http.MethodPost, "/viewer/tts/playback-ack"},
		{http.MethodGet, "/stt"},
	}
	for _, test := range tests {
		if !portalEndpointAllowed(ModeLab, test.method, test.path) {
			t.Errorf("lab should allow %s %s", test.method, test.path)
		}
		if portalEndpointAllowed(ModeView, test.method, test.path) {
			t.Errorf("view must reject %s %s", test.method, test.path)
		}
		if portalEndpointAllowed(ModeLive, test.method, test.path) {
			t.Errorf("live must reject %s %s", test.method, test.path)
		}
	}
	for _, path := range []string{"/viewer/stt/admin/restart", "/viewer/debug/system", "/viewer/llm-ops/restart"} {
		if portalEndpointAllowed(ModeLab, http.MethodPost, path) || portalEndpointAllowed(ModeLab, http.MethodGet, path) {
			t.Errorf("lab must reject administrative endpoint %s", path)
		}
	}
}

func TestPortalLabScriptUsesCoreRecipientTTSAndSTTContracts(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, marker := range []string{
		`post('/viewer/recipient-selection'`,
		`post('/viewer/active-control'`,
		`api('/viewer/tts/audio')`,
		`post('/viewer/tts/playback-ack'`,
		`api('/stt')`,
		`navigator.mediaDevices.getUserMedia`,
	} {
		if !strings.Contains(body, marker) {
			t.Errorf("PORTAL control contract marker %q is missing", marker)
		}
	}
}

func TestPortalLabGuardsRecipientUntilMatchingResponse(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, marker := range []string{
		`let pendingRequest = null;`,
		`viewer_client_id: viewerClientID`,
		`input_source: inputSource`,
		`user_id: viewerUserID`,
		`device_name: viewerDeviceName`,
		`send('stt')`,
		`pendingRequest.jobID = String(accepted.job_id || '').trim();`,
		`String(event.job_id || '') !== pendingRequest.jobID`,
		`type === 'agent.response' && String(event && event.to || '').toLowerCase() === 'user'`,
		`if (pendingRequest) return;`,
	} {
		if !strings.Contains(body, marker) {
			t.Errorf("PORTAL request guard marker %q is missing", marker)
		}
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

func TestPortalLabRejectsCrossOriginSTTWebSocket(t *testing.T) {
	var calls atomic.Int32
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusSwitchingProtocols)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://portal.example/api/lab/stt", nil)
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if calls.Load() != 0 {
		t.Fatalf("cross-origin STT reached CORE: calls=%d", calls.Load())
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
