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
		body := rec.Body.String()
		if !strings.Contains(body, `data-mode="idlechat"`) {
			t.Fatalf("%s should render canonical IdleChat mode: %s", target, body)
		}
		if strings.Contains(body, `portal-surface-nav`) {
			t.Fatalf("%s should not render a mode selector", target)
		}
		if strings.Contains(body, `portal-chat-fixed-canvas`) {
			t.Fatalf("%s must not enable the fixed Chat canvas", target)
		}
		for _, marker := range []string{
			`id="mioPortrait" data-character="mio"`,
			`id="shiroPortrait" data-character="shiro"`,
		} {
			if !strings.Contains(body, marker) {
				t.Fatalf("%s IdleChat avatar marker %q is missing", target, marker)
			}
		}
		if strings.Contains(body, `data-room-switch=`) {
			t.Fatalf("%s IdleChat must not render character switch buttons", target)
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
			`<html lang="ja" class="portal-chat-fixed-canvas">`,
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
			`id="roomAttachmentInput" type="file" multiple hidden`,
			`id="roomScreenBtn"`,
			`id="roomCameraBtn"`,
			`id="roomCameraLivePreview"`,
			`id="roomTextSizeBtn"`,
			`aria-keyshortcuts="Enter"`,
		} {
			if !strings.Contains(body, marker) {
				t.Fatalf("%s AI VTuber room marker %q is missing", target, marker)
			}
		}
		if strings.Contains(body, `class="room-icon-btn portal-send-btn"`) {
			t.Fatalf("%s Chat footer must use the established five controls, not a replacement send button", target)
		}
		if strings.Contains(body, `portal-surface-nav`) {
			t.Fatalf("%s should not render a mode selector", target)
		}
	}
}

func TestPortalChatSupportsTextSizingAndIMESafeSubmit(t *testing.T) {
	page, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(page) + string(script) + string(stylesheet)
	for _, marker := range []string{
		`placeholder="メッセージを入力...（Enterで送信、Shift+Enterで改行）"`,
		`aria-keyshortcuts="Enter"`,
		`const chatTextSizeStorageKey = 'rencrow.portal.chatTextSize';`,
		`const chatTextSizeOrder = Object.freeze(['small', 'medium', 'large']);`,
		`body.dataset.chatTextSize = size;`,
		`event.isComposing || event.keyCode === 229`,
		`event.shiftKey || event.ctrlKey || event.altKey || event.metaKey`,
		`data-chat-text-size="small"`,
		`data-chat-text-size="medium"`,
		`data-chat-text-size="large"`,
		`font-size:var(--room-message-font-size) !important;`,
	} {
		if !strings.Contains(content, marker) {
			t.Errorf("Chat input and text sizing marker %q is missing", marker)
		}
	}
	if strings.Contains(string(script), `!event.ctrlKey ||`) {
		t.Error("Chat submit must not require Ctrl+Enter")
	}
}

func TestPortalChatUsesSeparateLandscapeAndPortraitProfiles(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(script) + string(stylesheet)
	for _, marker := range []string{
		`landscape: Object.freeze({`,
		`physicalWidth: 1920,`,
		`physicalHeight: 1080,`,
		`logicalWidth: 1920,`,
		`logicalHeight: 1080,`,
		`portrait: Object.freeze({`,
		`physicalWidth: 1179,`,
		`physicalHeight: 2556,`,
		`logicalWidth: 393,`,
		`logicalHeight: 852,`,
		`function resolveViewportProfile(viewport)`,
		`return viewport.width >= viewport.height ? viewportProfiles.landscape : viewportProfiles.portrait;`,
		`body.dataset.viewportProfile = profile.id;`,
		`const scale = Math.min(viewport.width / profile.logicalWidth, viewport.height / profile.logicalHeight);`,
		`window.addEventListener('resize', scheduleChatViewportSync, {passive: true});`,
		`document.documentElement.classList.add('portal-chat-fixed-canvas');`,
		`if (mode !== 'chat') return;`,
		`html.portal-chat-fixed-canvas.portal-chat-landscape > body.room-mode.room-stage.room-chat-mode[data-mode="chat"]`,
		`width:1920px;`,
		`height:1080px;`,
		`html.portal-chat-fixed-canvas.portal-chat-portrait > body.room-mode.room-stage.room-chat-mode[data-mode="chat"]`,
		`width:393px;`,
		`height:852px;`,
		`transform:scale(var(--chat-canvas-scale));`,
	} {
		if !strings.Contains(content, marker) {
			t.Errorf("Chat viewport profile marker %q is missing", marker)
		}
	}
}

func TestPortalChatKeepsConversationViewportPosition(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{
		`const chatAutoFollowThreshold = 24;`,
		`const chatScrollState = {`,
		`function isChatAtBottom()`,
		`chat.addEventListener('scroll', updateChatScrollFollow, {passive: true});`,
		`function initializeChatScroll()`,
		`initializeChatScroll();`,
		`function maintainChatScroll()`,
		`if (!chat || !chatScrollState.following) return;`,
		`maintainChatScroll();`,
	} {
		if !strings.Contains(string(script), marker) {
			t.Errorf("Chat conversation scroll marker %q is missing", marker)
		}
	}
}

func TestPortalChatUsesCompactConversationSpacing(t *testing.T) {
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(stylesheet)
	for _, marker := range []string{
		`html.portal-chat-fixed-canvas > body.room-mode.room-stage.room-chat-mode[data-mode="chat"] #chat.chat-conversation{`,
		`gap:4px;`,
		`#chat.chat-conversation .msg{`,
		`margin-bottom:0;`,
	} {
		if !strings.Contains(content, marker) {
			t.Errorf("Chat compact spacing marker %q is missing", marker)
		}
	}
}

func TestPortalChatShowsClockInPortraitHeader(t *testing.T) {
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(stylesheet)
	for _, marker := range []string{
		`html.portal-chat-fixed-canvas.portal-chat-portrait > body.room-mode.room-stage.room-chat-mode[data-mode="chat"] .room-datetime-panel{`,
		`display:flex;`,
		`left:10.22px;`,
		`top:80.68px;`,
		`width:168px;`,
		`font-size:11.25px !important;`,
		`transform:scaleX(.61);`,
	} {
		if !strings.Contains(content, marker) {
			t.Errorf("Portrait Chat clock marker %q is missing", marker)
		}
	}
}

func TestPortalChatUsesCenteredDoubleSizePortraitAvatar(t *testing.T) {
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(stylesheet)
	for _, marker := range []string{
		`body.room-mode.room-stage.room-chat-mode .room-mio-portrait,`,
		`body.room-mode.room-stage.room-chat-mode .room-kuro-portrait,`,
		`body.room-mode.room-stage.room-chat-mode .room-midori-portrait,`,
		`--room-p-avatar-offset-x:clamp(88px,25vw,108px);`,
		`--room-p-avatar-top-offset:clamp(192px,24dvh,216px);`,
		`left:calc(50% + var(--room-p-avatar-offset-x)) !important;`,
		`top:calc(var(--room-p-stage-top) - var(--room-p-avatar-top-offset)) !important;`,
		`width:144vw !important;`,
		`height:88dvh !important;`,
		`transform:translateX(-50%);`,
		`body.room-mode.room-stage.room-chat-mode.room-partner-shiro .room-shiro-portrait{`,
		`body.room-mode.room-stage.room-chat-mode.room-partner-midori .room-midori-portrait{`,
	} {
		if !strings.Contains(content, marker) {
			t.Errorf("Portrait Chat avatar layout marker %q is missing", marker)
		}
	}
}

func TestPortalGamesRendersAgentOwnedGameDesk(t *testing.T) {
	cfg := DefaultConfig()
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/games", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, marker := range []string{
		`data-mode="games"`,
		`data-surface="games"`,
		`id="gamesCatalog"`,
		`data-game-id="nethack"`,
		`id="gamesLaunchForm"`,
		`id="gamesAgentSelect"`,
		`id="gamesObserverFrame"`,
		`id="gamesAgentOverlay"`,
		`Agentが操作します`,
	} {
		if !strings.Contains(body, marker) {
			t.Errorf("Games marker %q is missing", marker)
		}
	}
	if strings.Contains(body, `portal-surface-nav`) {
		t.Fatal("Games should not render a mode selector")
	}
	if strings.Contains(body, `portal-chat-fixed-canvas`) {
		t.Fatal("Games must not enable the fixed Chat canvas")
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
		`const nextRecipient = normalizeActor(partner) || selectedPartner;`,
		`setModeSwitcherBusy(true);`,
		`const confirmed = await post('/viewer/recipient-selection'`,
		`setModeSwitcherBusy(false);`,
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("Chat switcher contract marker %q is missing", marker)
		}
	}
}

func TestPortalChatAgentSwitchDoesNotDependOnIdleChatRuntime(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, marker := range []string{
		`const confirmed = await post('/viewer/recipient-selection', {viewer_client_id: viewerClientID, recipient: nextRecipient});`,
		`if (normalizeActor(confirmed.recipient) !== nextRecipient) throw new Error('CORE recipient selection mismatch');`,
		`if (mode === 'idlechat') {`,
	} {
		if !strings.Contains(body, marker) {
			t.Errorf("independent Chat switch contract marker %q is missing", marker)
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

func TestPortalIdleChatUsesChatSizedQuarterPositionedAvatarPair(t *testing.T) {
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(stylesheet)
	for _, required := range []string{
		`body.room-mode.room-stage.room-idlechat-mode .room-partner-indicator{`,
		`display:none !important;`,
		`width:min(39.583333vw,70.37037vh);`,
		`height:min(32.625vw,58vh);`,
		`body.room-mode.room-stage.room-idlechat-mode #mioPortrait{left:25%;`,
		`body.room-mode.room-stage.room-idlechat-mode #shiroPortrait{left:75%;`,
		`transform:translateX(-37.1875%);`,
		`transform:translateX(-37.421875%);`,
		`width:min(144vw,66.422535dvh) !important;`,
		`--room-idlechat-avatar-height:min(190.778626vw,88dvh);`,
	} {
		if !strings.Contains(content, required) {
			t.Errorf("IdleChat two-character layout marker %q is missing", required)
		}
	}
}

func TestPortalIdleChatRaisesShiroTwentyPointsInBothOrientations(t *testing.T) {
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(stylesheet)
	for _, required := range []string{
		`--room-idlechat-shiro-top:calc(8.5vh - 20pt);`,
		`--room-idlechat-shiro-top:calc(-10.622066dvh - 20pt);`,
	} {
		if !strings.Contains(content, required) {
			t.Errorf("IdleChat Shiro Y offset marker %q is missing", required)
		}
	}
}

func TestPortalIdleChatTranscriptStartsAtShiroVisibleBottom(t *testing.T) {
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}
	content := string(stylesheet)
	for _, required := range []string{
		`--room-idlechat-shiro-top:calc(8.5vh - 20pt);`,
		`--room-idlechat-shiro-visible-bottom-offset:calc(min(16.3125vw,29vh) + min(8.504232vw,15.118634vh));`,
		`top:calc(var(--room-idlechat-shiro-top) + var(--room-idlechat-shiro-visible-bottom-offset)) !important;`,
		`--room-idlechat-shiro-top:calc(-10.622066dvh - 20pt);`,
		`--room-idlechat-shiro-visible-bottom-offset:calc(min(95.389313vw,44dvh) + min(30.9375vw,14.270466dvh));`,
	} {
		if !strings.Contains(content, required) {
			t.Errorf("IdleChat transcript alignment marker %q is missing", required)
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

func TestPortalChatTTSSpeakerUsesCoreCharacterID(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	const speakerResolution = `payload.character_id || payload.characterId || payload.actor || payload.speaker || payload.from || event.from`
	if !strings.Contains(body, speakerResolution) {
		t.Fatalf("TTS speaker must prefer CORE character_id: %q", speakerResolution)
	}
	if strings.Index(body, "payload.character_id") > strings.Index(body, "payload.actor") {
		t.Fatal("TTS speaker must not prefer a legacy actor field over CORE character_id")
	}
	for _, actor := range []string{"mio", "shiro", "kuro", "midori"} {
		if !strings.Contains(body, actor+`: '`+actor+`Avatar'`) {
			t.Errorf("avatar runtime for %s is missing", actor)
		}
	}
}

func TestPortalRendersOnlyPublicAgentConversationEvents(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, marker := range []string{
		`? ['message.received', 'agent.response', 'agent.acknowledge', 'agent.progress']`,
		`: ['idlechat.message'];`,
		`if (!content || !allowedTypes.includes(type)) return false;`,
		`if (type === 'agent.progress')`,
		`if (type === 'agent.acknowledge') return from === 'shiro' && to === 'mio';`,
		`return ` + "`message:${messageID}`",
		`type === 'agent.thinking'`,
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("public conversation marker %q is missing", marker)
		}
	}
	for _, forbidden := range []string{
		`['message.received', 'agent.response', 'idlechat.message'].includes(type)`,
		`post('/viewer/idlechat/start')`,
		`post('/viewer/idlechat/stop')`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("Chat/IdleChat separation marker %q must not remain", forbidden)
		}
	}
	for _, forbidden := range []string{
		`text === 'chatworker'`,
		`text === 'heavy'`,
		`text === 'wild'`,
		`/^coder[1-4]$/.test(text)`,
		`coder_loop: {label:`,
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("internal execution alias marker %q must not remain", forbidden)
		}
	}
}

func TestPortalScriptReportsVisibleSurfaceAndFiltersIdleChatTTS(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	for _, marker := range []string{
		`fetch(api('/viewer/surface-presence')`,
		`body: JSON.stringify({viewer_client_id: viewerClientID, surface: mode, action})`,
		`surfaceHeartbeat = window.setInterval(() => {`,
		`}, 10000);`,
		`document.addEventListener('visibilitychange'`,
		`window.addEventListener('pagehide', releaseSurfaceOnPageHide);`,
		`effectiveMode === 'chat' && !idleChatActive`,
		`eventChannel === 'idlechat' || eventSession.startsWith('idle-')`,
		`if ((mode === 'chat' && isIdleChatTTS) || (mode === 'idlechat' && !isIdleChatTTS)) return;`,
	} {
		if !strings.Contains(body, marker) {
			t.Errorf("surface lifecycle marker %q is missing", marker)
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

func TestPortalChatProxiesEachPublicRecipientUnchanged(t *testing.T) {
	var gotPath, gotBody string
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read proxied request: %v", err)
		}
		gotBody = string(body)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	for _, recipient := range []string{"mio", "shiro", "kuro", "midori"} {
		t.Run(recipient, func(t *testing.T) {
			payload := `{"message":"hello","to":"` + recipient + `"}`
			req := httptest.NewRequest(http.MethodPost, "http://portal.example/api/chat/viewer/send", strings.NewReader(payload))
			req.Header.Set("Origin", "http://portal.example")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusAccepted {
				t.Fatalf("status = %d, want 202 body=%s", rec.Code, rec.Body.String())
			}
			if gotPath != "/viewer/send" {
				t.Fatalf("CORE path = %q, want /viewer/send", gotPath)
			}
			if gotBody != payload {
				t.Fatalf("proxied body = %q, want %q", gotBody, payload)
			}
		})
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

func TestPortalIdleChatProxyUsesDedicatedInteractionProfile(t *testing.T) {
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

func TestPortalSurfacePresenceUsesModeProfile(t *testing.T) {
	var gotProfile, gotPath string
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotProfile = r.Header.Get("X-RenCrow-Interaction-Profile")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		mode    string
		profile string
	}{
		{mode: "chat", profile: "portal-chat"},
		{mode: "idlechat", profile: "portal-idlechat"},
	} {
		req := httptest.NewRequest(http.MethodPost, "http://portal.example/api/"+test.mode+"/viewer/surface-presence", strings.NewReader(`{"viewer_client_id":"tab-1","surface":"`+test.mode+`","action":"claim"}`))
		req.Header.Set("Origin", "http://portal.example")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", test.mode, rec.Code, rec.Body.String())
		}
		if gotProfile != test.profile || gotPath != "/viewer/surface-presence" {
			t.Fatalf("%s profile=%q path=%q", test.mode, gotProfile, gotPath)
		}
	}
}

func TestPortalGamesUsesDedicatedProfileAndAllowlist(t *testing.T) {
	var gotProfile, gotPath string
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotProfile = r.Header.Get("X-RenCrow-Interaction-Profile")
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

	req := httptest.NewRequest(http.MethodPost, "http://portal.example/api/games/viewer/games/launch", strings.NewReader(`{"game_id":"nethack","personas":["mio"],"turns":8,"mode":"auto"}`))
	req.Header.Set("Origin", "http://portal.example")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("launch status = %d, want 202 body=%s", rec.Code, rec.Body.String())
	}
	if gotProfile != "portal-games" || gotPath != "/viewer/games/launch" {
		t.Fatalf("profile=%q path=%q", gotProfile, gotPath)
	}

	for _, blocked := range []string{
		"/api/games/viewer/games/decision",
		"/api/games/viewer/games/result",
		"/api/games/viewer/debug/system",
		"/api/games/viewer/games/observer-api/games/sessions/nh-1/summary",
	} {
		blockedRec := httptest.NewRecorder()
		blockedReq := httptest.NewRequest(http.MethodPost, blocked, strings.NewReader(`{}`))
		handler.ServeHTTP(blockedRec, blockedReq)
		if blockedRec.Code != http.StatusForbidden {
			t.Errorf("%s status = %d, want 403", blocked, blockedRec.Code)
		}
	}
}

func TestPortalGamesObserverProxyIsSameOriginFrameable(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/viewer/games/observer" {
			t.Fatalf("core path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<!doctype html><title>Observer</title>")
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/viewer/games/observer?session=nh-1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("X-Frame-Options"); got != "SAMEORIGIN" {
		t.Fatalf("X-Frame-Options = %q", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'self'") {
		t.Fatalf("observer CSP = %q", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "style-src 'self' 'unsafe-inline'") {
		t.Fatalf("observer CSP must allow title-owned dynamic styles: %q", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); strings.Contains(got, "script-src 'self' 'unsafe-inline'") {
		t.Fatalf("observer CSP must not allow inline scripts: %q", got)
	}
}

func TestPortalGamesEndpointAllowlist(t *testing.T) {
	allowed := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/health"},
		{http.MethodGet, "/viewer/games/status"},
		{http.MethodGet, "/viewer/games/sessions"},
		{http.MethodGet, "/viewer/games/events"},
		{http.MethodGet, "/viewer/games/observer"},
		{http.MethodGet, "/viewer/games/observer-api/games/sessions/nh-1/frames"},
		{http.MethodPost, "/viewer/games/launch"},
		{http.MethodPost, "/viewer/games/observer-api/games/sessions/nh-1/retry"},
		{http.MethodPost, "/viewer/games/observer-api/games/sessions/nh-1/start_over"},
	}
	for _, test := range allowed {
		if !portalEndpointAllowed(ModeGames, test.method, test.path) {
			t.Errorf("Games should allow %s %s", test.method, test.path)
		}
	}
	blocked := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/viewer/games/decision"},
		{http.MethodPost, "/viewer/games/result"},
		{http.MethodPost, "/viewer/games/observer-api/games/sessions/nh-1/summary"},
		{http.MethodPost, "/viewer/games/observer-api/games/launch"},
		{http.MethodGet, "/viewer/debug/system"},
	}
	for _, test := range blocked {
		if portalEndpointAllowed(ModeGames, test.method, test.path) {
			t.Errorf("Games must reject %s %s", test.method, test.path)
		}
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
	for _, mode := range []Mode{ModeChat, ModeIdleChat} {
		if !portalEndpointAllowed(mode, http.MethodPost, "/viewer/surface-presence") {
			t.Errorf("%s must allow surface presence", mode)
		}
		for _, path := range []string{"/viewer/idlechat/start", "/viewer/idlechat/stop"} {
			if portalEndpointAllowed(mode, http.MethodPost, path) {
				t.Errorf("%s must reject manual IdleChat control %s", mode, path)
			}
		}
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
		`navigator.mediaDevices.getDisplayMedia`,
		`form.append('attachments', file, file.name)`,
		`Number(accepted.attachment_count || 0) !== attachments.length`,
		`payload.character_id || payload.characterId || payload.actor || payload.speaker || payload.from || event.from`,
		`const ttsPreferenceStorageKey = 'rencrow.portal.ttsPreference';`,
		`localStorage.getItem(ttsPreferenceStorageKey) === 'off'`,
		`await unlockTTSPlayback();`,
		`await setActiveControl('audio', 'claim', 'portal_tts_on');`,
		"if (!await enableTTS()) {\n        finishRequestGuard();\n        return;",
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

func TestPortalReadinessReflectsCoreReady(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ready" {
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
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"status":"unavailable"`) ||
		!strings.Contains(rec.Body.String(), `"core_status":503`) ||
		!strings.Contains(rec.Body.String(), `"runtime":"go"`) {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestPortalAllowsCoreSizedMultipartViewerSend(t *testing.T) {
	var received int64
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/viewer/send" {
			http.NotFound(w, r)
			return
		}
		n, err := io.Copy(io.Discard, r.Body)
		if err != nil {
			t.Fatalf("read proxied multipart body: %v", err)
		}
		received = n
		w.WriteHeader(http.StatusAccepted)
	}))
	defer core.Close()

	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}

	body := strings.NewReader(strings.Repeat("x", 3<<20))
	req := httptest.NewRequest(http.MethodPost, "http://portal.example/api/chat/viewer/send", body)
	req.Header.Set("Origin", "http://portal.example")
	req.Header.Set("Content-Type", "multipart/form-data; boundary=portal-test")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 body=%s", rec.Code, rec.Body.String())
	}
	if received != 3<<20 {
		t.Fatalf("CORE received %d bytes, want %d", received, 3<<20)
	}
}
