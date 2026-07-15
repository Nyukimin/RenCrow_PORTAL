package portal

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigUsesSafeDefaults(t *testing.T) {
	cfg, err := LoadConfig("")
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.Listen != "127.0.0.1:18791" {
		t.Fatalf("Listen = %q", cfg.Listen)
	}
	if cfg.CoreURL != "http://127.0.0.1:18790" {
		t.Fatalf("CoreURL = %q", cfg.CoreURL)
	}
	if cfg.DefaultMode != ModeView {
		t.Fatalf("DefaultMode = %q", cfg.DefaultMode)
	}
}

func TestLoadConfigReadsJSONAndValidatesModes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "portal.json")
	data := []byte(`{"listen":"0.0.0.0:19091","core_url":"http://127.0.0.1:19090","default_mode":"lab","enabled_modes":["view","lab"]}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.Listen != "0.0.0.0:19091" || cfg.CoreURL != "http://127.0.0.1:19090" || cfg.DefaultMode != ModeLab {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestConfigRejectsUnsupportedMode(t *testing.T) {
	cfg := DefaultConfig()
	cfg.EnabledModes = []Mode{"debug"}
	if err := cfg.Validate(); err == nil {
		t.Fatal("Validate() should reject debug mode")
	}
}
