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
	if cfg.AuthMode != AuthModeDisabled {
		t.Fatalf("AuthMode = %q, want %q", cfg.AuthMode, AuthModeDisabled)
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
	if !cfg.modeEnabled(ModeGames) {
		t.Fatal("Games mode should be enabled by default")
	}
}

func TestLoadConfigReadsTailscaleServeAuthMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "portal.json")
	data := []byte(`{"listen":"127.0.0.1:18791","core_url":"http://127.0.0.1:18790","auth_mode":"tailscale_serve","default_mode":"IdleChat","enabled_modes":["IdleChat","Chat","Games"]}`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.AuthMode != AuthModeTailscaleServe {
		t.Fatalf("AuthMode = %q, want %q", cfg.AuthMode, AuthModeTailscaleServe)
	}
}

func TestConfigTailscaleServeRequiresLoopbackListen(t *testing.T) {
	for _, listen := range []string{"0.0.0.0:18791", "[::]:18791", "localhost:18791"} {
		cfg := DefaultConfig()
		cfg.AuthMode = AuthModeTailscaleServe
		cfg.Listen = listen
		if err := cfg.Validate(); err == nil {
			t.Fatalf("Validate() should reject non-loopback listen %q", listen)
		}
	}

	for _, listen := range []string{"127.0.0.1:18791", "[::1]:18791"} {
		cfg := DefaultConfig()
		cfg.AuthMode = AuthModeTailscaleServe
		cfg.Listen = listen
		if err := cfg.Validate(); err != nil {
			t.Fatalf("Validate() rejected loopback listen %q: %v", listen, err)
		}
	}
}

func TestConfigRejectsUnsupportedAuthModes(t *testing.T) {
	for _, mode := range []AuthMode{"", "basic", "tailscale"} {
		cfg := DefaultConfig()
		cfg.AuthMode = mode
		if err := cfg.Validate(); err == nil {
			t.Fatalf("Validate() should reject auth mode %q", mode)
		}
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
		{name: "Games", defaultMode: "Games", want: ModeGames},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "portal.json")
			data := []byte(`{"listen":"127.0.0.1:18791","core_url":"http://127.0.0.1:18790","default_mode":"` + test.defaultMode + `","enabled_modes":["IdleChat","Chat","Games"]}`)
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

func TestConfigRejectsUnsupportedModes(t *testing.T) {
	for _, mode := range []Mode{"unsupported", "debug"} {
		cfg := DefaultConfig()
		cfg.EnabledModes = []Mode{mode}
		if err := cfg.Validate(); err == nil {
			t.Fatalf("Validate() should reject %q mode", mode)
		}
	}
}
