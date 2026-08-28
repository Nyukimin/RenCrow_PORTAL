package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Nyukimin/RenCrow_PORTAL/internal/verify"
)

func TestMainEmitsBlockedReceiptWhenBrowserPrerequisitesAreMissing(t *testing.T) {
	manifest := writeManifest(t, "portal_browser_proxy_e2e", "portal-browser-proxy-e2e")
	evidenceDir := t.TempDir()
	var stdout, stderr bytes.Buffer
	exit := verify.Main([]string{
		"run", "--manifest", manifest, "--check-id", "portal_browser_proxy_e2e",
		"--observed-at", "2026-08-27T00:00:01Z", "--evidence-dir", evidenceDir,
	}, &stdout, &stderr)
	if exit != verify.ExitBlocked {
		t.Fatalf("exit = %d, want %d (stderr=%s)", exit, verify.ExitBlocked, stderr.String())
	}
	var receipt verify.Receipt
	if err := json.Unmarshal(stdout.Bytes(), &receipt); err != nil {
		t.Fatalf("receipt JSON: %v (%s)", err, stdout.String())
	}
	if receipt.Status != verify.StatusBlocked || receipt.Owner != verify.Owner || receipt.ReceiptSchema != verify.ReceiptSchema {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func TestMainRejectsMalformedInvocationWithoutReceipt(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if exit := verify.Main([]string{"run", "--check-id", "portal_readiness"}, &stdout, &stderr); exit != verify.ExitCLIError {
		t.Fatalf("exit = %d, want %d", exit, verify.ExitCLIError)
	}
	if strings.TrimSpace(stdout.String()) != "" {
		t.Fatalf("malformed invocation emitted a receipt: %s", stdout.String())
	}
}

func writeManifest(t *testing.T, checkID, commandID string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "runtime.json")
	data := `{"schema_version":3,"purpose":"operational_status","phase":"runtime","checks":[{"check_id":"` + checkID + `","guarantee_id":"guarantee-` + checkID + `","owner":"RenCrow_PORTAL","purpose":"test","target":"test","phase":"runtime","consumer":"test","failure_action":"blocked","cost":"low","safety_gate":true,"coverage":["readiness"],"executor":{"kind":"owner_cli","command_id":"` + commandID + `","acquisition":{"mode":"owner_self_collect","verification_safe":true,"inputs":[{"id":"fixture","class":"verification_fixture","required":true,"source":"owner_fixed_fixture"}]}},"receipt_schema":"rencrow.check-receipt.v1"}]}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
