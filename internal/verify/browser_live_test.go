package verify

import (
	"runtime"
	"strings"
	"testing"
)

func TestTaggedVerifierFailureBoundaryIsExplicit(t *testing.T) {
	if taggedBrowserBoundary != "external_untagged_browser_prerequisite_absent" {
		t.Fatal("tagged verifier boundary must remain explicit")
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
