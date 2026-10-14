package portal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestSTTEventsDecisionTable runs the Node.js behavior test of web/stt_events.js.
// Node.js is preinstalled on GitHub-hosted runners. Where CI is set a missing node
// fails the test; on a developer machine without node it is skipped, because the
// repository has no other JavaScript toolchain.
func TestSTTEventsDecisionTable(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("node is required in CI to test web/stt_events.js: %v", err)
		}
		t.Skipf("node not found; skipping web/stt_events.js behavior test: %v", err)
	}
	script, err := filepath.Abs(filepath.Join("webtest", "stt_events.test.js"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, script)
	cmd.Dir = filepath.Dir(script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node stt_events.test.js failed: %v\n%s", err, out)
	}
}

func TestPortalChatLoadsSTTEventsBeforePortalScript(t *testing.T) {
	page, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	body := string(page)
	eventsIndex := strings.Index(body, `<script src="/assets/stt_events.js" defer></script>`)
	portalIndex := strings.Index(body, `<script src="/assets/portal.js" defer></script>`)
	if eventsIndex < 0 || portalIndex < 0 || eventsIndex >= portalIndex {
		t.Fatal("stt_events.js must load before portal.js, which reads window.RenCrowSTTEvents at start")
	}

	handler, err := NewHandler(DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/stt_events.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/assets/stt_events.js status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "classifySTTMessage") {
		t.Fatal("/assets/stt_events.js does not serve the STT event helper")
	}
}

// TestPortalChatSTTErrorsStopOnlyTheSession pins how portal.js applies the decisions of
// stt_events.js: an utterance error keeps the microphone and input right, a session-level
// error and an unintended close of the current connection stop them.
func TestPortalChatSTTErrorsStopOnlyTheSession(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	body := string(script)
	handler := sliceBetween(t, body, "function handleSTTMessage(message) {", "async function startSTT() {")
	utterance := sliceBetween(t, handler, "event.kind === 'utterance_error'", "event.kind === 'session_error'")
	session := handler[strings.Index(handler, "event.kind === 'session_error'"):]

	for _, marker := range []string{"sttEvents.classifySTTMessage(payload)", "event.kind === 'final'"} {
		if !strings.Contains(handler, marker) {
			t.Errorf("handleSTTMessage marker %q is missing", marker)
		}
	}
	for _, forbidden := range []string{"end_reason", "empty_reason"} {
		if strings.Contains(handler, forbidden) {
			t.Errorf("handleSTTMessage must not branch on %s (unknown values are ordinary finals)", forbidden)
		}
	}
	if strings.Contains(utterance, "stopSTT(") || strings.Contains(utterance, "cleanupSTT(") {
		t.Error("an utterance-level STT error must not stop the microphone or release the input right")
	}
	if !strings.Contains(utterance, "STT発話エラー") {
		t.Error("an utterance-level STT error must be shown on the status line")
	}
	if !strings.Contains(session, "stopSTT(true, `STTエラー: ${event.detail}`, true)") {
		t.Error("a session-level STT error must stop the microphone and release the input right")
	}

	start := sliceBetween(t, body, "async function startSTT() {", "function cleanupSTT(")
	for _, marker := range []string{
		"socket.addEventListener('close', (closeEvent) => {",
		"if (sttControl.socket !== socket || !sttControl.enabled) return;",
		"stopSTT(true, sttEvents.describeSTTClose(closeEvent, sttControl.lastUtteranceError));",
		"sttControl.lastUtteranceError = '';",
	} {
		if !strings.Contains(start, marker) {
			t.Errorf("startSTT marker %q is missing", marker)
		}
	}
}

func sliceBetween(t *testing.T, body, from, to string) string {
	t.Helper()
	start := strings.Index(body, from)
	if start < 0 {
		t.Fatalf("marker %q is missing", from)
	}
	end := strings.Index(body[start:], to)
	if end < 0 {
		t.Fatalf("marker %q is missing after %q", to, from)
	}
	return body[start : start+end]
}
