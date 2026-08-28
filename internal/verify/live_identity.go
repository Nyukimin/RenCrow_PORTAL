package verify

import (
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"time"
)

var portalFullRevision = regexp.MustCompile(`^[0-9a-f]{40}$`)

const maxPortalArtifact = 128 << 20

func discoverPortalDeployIdentity(observedAt time.Time) (Observation, error) {
	catalogPath, err := findPortalCatalog()
	if err != nil {
		return blockedObservation(deployTarget, err), nil
	}
	workspacePath, pin, err := loadPortalCatalogIdentity(catalogPath)
	if err != nil {
		return blockedObservation(deployTarget, err), nil
	}
	workspace := filepath.Clean(filepath.Join(filepath.Dir(catalogPath), workspacePath))
	revision, err := portalGitOutput(workspace, "rev-parse", "HEAD")
	if err != nil || !portalFullRevision.MatchString(revision) {
		return blockedObservation(deployTarget, errors.New("Portal source revision unavailable")), nil
	}
	dirty, err := portalGitOutput(workspace, "status", "--porcelain=v1")
	if err != nil {
		return blockedObservation(deployTarget, errors.New("Portal source cleanliness unavailable")), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return blockedObservation(deployTarget, err), nil
	}
	installed := filepath.Join(home, ".local", "bin", "rencrow-portal")
	build, err := buildinfo.ReadFile(installed)
	if err != nil {
		return blockedObservation(deployTarget, errors.New("installed Portal build stamp unavailable")), nil
	}
	installedRevision := portalBuildSetting(build, "vcs.revision")
	installedDirty := portalBuildSetting(build, "vcs.modified") != "false"
	digest, err := digestPortalArtifact(installed)
	if err != nil {
		return blockedObservation(deployTarget, err), nil
	}
	evidence := map[string]any{
		"observed_at": observedAt.Format(time.RFC3339Nano), "catalog_pin": pin,
		"source_revision": revision, "source_clean": dirty == "",
		"installed_revision": installedRevision, "installed_clean": !installedDirty,
		"installed_sha256": digest,
	}
	if pin != revision || pin != installedRevision {
		return Observation{Status: StatusFailed, RouteOrTarget: deployTarget, FailureBoundary: "Portal source, catalog, and installed revisions do not match", Evidence: evidence}, nil
	}
	if dirty != "" || installedDirty {
		return Observation{Status: StatusFailed, RouteOrTarget: deployTarget, FailureBoundary: "Portal source or installed artifact is dirty", Evidence: evidence}, nil
	}
	return Observation{Status: StatusPassed, RouteOrTarget: deployTarget, Evidence: evidence}, nil
}

func findPortalCatalog() (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(directory, "ecosystem.yaml")
		if info, statErr := os.Lstat(candidate); statErr == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
			return candidate, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", errors.New("ecosystem catalog not found")
		}
		directory = parent
	}
}

func loadPortalCatalogIdentity(path string) (string, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer file.Close()
	var catalog struct {
		Components map[string]struct {
			Repository    string `json:"repository"`
			WorkspacePath string `json:"workspace_path"`
			Version       string `json:"version"`
		} `json:"components"`
	}
	if err := json.NewDecoder(io.LimitReader(file, maxManifestBytes+1)).Decode(&catalog); err != nil {
		return "", "", err
	}
	component, ok := catalog.Components["portal"]
	if !ok || component.Repository != "Nyukimin/RenCrow_PORTAL" || strings.TrimSpace(component.WorkspacePath) == "" || !portalFullRevision.MatchString(component.Version) {
		return "", "", errors.New("Portal catalog identity invalid")
	}
	return component.WorkspacePath, component.Version, nil
}

func portalGitOutput(workspace string, args ...string) (string, error) {
	output, err := exec.Command("git", append([]string{"-C", workspace}, args...)...).Output()
	return strings.TrimSpace(string(output)), err
}
func portalBuildSetting(info *debug.BuildInfo, key string) string {
	for _, setting := range info.Settings {
		if setting.Key == key {
			return strings.TrimSpace(setting.Value)
		}
	}
	return ""
}
func digestPortalArtifact(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > maxPortalArtifact {
		return "", errors.New("installed Portal artifact is not a bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(hash, file)
	if err != nil || count != info.Size() {
		return "", errors.New("installed Portal artifact changed while hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
