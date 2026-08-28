package verify

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestManifestV3RequiresOwnerSelfCollectAcquisition(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	data := []byte(`{"schema_version":3,"purpose":"operational_status","phase":"runtime","checks":[{"check_id":"portal_readiness","guarantee_id":"guarantee-portal-readiness","owner":"RenCrow_PORTAL","purpose":"fixture","target":"portal:/health/ready","phase":"runtime","consumer":"fixture","failure_action":"blocked","cost":"low","safety_gate":false,"coverage":["readiness"],"executor":{"kind":"owner_cli","command_id":"portal-readiness","acquisition":{"mode":"owner_self_collect","verification_safe":false,"inputs":[{"id":"health_route","class":"discoverable","required":true,"source":"owner_operations_api"}]}},"receipt_schema":"rencrow.check-receipt.v1"}]}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	manifest, err := readOwnerManifest(path)
	if err != nil {
		t.Fatalf("read v3 manifest: %v", err)
	}
	acquisition := manifest.Checks[0].Executor.Acquisition
	if acquisition.Mode != "owner_self_collect" || acquisition.VerificationSafe == nil || *acquisition.VerificationSafe {
		t.Fatalf("acquisition=%+v", acquisition)
	}
}

func TestManifestV3AcquisitionRejectsMalformedInputs(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "legacy-schema", mutate: func(document map[string]any) { document["schema_version"] = 2 }},
		{name: "missing-acquisition", mutate: func(document map[string]any) {
			check := document["checks"].([]any)[0].(map[string]any)
			check["executor"].(map[string]any)["acquisition"] = nil
		}},
		{name: "wrong-mode", mutate: func(document map[string]any) {
			acquisition := document["checks"].([]any)[0].(map[string]any)["executor"].(map[string]any)["acquisition"].(map[string]any)
			acquisition["mode"] = "external_runner"
		}},
		{name: "invalid-class", mutate: func(document map[string]any) {
			input := document["checks"].([]any)[0].(map[string]any)["executor"].(map[string]any)["acquisition"].(map[string]any)["inputs"].([]any)[0].(map[string]any)
			input["class"] = "secret"
		}},
		{name: "invalid-source", mutate: func(document map[string]any) {
			input := document["checks"].([]any)[0].(map[string]any)["executor"].(map[string]any)["acquisition"].(map[string]any)["inputs"].([]any)[0].(map[string]any)
			input["source"] = "arbitrary_shell"
		}},
		{name: "duplicate-input-id", mutate: func(document map[string]any) {
			acquisition := document["checks"].([]any)[0].(map[string]any)["executor"].(map[string]any)["acquisition"].(map[string]any)
			inputs := acquisition["inputs"].([]any)
			acquisition["inputs"] = append(inputs, inputs[0])
		}},
		{name: "unsafe-verification-without-gate", mutate: func(document map[string]any) {
			check := document["checks"].([]any)[0].(map[string]any)
			check["executor"].(map[string]any)["acquisition"].(map[string]any)["verification_safe"] = true
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			data, err := os.ReadFile(writeManifest(t, "portal_readiness", "portal-readiness"))
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(data, &document); err != nil {
				t.Fatal(err)
			}
			tc.mutate(document)
			path := filepath.Join(t.TempDir(), "runtime.json")
			writeJSON(t, path, document)
			if _, err := readOwnerManifest(path); err == nil {
				t.Fatalf("readOwnerManifest unexpectedly accepted %s", tc.name)
			}
		})
	}
}

func TestCurrentManifestMatchesFixedCommandAllowlistBothDirections(t *testing.T) {
	manifestPath := filepath.Join("..", "..", "config", "checks", "runtime.json")
	manifest, err := readOwnerManifest(manifestPath)
	if err != nil {
		t.Fatalf("read current PORTAL manifest: %v", err)
	}

	manifestByCheck := make(map[string]string, len(manifest.Checks))
	manifestByCommand := make(map[string]string, len(manifest.Checks))
	for _, check := range manifest.Checks {
		manifestByCheck[check.CheckID] = check.Executor.CommandID
		manifestByCommand[check.Executor.CommandID] = check.CheckID
		if check.Executor.Acquisition == nil || check.Executor.Acquisition.VerificationSafe == nil {
			t.Fatalf("check %q lacks v3 acquisition contract", check.CheckID)
		}
		wantSafe := check.CheckID == "portal_browser_proxy_e2e" || check.CheckID == "portal_canonical_actor_e2e"
		wantGate := wantSafe || check.CheckID == "portal_runtime_identity_lifecycle_security"
		if *check.Executor.Acquisition.VerificationSafe != wantSafe || check.SafetyGate != wantGate {
			t.Fatalf("check %q verification_safe=%v safety_gate=%v, want verification_safe=%v safety_gate=%v", check.CheckID, *check.Executor.Acquisition.VerificationSafe, check.SafetyGate, wantSafe, wantGate)
		}
	}

	if len(manifestByCheck) != len(commandForCheck) {
		t.Fatalf("manifest checks=%d, fixed allowlist checks=%d", len(manifestByCheck), len(commandForCheck))
	}
	if len(manifestByCommand) != len(commandForCheck) {
		t.Fatalf("manifest command_ids=%d, fixed allowlist checks=%d", len(manifestByCommand), len(commandForCheck))
	}

	// Every fixed check must be present in the actual manifest with the same
	// command, so adding a handler without declaring it is also detected.
	for checkID, wantCommand := range commandForCheck {
		gotCommand, ok := manifestByCheck[checkID]
		if !ok {
			t.Errorf("fixed allowlist check %q is missing from manifest", checkID)
			continue
		}
		if gotCommand != wantCommand {
			t.Errorf("check %q command=%q, want %q", checkID, gotCommand, wantCommand)
		}
	}

	// Every manifest check must be fixed-allowlisted; unknown declarations are
	// not allowed even when the fixed map happens to have the same size.
	for checkID, gotCommand := range manifestByCheck {
		wantCommand, ok := commandForCheck[checkID]
		if !ok {
			t.Errorf("manifest check %q is not in the fixed allowlist", checkID)
			continue
		}
		if gotCommand != wantCommand {
			t.Errorf("manifest check %q command=%q, want %q", checkID, gotCommand, wantCommand)
		}
	}

	allowlistByCommand := make(map[string]string, len(commandForCheck))
	for checkID, commandID := range commandForCheck {
		allowlistByCommand[commandID] = checkID
	}
	for commandID, wantCheckID := range allowlistByCommand {
		gotCheckID, ok := manifestByCommand[commandID]
		if !ok {
			t.Errorf("fixed allowlist command_id %q is missing from manifest", commandID)
			continue
		}
		if gotCheckID != wantCheckID {
			t.Errorf("command_id %q maps to check %q, want %q", commandID, gotCheckID, wantCheckID)
		}
	}
	for commandID, gotCheckID := range manifestByCommand {
		wantCheckID, ok := allowlistByCommand[commandID]
		if !ok {
			t.Errorf("manifest command_id %q is not in the fixed allowlist", commandID)
			continue
		}
		if gotCheckID != wantCheckID {
			t.Errorf("manifest command_id %q maps to check %q, want %q", commandID, gotCheckID, wantCheckID)
		}
	}
}
