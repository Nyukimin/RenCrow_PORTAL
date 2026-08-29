package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestMigrationDispatchAndLegacyFlags(t *testing.T) {
	request := `{"contract_version":"rencrow-migration-owner-hook-request/v1","owner":"RenCrow_PORTAL","operation":"state_describe","request_id":"dispatch"}`
	var stdout, stderr bytes.Buffer
	handled, code := runMigrationCommand([]string{"migration-hook"}, strings.NewReader(request), &stdout, &stderr)
	if !handled || code != 0 || stderr.Len() != 0 || !strings.Contains(stdout.String(), `"state_class":"none"`) {
		t.Fatalf("handled=%v code=%d stdout=%q stderr=%q", handled, code, stdout.String(), stderr.String())
	}
	handled, _ = runMigrationCommand([]string{"-config", "portal.json"}, strings.NewReader(""), &stdout, &stderr)
	if handled {
		t.Fatal("legacy -config must remain on the server flag path")
	}
}

func TestMigrationDispatchRejectsExtraArgs(t *testing.T) {
	var stdout, stderr bytes.Buffer
	handled, code := runMigrationCommand([]string{"migration-hook", "extra"}, strings.NewReader(`{}`), &stdout, &stderr)
	if !handled || code != 2 || stdout.Len() != 0 || stderr.Len() == 0 {
		t.Fatalf("handled=%v code=%d stdout=%q stderr=%q", handled, code, stdout.String(), stderr.String())
	}
}
