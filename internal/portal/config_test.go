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
	if cfg.DefaultMode != Mode("idlechat") {
		t.Fatalf("DefaultMode = %q", cfg.DefaultMode)
	}
	if !cfg.modeEnabled(Mode("chat")) {
		t.Fatal("Chat mode should be enabled by default")
	}
	if !cfg.modeEnabled(ModeIdleChat) {
		t.Fatal("IdleChat mode should be enabled by default")
	}
}

func TestLoadConfigReadsJSONAndValidatesModes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "portal.json")
	data := []byte(`{"listen":"0.0.0.0:19091","core_url":"http://127.0.0.1:19090","default_mode":"Chat","enabled_modes":["IdleChat","Chat"]}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.Listen != "0.0.0.0:19091" || cfg.CoreURL != "http://127.0.0.1:19090" || cfg.DefaultMode != Mode("chat") {
		t.Fatalf("unexpected config: %+v", cfg)
	}
}

func TestLoadConfigNormalizesCanonicalModeNames(t *testing.T) {
	tests := []struct {
		name        string
		defaultMode string
		want        Mode
	}{
		{name: "IdleChat", defaultMode: "IdleChat", want: ModeIdleChat},
		{name: "Chat", defaultMode: "Chat", want: Mode("chat")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "portal.json")
			data := []byte(`{"listen":"127.0.0.1:18791","core_url":"http://127.0.0.1:18790","default_mode":"` + test.defaultMode + `","enabled_modes":["IdleChat","Chat"]}`)
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := LoadConfig(path)
			if err != nil {
				t.Fatalf("LoadConfig() error = %v", err)
			}
			if cfg.DefaultMode != test.want {
				t.Fatalf("DefaultMode = %q, want %q", cfg.DefaultMode, test.want)
			}
			if !cfg.modeEnabled(test.want) {
				t.Fatalf("%s mode should be enabled", test.want)
			}
		})
	}
}

func TestConfigRejectsLegacyAndUnsupportedModes(t *testing.T) {
	for _, mode := range []Mode{"view", "live", "lab", "debug"} {
		cfg := DefaultConfig()
		cfg.EnabledModes = []Mode{mode}
		if err := cfg.Validate(); err == nil {
			t.Fatalf("Validate() should reject %q mode", mode)
		}
	}
}
