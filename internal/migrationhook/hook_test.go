package migrationhook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigAndStateReceipts(t *testing.T) {
	path := writeConfig(t, `{"listen":"127.0.0.1:18791","core_url":"http://127.0.0.1:18790","auth_mode":"disabled","default_mode":"IdleChat","enabled_modes":["IdleChat","Chat","Games"]}`)
	inputs := []string{
		requestJSON("config_validate", "cfg", `,"candidate_config":`+quote(path)),
		requestJSON("state_describe", "state", ""),
	}
	for _, input := range inputs {
		code, stdout, stderr := execute(input)
		if code != 0 || stderr != "" {
			t.Fatalf("code=%d stderr=%q", code, stderr)
		}
		var raw map[string]any
		decodeOne(t, stdout, &raw)
		if raw["status"] != "completed" || raw["artifact"] != nil || raw["failure"] != nil || len(raw["counts"].(map[string]any)) != 0 {
			t.Fatalf("receipt=%#v", raw)
		}
	}
}

func TestStateDescribeDeclaresNoPortalServerState(t *testing.T) {
	code, stdout, stderr := execute(requestJSON("state_describe", "browser-state", ""))
	if code != 0 || stderr != "" {
		t.Fatalf("code=%d stderr=%q", code, stderr)
	}
	var receipt Receipt
	decodeOne(t, stdout, &receipt)
	if receipt.StateClass != "none" || receipt.SchemaRevision != "none" || receipt.ConsistencyMode != "none" {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func TestInvalidRequestMatrix(t *testing.T) {
	base := `"contract_version":"rencrow-migration-owner-hook-request/v1","owner":"RenCrow_PORTAL","operation":"state_describe","request_id":"req"`
	inputs := []string{
		``,
		`[]`,
		`{` + base + `,"unknown":true}`,
		`{"x":"` + strings.Repeat("x", MaxDocumentBytes) + `"}`,
		`{` + base + `}{}`,
		`{` + base + `} trailing`,
		`{"contract_version":"wrong","owner":"RenCrow_PORTAL","operation":"state_describe","request_id":"req"}`,
		`{"contract_version":"rencrow-migration-owner-hook-request/v1","owner":"RenCrow_CORE","operation":"state_describe","request_id":"req"}`,
		requestJSON("state_describe", "/unsafe/path", ""),
		`{` + base + `,"candidate_config":"x"}`,
		requestJSON("config_validate", "missing-config", ""),
		requestJSON("state_export", "unsupported", ""),
	}
	for _, input := range inputs {
		code, stdout, stderr := execute(input)
		if code != 2 || stdout != "" || stderr == "" {
			t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout, stderr)
		}
	}
}

func TestInvalidAndSymlinkConfigRejectWithoutLeak(t *testing.T) {
	invalid := writeConfig(t, `{"listen":"public.example:18791","core_url":"not-a-url","auth_mode":"tailscale_serve","default_mode":"Chat","enabled_modes":["Chat"]}`)
	link := filepath.Join(t.TempDir(), "private-link.json")
	if err := os.Symlink(invalid, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	for _, path := range []string{invalid, link} {
		code, stdout, stderr := execute(requestJSON("config_validate", "reject", `,"candidate_config":`+quote(path)))
		if code != 10 {
			t.Fatalf("code=%d stdout=%q stderr=%q", code, stdout, stderr)
		}
		var raw map[string]any
		decodeOne(t, stdout, &raw)
		failure := raw["failure"].(map[string]any)
		if failure["code"] != "config_invalid" || failure["boundary"] != "candidate_config" || raw["artifact"] != nil || len(raw["counts"].(map[string]any)) != 0 {
			t.Fatalf("receipt=%#v", raw)
		}
		if strings.Contains(stdout+stderr, path) || strings.Contains(stdout+stderr, "private") || strings.Contains(stdout+stderr, "not-a-url") {
			t.Fatalf("sensitive detail leak: %q", stdout+stderr)
		}
	}
}

func TestWriterFailureReturns30(t *testing.T) {
	var stderr bytes.Buffer
	code := Execute(strings.NewReader(requestJSON("state_describe", "write", "")), failingWriter{}, &stderr)
	if code != 30 || stderr.Len() == 0 {
		t.Fatalf("code=%d stderr=%q", code, stderr.String())
	}
}

func execute(input string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := Execute(strings.NewReader(input), &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func requestJSON(operation, id, extra string) string {
	return `{"contract_version":"rencrow-migration-owner-hook-request/v1","owner":"RenCrow_PORTAL","operation":"` + operation + `","request_id":"` + id + `"` + extra + `}`
}

func quote(value string) string { data, _ := json.Marshal(value); return string(data) }

func decodeOne(t *testing.T, value string, target any) {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(value))
	if err := decoder.Decode(target); err != nil {
		t.Fatal(err)
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		t.Fatalf("multiple receipts: %q", value)
	}
	if len(value) > MaxDocumentBytes {
		t.Fatalf("receipt too large")
	}
}

func writeConfig(t *testing.T, value string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "portal.json")
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, os.ErrClosed }
