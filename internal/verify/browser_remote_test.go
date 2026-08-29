package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
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

func TestCollectRemoteBrowserEvidencePreservesNonzeroReceiptBoundary(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	configDir := filepath.Join(home, ".config", "rencrow", "portal")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	identity := filepath.Join(home, "id_ed25519")
	if err := os.WriteFile(identity, []byte("private-key-reference"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := remoteBrowserConfig{
		Host: "192.168.1.201", User: "nyukimi", IdentityFile: identity,
		VerifierPath: `C:\Users\nyukimi\rencrow-portal-verify.exe`,
		ManifestPath: `C:\Users\nyukimi\runtime.json`, EvidenceDir: `C:\Users\nyukimi\evidence`,
		BrowserDirectory: `C:\Program Files (x86)\Microsoft\Edge\Application`,
		PortalURL:        "https://portal.example.ts.net",
	}
	configBytes, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "browser-verifier.json"), configBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	receipt := Receipt{
		SchemaVersion: 1, ReceiptSchema: ReceiptSchema, CheckID: "portal_canonical_actor_e2e",
		GuaranteeID: "guarantee-portal-canonical-actor", Owner: Owner, Status: StatusBlocked,
		ObservedAt: "2026-08-29T00:00:00Z", RouteOrTarget: "portal:/api/chat/viewer/send",
		EvidenceRefs: []string{}, FailureBoundary: "real actor response was not rendered for accepted job",
	}
	receiptBytes, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	original := remoteBrowserCommandContext
	remoteBrowserCommandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=TestRemoteBrowserReceiptHelperProcess", "--")
		cmd.Env = append(os.Environ(),
			"RENCROW_REMOTE_BROWSER_HELPER=1",
			"RENCROW_REMOTE_BROWSER_OUTPUT="+string(receiptBytes),
			"RENCROW_REMOTE_BROWSER_EXIT="+strconv.Itoa(ExitBlocked),
		)
		return cmd
	}
	defer func() { remoteBrowserCommandContext = original }()

	_, err = collectRemoteBrowserEvidence(context.Background(), receiptTimeForTest(t), receipt.CheckID)
	if err == nil {
		t.Fatal("blocked remote receipt unexpectedly passed")
	}
	message := err.Error()
	for _, want := range []string{StatusBlocked, receipt.FailureBoundary} {
		if !strings.Contains(message, want) {
			t.Errorf("error %q does not preserve %q", message, want)
		}
	}
}

func TestRemoteBrowserReceiptHelperProcess(t *testing.T) {
	if os.Getenv("RENCROW_REMOTE_BROWSER_HELPER") != "1" {
		return
	}
	fmt.Fprint(os.Stdout, os.Getenv("RENCROW_REMOTE_BROWSER_OUTPUT"))
	code, err := strconv.Atoi(os.Getenv("RENCROW_REMOTE_BROWSER_EXIT"))
	if err != nil {
		code = 1
	}
	os.Exit(code)
}

func receiptTimeForTest(t *testing.T) time.Time {
	t.Helper()
	return time.Date(2026, time.August, 29, 0, 0, 0, 0, time.UTC)
}
