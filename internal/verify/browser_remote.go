package verify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const remoteBrowserConfigRelative = ".config/rencrow/portal/browser-verifier.json"

var remoteBrowserUserPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

type remoteBrowserConfig struct {
	Host             string `json:"host"`
	User             string `json:"user"`
	IdentityFile     string `json:"identity_file"`
	VerifierPath     string `json:"verifier_path"`
	ManifestPath     string `json:"manifest_path"`
	EvidenceDir      string `json:"evidence_dir"`
	BrowserDirectory string `json:"browser_directory"`
	PortalURL        string `json:"portal_url"`
}

func collectRemoteBrowserEvidence(ctx context.Context, observedAt time.Time, checkID string) (map[string]any, error) {
	config, err := loadRemoteBrowserConfig()
	if err != nil {
		return nil, fmt.Errorf("external_untagged_browser_prerequisite_absent: %w", err)
	}
	if checkID != "portal_browser_proxy_e2e" && checkID != "portal_canonical_actor_e2e" {
		return nil, errors.New("remote browser check is not allowlisted")
	}
	ssh, err := exec.LookPath("ssh")
	if err != nil {
		return nil, errors.New("remote browser SSH client prerequisite is unavailable")
	}
	target := config.User + "@" + config.Host
	remoteCommand := fmt.Sprintf(
		`cmd.exe /d /c "set "PATH=%%PATH%%;%s"&& %s run --manifest %s --check-id %s --observed-at %s --evidence-dir %s --portal-url %s"`,
		config.BrowserDirectory, config.VerifierPath, config.ManifestPath, checkID,
		observedAt.UTC().Format(time.RFC3339Nano), config.EvidenceDir, config.PortalURL,
	)
	output, err := exec.CommandContext(ctx, ssh,
		"-i", config.IdentityFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
		"-o", "ConnectTimeout=8", target, remoteCommand,
	).Output()
	if err != nil {
		return nil, fmt.Errorf("remote browser verifier failed: %w", err)
	}
	var receipt Receipt
	if err := json.Unmarshal(output, &receipt); err != nil {
		return nil, fmt.Errorf("decode remote browser receipt: %w", err)
	}
	if receipt.CheckID != checkID || receipt.Status != StatusPassed || len(receipt.EvidenceRefs) != 1 {
		return nil, fmt.Errorf("remote browser verifier returned %s: %s", receipt.Status, receipt.FailureBoundary)
	}
	const relativePrefix = "relative:"
	if !strings.HasPrefix(receipt.EvidenceRefs[0], relativePrefix) {
		return nil, errors.New("remote browser receipt did not return a relative Evidence reference")
	}
	name := strings.TrimPrefix(receipt.EvidenceRefs[0], relativePrefix)
	if name == "" || filepath.Base(name) != name || !strings.HasSuffix(name, ".json") {
		return nil, errors.New("remote browser Evidence reference is invalid")
	}
	evidencePath := strings.TrimRight(config.EvidenceDir, `\/`) + `\` + name
	evidenceOutput, err := exec.CommandContext(ctx, ssh,
		"-i", config.IdentityFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
		"-o", "ConnectTimeout=8", target, "cmd.exe /d /c type "+evidencePath,
	).Output()
	if err != nil {
		return nil, fmt.Errorf("read remote browser Evidence: %w", err)
	}
	var evidence map[string]any
	if err := json.Unmarshal(evidenceOutput, &evidence); err != nil {
		return nil, fmt.Errorf("decode remote browser Evidence: %w", err)
	}
	return evidence, nil
}

func loadRemoteBrowserConfig() (remoteBrowserConfig, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return remoteBrowserConfig{}, errors.New("owner home is unavailable")
	}
	path := filepath.Join(home, filepath.FromSlash(remoteBrowserConfigRelative))
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o077 != 0 {
		return remoteBrowserConfig{}, errors.New("owner remote-browser config is missing or not owner-only")
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 32<<10 {
		return remoteBrowserConfig{}, errors.New("owner remote-browser config is unreadable or unbounded")
	}
	var config remoteBrowserConfig
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return remoteBrowserConfig{}, fmt.Errorf("decode owner remote-browser config: %w", err)
	}
	if err := validateRemoteBrowserConfig(config); err != nil {
		return remoteBrowserConfig{}, err
	}
	return config, nil
}

func validateRemoteBrowserConfig(config remoteBrowserConfig) error {
	ip := net.ParseIP(strings.TrimSpace(config.Host))
	if ip == nil || !ip.IsPrivate() || ip.IsLoopback() {
		return errors.New("remote browser host must be a private non-loopback IP")
	}
	if !remoteBrowserUserPattern.MatchString(config.User) {
		return errors.New("remote browser user is invalid")
	}
	identityInfo, err := os.Lstat(config.IdentityFile)
	if err != nil || !identityInfo.Mode().IsRegular() || identityInfo.Mode()&0o077 != 0 || !filepath.IsAbs(config.IdentityFile) {
		return errors.New("remote browser identity reference is invalid or not owner-only")
	}
	for name, value := range map[string]string{
		"verifier_path": config.VerifierPath, "manifest_path": config.ManifestPath,
		"evidence_dir": config.EvidenceDir, "browser_directory": config.BrowserDirectory,
	} {
		value = strings.TrimSpace(value)
		if value == "" || strings.ContainsAny(value, "\"&|<>\r\n") {
			return fmt.Errorf("remote browser %s is invalid", name)
		}
	}
	portalURL, err := validatePortalURL(config.PortalURL)
	if err != nil || portalURL.Scheme != "https" || !strings.HasSuffix(strings.ToLower(portalURL.Hostname()), ".ts.net") {
		return errors.New("remote browser portal_url must be an HTTPS Tailscale origin")
	}
	return nil
}
