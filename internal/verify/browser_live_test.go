package verify

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestTaggedVerifierFailureBoundaryIsExplicit(t *testing.T) {
	if taggedBrowserBoundary != "external_untagged_browser_prerequisite_absent" {
		t.Fatal("tagged verifier boundary must remain explicit")
	}
}

func TestBrowserWaitsForMioSwitchBeforeSending(t *testing.T) {
	for _, required := range []string{"roomMioChip", "aria-pressed", "roomInput", "disabled"} {
		if !strings.Contains(mioReadyExpression, required) {
			t.Fatalf("Mio readiness expression is missing %q", required)
		}
	}
}

func TestBrowserWaitsForMioReadyBeforeSending(t *testing.T) {
	source, err := os.ReadFile("browser_live.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	ready := strings.Index(body, "chromedp.Poll(mioReadyExpression")
	send := strings.Index(body, "chromedp.SetValue(`#roomInput`")
	if ready < 0 || send < 0 {
		t.Fatal("browser interaction is missing the Mio-ready wait or send input")
	}
	if ready > send {
		t.Fatal("browser send runs before Mio is ready")
	}
}

func TestBrowserPrimesMioBeforeLoadingChat(t *testing.T) {
	for _, required := range []string{"roomConversation.selectedPartner", "mio", "rencrow.portal.ttsPreference", "off"} {
		if !strings.Contains(portalBrowserPreferencesExpression, required) {
			t.Fatalf("browser preferences are missing %q", required)
		}
	}
	source, err := os.ReadFile("browser_live.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	preferences := strings.Index(body, "chromedp.Evaluate(portalBrowserPreferencesExpression")
	chat := strings.Index(body, `chromedp.Navigate(route.Origin+"/?mode=Chat")`)
	if preferences < 0 || chat < 0 || preferences > chat {
		t.Fatal("Mio preference must be set on the published origin before Chat loads")
	}
}

func TestBrowserLiveWaitsForExactAcceptedJobAgentResponse(t *testing.T) {
	source, err := os.ReadFile("browser_live.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(source)
	for _, required := range []string{
		`portalAgentResponsePageFunction`,
		`getAttribute('data-job-id') !== String(jobID)`,
		`getAttribute('data-event-type') !== 'agent.response'`,
		`chromedp.PollFunction(portalAgentResponsePageFunction`,
		`chromedp.WithPollingArgs(jobID)`,
	} {
		if !strings.Contains(body, required) {
			t.Errorf("browser exact job/type correlation marker %q is missing", required)
		}
	}
}

func TestPortalAgentResponseTextAllowsPromptQuote(t *testing.T) {
	prompt := "PORTAL E2E unique prompt"
	response := "Mio: 「" + prompt + "」って確認したよ。"
	if err := validatePortalAgentResponseText(response); err != nil {
		t.Fatalf("quoted prompt response rejected: %v", err)
	}
}

func TestPortalAgentResponseTextRejectsEmpty(t *testing.T) {
	if err := validatePortalAgentResponseText(" \n\t"); err == nil {
		t.Fatal("empty Agent response unexpectedly passed")
	}
}

func TestParseTailscaleServeStatusSelectsTailnetPortalRoute(t *testing.T) {
	raw := []byte(`{
  "TCP": {"443": {"HTTPS": true}},
  "Web": {
    "portal.example.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:18791"}}},
    "portal.example.ts.net:8444": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:18790"}}}
  }
}`)
	route, err := parseTailscaleServeStatus(raw)
	if err != nil {
		t.Fatalf("parseTailscaleServeStatus() error = %v", err)
	}
	if route.Origin != "https://portal.example.ts.net" {
		t.Fatalf("origin = %q", route.Origin)
	}
	if route.Proxy != "http://127.0.0.1:18791" {
		t.Fatalf("proxy = %q", route.Proxy)
	}
}

func TestParseTailscaleServeStatusRejectsFunnelAndUnsafeRoutes(t *testing.T) {
	cases := []string{
		`{"Web":{"portal.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18791"}}}},"AllowFunnel":{"portal.example.ts.net:443":{}}}`,
		`{"Web":{"portal.example.ts.net:443":{"Handlers":{"/health":{"Proxy":"http://127.0.0.1:18791"}}}}}`,
		`{"Web":{"portal.example.com:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18791"}}}}}`,
		`{"Web":{"portal.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18790"}}}}}`,
	}
	for _, raw := range cases {
		if _, err := parseTailscaleServeStatus([]byte(raw)); err == nil {
			t.Errorf("parseTailscaleServeStatus(%s) unexpectedly passed", raw)
		}
	}
}

func TestValidateTailscaleActorHeaderRequiresBoundedHash(t *testing.T) {
	valid := "tailscale-sha256:" + strings.Repeat("a", 64)
	if err := validateTailscaleActorHeader(valid); err != nil {
		t.Fatalf("valid actor rejected: %v", err)
	}
	for _, value := range []string{"", "sha256:" + strings.Repeat("a", 64), "tailscale-sha256:short", "tailscale-sha256:" + strings.Repeat("g", 64)} {
		if err := validateTailscaleActorHeader(value); err == nil {
			t.Errorf("actor %q unexpectedly passed", value)
		}
	}
}

func TestBrowserPlatformEvidenceUsesRuntimePlatform(t *testing.T) {
	if got := browserPlatformEvidence(); got != runtime.GOOS {
		t.Fatalf("platform = %q, want %q", got, runtime.GOOS)
	}
}

func TestChromiumCandidatesArePlatformPortable(t *testing.T) {
	joined := strings.Join(chromiumCandidates("cache"), "\n")
	for _, expected := range []string{"chrome-linux", "chrome-win", "chrome.exe"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("Chromium candidates are missing %q", expected)
		}
	}
}

func TestBrowserLiveFailureBoundaryIsPrecise(t *testing.T) {
	for _, want := range []string{"tailscale", "chromium", "Portal"} {
		if !strings.Contains(strings.ToLower(browserPrerequisiteError(want)), strings.ToLower(want)) {
			t.Fatalf("browserPrerequisiteError(%q) lost prerequisite name", want)
		}
	}
}
