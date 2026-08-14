package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPortalServiceUsesCanonicalRuntimeConfig(t *testing.T) {
	path := filepath.Join("..", "..", "systemd", "user", "rencrow-portal.service")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	unit := string(data)
	if !strings.Contains(unit, "--config %h/.rencrow/config/portal.json") {
		t.Fatalf("canonical config path missing:\n%s", unit)
	}
	for _, legacy := range []string{"RENCROW_PORTAL_LISTEN", "RENCROW_CORE_URL", ".config/rencrow"} {
		if strings.Contains(unit, legacy) {
			t.Fatalf("unit contains duplicated or legacy setting %q:\n%s", legacy, unit)
		}
	}
}
