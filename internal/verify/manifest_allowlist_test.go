package verify

import (
	"path/filepath"
	"testing"
)

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
