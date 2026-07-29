package portal

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPortalRejectsUnknownViewerMode(t *testing.T) {
	cfg := DefaultConfig()
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	for _, target := range []string{
		"/?mode=unsupported",
		"/unsupported",
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", target, rec.Code)
		}
	}
}

func TestPortalServesIdleChatAsCanonicalMode(t *testing.T) {
	cfg := DefaultConfig()
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	for _, target := range []string{"/", "/?mode=IdleChat", "/idlechat"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d", target, rec.Code)
		}
		if body := rec.Body.String(); !strings.Contains(body, `data-mode="idlechat"`) {
			t.Fatalf("%s should render canonical IdleChat mode: %s", target, body)
		}
	}
}

func TestPortalChatRendersAIVTuberRoom(t *testing.T) {
	cfg := DefaultConfig()
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	for _, target := range []string{"/?mode=Chat", "/chat"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d", target, rec.Code)
		}
		body := rec.Body.String()
		for _, marker := range []string{
			`data-mode="chat"`,
			`data-surface="chat"`,
			`class="theme-modern portal-room-mode`,
			`class="room-stream-shell"`,
			`class="room-world"`,
			`class="room-mio-portrait purupuru-avatar"`,
			`class="room-shiro-portrait purupuru-avatar"`,
			`class="room-kuro-portrait purupuru-avatar"`,
			`class="room-midori-portrait purupuru-avatar"`,
			`id="mioAvatar" character="mio"`,
			`id="shiroAvatar" character="shiro"`,
			`id="kuroAvatar" character="kuro"`,
			`id="midoriAvatar" character="midori"`,
			`id="chat"`,
			`id="roomInput"`,
			`id="roomMioChip" type="button" data-room-switch="mio" aria-current="true"`,
			`id="roomShiroChip" type="button" data-room-switch="shiro" aria-current="false"`,
			`id="roomKuroChip" type="button" data-room-switch="kuro" aria-current="false"`,
			`id="roomMidoriChip" type="button" data-room-switch="midori" aria-current="false"`,
			`id="roomAudioBtn"`,
			`id="roomMicBtn"`,
			`id="roomAttachBtn"`,
			`id="roomScreenBtn"`,
			`id="roomCameraBtn"`,
			`id="roomCameraLivePreview"`,
		} {
			if !strings.Contains(body, marker) {
				t.Fatalf("%s AI VTuber room marker %q is missing", target, marker)
			}
		}
		if strings.Contains(body, `class="room-icon-btn portal-send-btn"`) {
			t.Fatalf("%s Chat footer must use the established five controls, not a replacement send button", target)
		}
	}
}

func TestPortalChatSwitcherUsesConfirmedCoreState(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, marker := range []string{
		`setChip('roomMioChip', !isIdle && selectedRecipient === 'mio');`,
		`setChip('roomShiroChip', !isIdle && selectedRecipient === 'shiro');`,
		`setChip('roomKuroChip', !isIdle && selectedRecipient === 'kuro');`,
		`setChip('roomMidoriChip', !isIdle && selectedRecipient === 'midori');`,
		`const nextRecipient = isIdle ? selectedRecipient : (normalizeActor(partner) || selectedPartner);`,
		`setModeSwitcherBusy(true);`,
		`await refreshStatus();`,
		`setModeSwitcherBusy(false);`,
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("Chat switcher contract marker %q is missing", marker)
		}
	}
}

func TestPortalMountsFourPuruPuruAvatarInstances(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	markup, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	js := string(script)
	css := string(stylesheet)
	html := string(markup)
	for _, required := range []string{
		`id="mioAvatar" character="mio"`,
		`id="shiroAvatar" character="shiro"`,
		`id="kuroAvatar" character="kuro"`,
		`id="midoriAvatar" character="midori"`,
		`/assets/purupuru/runtime-app.js`,
		`/assets/purupuru/runtime-host.js`,
		`['mio', 'shiro', 'kuro', 'midori'].includes(actor)`,
		`runtime.setInput(input)`,
		`getFloatTimeDomainData`,
	} {
		if !strings.Contains(js+css+html, required) {
			t.Errorf("multi-avatar contract marker %q is missing", required)
		}
	}
}

func TestPortalAvatarLayoutUsesSingleChatAndMioShiroIdlePair(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(script) + string(stylesheet)
	for _, required := range []string{
		`if (!roomSurface) return;`,
		`body.classList.toggle('room-idlechat-mode', isIdle);`,
		`body.classList.toggle('room-chat-mode', !isIdle);`,
		`setConversationState(false, selectedRecipient);`,
		`body.room-mode.room-stage.room-chat-mode.room-partner-mio #mioPortrait,`,
		`body.room-mode.room-stage.room-chat-mode.room-partner-shiro #shiroPortrait,`,
		`body.room-mode.room-stage.room-chat-mode.room-partner-kuro #kuroPortrait,`,
		`body.room-mode.room-stage.room-chat-mode.room-partner-midori #midoriPortrait{`,
		`body.room-mode.room-stage.room-chat-mode.room-partner-kuro #mioPortrait{`,
		`body.room-mode.room-stage.room-idlechat-mode #mioPortrait,`,
		`body.room-mode.room-stage.room-idlechat-mode #shiroPortrait{`,
	} {
		if !strings.Contains(content, required) {
			t.Errorf("Chat/IdleChat avatar layout marker %q is missing", required)
		}
	}
}

func TestPuruPuruRendererAssetsRemainNonFrameable(t *testing.T) {
	cfg := DefaultConfig()
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	renderer := httptest.NewRecorder()
	handler.ServeHTTP(renderer, httptest.NewRequest(http.MethodGet, "/assets/purupuru/runtime-app.js", nil))
	if renderer.Code != http.StatusOK {
		t.Fatalf("renderer status = %d", renderer.Code)
	}
	if got := renderer.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("renderer X-Frame-Options = %q", got)
	}
	if got := renderer.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") {
		t.Fatalf("renderer assets must remain non-frameable: %q", got)
	}

	page := httptest.NewRecorder()
	handler.ServeHTTP(page, httptest.NewRequest(http.MethodGet, "/?mode=Chat", nil))
	if got := page.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("portal page X-Frame-Options = %q", got)
	}
	if got := page.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") {
		t.Fatalf("portal page CSP must remain non-frameable: %q", got)
	}
}

func TestPortalLipSyncUsesTTSAudioAmplitude(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, required := range []string{
		`createMediaElementSource(audio)`,
		`getFloatTimeDomainData(ttsControl.meterBuffer)`,
		`Math.sqrt(sum / ttsControl.meterBuffer.length)`,
		`setAvatarInput(ttsControl.speakingActor, {voiceRaw: Math.min(2, rms)})`,
	} {
		if !strings.Contains(body, required) {
			t.Errorf("audio-driven lip sync marker %q is missing", required)
		}
	}
	for _, forbidden := range []string{
		`String(spokenText || '').length`,
		`const pattern = [0.2, 0.64`,
		`contentWindow.postMessage`,
	} {
		if strings.Contains(body, forbidden) {
			t.Errorf("synthetic/iframe lip sync marker %q must not remain", forbidden)
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

func TestPortalRejectsUnknownAPIMode(t *testing.T) {
	var calls atomic.Int32
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/unsupported/viewer/events", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unsupported API status = %d, want 403", rec.Code)
	}
	if calls.Load() != 0 {
		t.Fatalf("unsupported API reached CORE: calls=%d", calls.Load())
	}
}

func TestPortalIdleChatAllowsReadAndRejectsWrite(t *testing.T) {
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

	readReq := httptest.NewRequest(http.MethodGet, "/api/idlechat/viewer/events", nil)
	readRec := httptest.NewRecorder()
	handler.ServeHTTP(readRec, readReq)
	if readRec.Code != http.StatusOK || calls.Load() != 1 {
		t.Fatalf("read status=%d calls=%d", readRec.Code, calls.Load())
	}

	writeReq := httptest.NewRequest(http.MethodPost, "/api/idlechat/viewer/send", strings.NewReader(`{"message":"hello"}`))
	writeRec := httptest.NewRecorder()
	handler.ServeHTTP(writeRec, writeReq)
	if writeRec.Code != http.StatusForbidden {
		t.Fatalf("IdleChat write status = %d, want 403", writeRec.Code)
	}
	if calls.Load() != 1 {
		t.Fatalf("blocked write reached core: calls=%d", calls.Load())
	}
}

func TestPortalChatAllowsOnlyExplicitOperationEndpoints(t *testing.T) {
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

	sendReq := httptest.NewRequest(http.MethodPost, "/api/chat/viewer/send", strings.NewReader(`{"message":"hello","to":"mio"}`))
	sendReq.Header.Set("Origin", "http://example.com")
	sendRec := httptest.NewRecorder()
	handler.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusAccepted || gotPath != "/viewer/send" {
		t.Fatalf("send status=%d path=%q", sendRec.Code, gotPath)
	}

	debugReq := httptest.NewRequest(http.MethodGet, "/api/chat/viewer/debug/system", nil)
	debugRec := httptest.NewRecorder()
	handler.ServeHTTP(debugRec, debugReq)
	if debugRec.Code != http.StatusForbidden {
		t.Fatalf("debug status = %d, want 403", debugRec.Code)
	}
}

func TestPortalProxyAddsTrustedOperationSourceProfileAndClientIP(t *testing.T) {
	var gotClient, gotProfile, gotForwardedFor, gotUserAgent string
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotClient = r.Header.Get("X-RenCrow-Client")
		gotProfile = r.Header.Get("X-RenCrow-Interaction-Profile")
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
	req := httptest.NewRequest(http.MethodPost, "http://portal.example/api/chat/viewer/send", strings.NewReader(`{"message":"hello","to":"mio"}`))
	req.RemoteAddr = "203.0.113.42:4567"
	req.Header.Set("Origin", "http://portal.example")
	req.Header.Set("User-Agent", "Mozilla/5.0 test-browser")
	req.Header.Set("X-RenCrow-Client", "spoofed-client")
	req.Header.Set("X-RenCrow-Interaction-Profile", "spoofed-profile")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 body=%s", rec.Code, rec.Body.String())
	}
	if gotClient != "RenCrow_PORTAL" {
		t.Fatalf("X-RenCrow-Client = %q, want RenCrow_PORTAL", gotClient)
	}
	if gotProfile != "portal-chat" {
		t.Fatalf("X-RenCrow-Interaction-Profile = %q, want portal-chat", gotProfile)
	}
	if !strings.Contains(gotForwardedFor, "203.0.113.42") {
		t.Fatalf("X-Forwarded-For = %q, want source IP", gotForwardedFor)
	}
	if gotUserAgent != "Mozilla/5.0 test-browser" {
		t.Fatalf("User-Agent = %q", gotUserAgent)
	}
}

func TestPortalIdleChatProxyUsesReadOnlyInteractionProfile(t *testing.T) {
	var gotProfile string
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotProfile = r.Header.Get("X-RenCrow-Interaction-Profile")
		w.WriteHeader(http.StatusOK)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/idlechat/viewer/idlechat/status", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if gotProfile != "portal-idlechat" {
		t.Fatalf("X-RenCrow-Interaction-Profile = %q, want portal-idlechat", gotProfile)
	}
}

func TestPortalChatAllowsOnlyPublicRecipientAndAudioControlContracts(t *testing.T) {
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
		if !portalEndpointAllowed(Mode("chat"), test.method, test.path) {
			t.Errorf("Chat should allow %s %s", test.method, test.path)
		}
		if portalEndpointAllowed(ModeIdleChat, test.method, test.path) {
			t.Errorf("IdleChat must reject %s %s", test.method, test.path)
		}
	}
	for _, path := range []string{"/viewer/stt/admin/restart", "/viewer/debug/system", "/viewer/llm-ops/restart"} {
		if portalEndpointAllowed(Mode("chat"), http.MethodPost, path) || portalEndpointAllowed(Mode("chat"), http.MethodGet, path) {
			t.Errorf("Chat must reject administrative endpoint %s", path)
		}
	}
}

func TestPortalChatScriptUsesCoreRecipientTTSAndSTTContracts(t *testing.T) {
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

func TestPuruPuruHostPreservesUpstreamMotionInputs(t *testing.T) {
	host, err := webFiles.ReadFile("web/purupuru/runtime-host.js")
	if err != nil {
		t.Fatal(err)
	}
	hostScript := string(host)
	for _, marker := range []string{
		`window.addEventListener('pointermove'`,
		`index.html?mode=portal&transparent=1`,
		`mouseFollowEnabled: false`,
		`controlPanelLeft: VIRTUAL_STAGE.width - 20 - Math.min(448, VIRTUAL_STAGE.width - 40)`,
		`runtime.setPointer(latestPointer.x, latestPointer.y)`,
		`runtime.setVoiceLevel(0)`,
	} {
		if !strings.Contains(hostScript, marker) {
			t.Errorf("PuruPuru host motion marker %q is missing", marker)
		}
	}
	if strings.Contains(hostScript, `runtime.setInput({voiceRaw: 0, angleX: 0, angleY: 0})`) {
		t.Error("PuruPuru host must not reset pose from a voice initialization")
	}
	if strings.Contains(hostScript, `index.html?mode=obs`) {
		t.Error("PuruPuru host must not reuse standalone OBS behavior as PORTAL behavior")
	}

	portalScript, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(portalScript), `setAvatarInput(actor, {voiceRaw: 0});`) {
		t.Error("PORTAL ready handler must initialize voice without resetting pose")
	}
}

func TestPortalChatGuardsRecipientUntilMatchingResponse(t *testing.T) {
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

func TestPortalChatRejectsCrossOriginWrite(t *testing.T) {
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

	req := httptest.NewRequest(http.MethodPost, "http://portal.example/api/chat/viewer/send", strings.NewReader(`{"message":"hello"}`))
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

func TestPortalChatRejectsCrossOriginSTTWebSocket(t *testing.T) {
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

	req := httptest.NewRequest(http.MethodGet, "http://portal.example/api/chat/stt", nil)
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
