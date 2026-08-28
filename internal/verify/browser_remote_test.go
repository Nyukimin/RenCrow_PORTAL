package verify

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateRemoteBrowserConfigRejectsCommandInjectionAndPublicHost(t *testing.T) {
	identity := filepath.Join(t.TempDir(), "id")
	if err := os.WriteFile(identity, []byte("public-key-test-reference"), 0o600); err != nil {
		t.Fatal(err)
	}
	base := remoteBrowserConfig{
		Host: "192.168.1.201", User: "nyukimi", IdentityFile: identity,
		VerifierPath: `C:\Users\nyukimi\rencrow-portal-verify.exe`,
		ManifestPath: `C:\Users\nyukimi\runtime.json`, EvidenceDir: `C:\Users\nyukimi\evidence`,
		BrowserDirectory: `C:\Program Files (x86)\Microsoft\Edge\Application`,
		PortalURL:        "https://portal.example.ts.net",
	}
	if err := validateRemoteBrowserConfig(base); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	badHost := base
	badHost.Host = "203.0.113.10"
	if err := validateRemoteBrowserConfig(badHost); err == nil {
		t.Fatal("public host unexpectedly accepted")
	}
	badCommand := base
	badCommand.VerifierPath += " & whoami"
	if err := validateRemoteBrowserConfig(badCommand); err == nil {
		t.Fatal("command separator unexpectedly accepted")
	}
}
