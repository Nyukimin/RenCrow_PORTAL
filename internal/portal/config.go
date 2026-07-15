package portal

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

// ModeはPORTALが公開する利用者向け画面種別を表す。
type Mode string

const (
	ModeView Mode = "view"
	ModeLab  Mode = "lab"
)

// ConfigはPORTALプロセスの設定を表す。
type Config struct {
	Listen       string `json:"listen"`
	CoreURL      string `json:"core_url"`
	DefaultMode  Mode   `json:"default_mode"`
	EnabledModes []Mode `json:"enabled_modes"`
}

// DefaultConfigは外部へ意図せず公開しない安全な既定値を返す。
func DefaultConfig() Config {
	return Config{
		Listen:       "127.0.0.1:18791",
		CoreURL:      "http://127.0.0.1:18790",
		DefaultMode:  ModeView,
		EnabledModes: []Mode{ModeView, ModeLab},
	}
}

// LoadConfigは任意のJSON設定を読み、環境変数による上書きを適用する。
func LoadConfig(path string) (Config, error) {
	cfg := DefaultConfig()
	if strings.TrimSpace(path) != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return Config{}, fmt.Errorf("設定ファイルを読む: %w", err)
		}
		dec := json.NewDecoder(strings.NewReader(string(data)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&cfg); err != nil {
			return Config{}, fmt.Errorf("設定ファイルを解析する: %w", err)
		}
	}
	if value := strings.TrimSpace(os.Getenv("RENCROW_PORTAL_LISTEN")); value != "" {
		cfg.Listen = value
	}
	if value := strings.TrimSpace(os.Getenv("RENCROW_CORE_URL")); value != "" {
		cfg.CoreURL = value
	}
	if value := strings.TrimSpace(os.Getenv("RENCROW_PORTAL_DEFAULT_MODE")); value != "" {
		cfg.DefaultMode = Mode(strings.ToLower(value))
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validateは待受先、CORE URL、公開モードを検証する。
func (c Config) Validate() error {
	if strings.TrimSpace(c.Listen) == "" {
		return fmt.Errorf("listenは必須です")
	}
	if _, _, err := net.SplitHostPort(c.Listen); err != nil {
		return fmt.Errorf("listenが不正です: %w", err)
	}
	coreURL, err := url.Parse(strings.TrimSpace(c.CoreURL))
	if err != nil || (coreURL.Scheme != "http" && coreURL.Scheme != "https") || coreURL.Host == "" || coreURL.User != nil {
		return fmt.Errorf("core_urlはuserinfoを含まないhttpまたはhttps URLで指定してください")
	}
	if len(c.EnabledModes) == 0 {
		return fmt.Errorf("enabled_modesは1件以上必要です")
	}
	enabled := map[Mode]bool{}
	for _, mode := range c.EnabledModes {
		if mode != ModeView && mode != ModeLab {
			return fmt.Errorf("未対応のmodeです: %s", mode)
		}
		enabled[mode] = true
	}
	if !enabled[c.DefaultMode] {
		return fmt.Errorf("default_modeはenabled_modesに含めてください")
	}
	return nil
}

func (c Config) modeEnabled(mode Mode) bool {
	for _, enabled := range c.EnabledModes {
		if enabled == mode {
			return true
		}
	}
	return false
}
