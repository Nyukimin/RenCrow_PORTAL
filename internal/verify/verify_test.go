package verify

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testObservedAt = "2026-08-27T00:00:01Z"

func TestRunReadinessUsesPublishedPortalRoute(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"status":"ready","service":"rencrow-portal"}`))
	}))
	defer server.Close()

	dir := t.TempDir()
	receipt, err := Run(context.Background(), Options{
		ManifestPath: writeManifest(t, `portal_readiness`, `portal-readiness`),
		CheckID:      "portal_readiness",
		ObservedAt:   testObservedAt,
		EvidenceDir:  dir,
		PortalURL:    server.URL,
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusPassed || requestedPath != "/health/ready" {
		t.Fatalf("receipt=%+v path=%q", receipt, requestedPath)
	}
	if len(receipt.EvidenceRefs) != 1 {
		t.Fatalf("evidence refs = %v", receipt.EvidenceRefs)
	}
	assertEvidenceRefsExist(t, dir, receipt.EvidenceRefs)
}

func TestRunReadinessUnavailableIsBlocked(t *testing.T) {
	dir := t.TempDir()
	receipt, err := Run(context.Background(), Options{
		ManifestPath: writeManifest(t, `portal_readiness`, `portal-readiness`),
		CheckID:      "portal_readiness",
		ObservedAt:   testObservedAt,
		EvidenceDir:  dir,
		PortalURL:    "http://127.0.0.1:1",
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusBlocked || receipt.FailureBoundary == "" {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func TestRunValidatesEveryManifestExecutorBeforeExecution(t *testing.T) {
	path := writeManifest(t, `portal_readiness`, `portal-readiness`)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	checks := manifest["checks"].([]any)
	checks = append(checks, map[string]any{
		"check_id":       "portal_readiness_extra",
		"guarantee_id":   "extra",
		"owner":          Owner,
		"purpose":        "extra",
		"target":         "extra",
		"phase":          "runtime",
		"consumer":       "extra",
		"failure_action": "blocked",
		"cost":           "low",
		"safety_gate":    false,
		"coverage":       []string{"readiness"},
		"executor":       map[string]any{"kind": "owner_cli", "command_id": "not-implemented"},
		"receipt_schema": ReceiptSchema,
	})
	manifest["checks"] = checks
	bad, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = Run(context.Background(), Options{
		ManifestPath: path,
		CheckID:      "portal_readiness",
		ObservedAt:   testObservedAt,
		EvidenceDir:  t.TempDir(),
		Observers: Observers{Readiness: func(context.Context, ReadinessInput) (Observation, error) {
			t.Fatal("observer must not run for invalid manifest")
			return Observation{}, nil
		}},
	})
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("error=%v, want CLIError", err)
	}
}

func TestRunBrowserProxyRequiresExplicitAuthAndBrowserEvidence(t *testing.T) {
	receipt, err := Run(context.Background(), Options{
		ManifestPath: writeManifest(t, `portal_browser_proxy_e2e`, `portal-browser-proxy-e2e`),
		CheckID:      "portal_browser_proxy_e2e",
		ObservedAt:   testObservedAt,
		EvidenceDir:  t.TempDir(),
		PortalURL:    "https://portal.example.test",
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusBlocked {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func TestRunBrowserProxyRequiresPortalAllowlistedRoute(t *testing.T) {
	dir := t.TempDir()
	evidencePath := filepath.Join(dir, "browser.json")
	writeJSON(t, evidencePath, map[string]any{
		"observed_at": testObservedAt,
		"browser":     "Firefox", "platform": "Linux", "authenticated": true, "auth_method": "bearer",
		"portal_url": "https://portal.example.test", "request": map[string]any{
			"method": "POST", "url": "https://core.example.test/viewer/send",
		},
		"response": map[string]any{"status": 200, "job_id": "job-1", "text": "こんにちは"},
	})
	receipt, err := Run(context.Background(), Options{
		ManifestPath:    writeManifest(t, `portal_browser_proxy_e2e`, `portal-browser-proxy-e2e`),
		CheckID:         "portal_browser_proxy_e2e",
		ObservedAt:      testObservedAt,
		EvidenceDir:     dir,
		PortalURL:       "https://portal.example.test",
		BrowserEvidence: evidencePath,
		Auth:            Auth{HeaderName: "Authorization", HeaderValue: "Bearer test-only"},
		BrowserRunner:   "playwright-firefox",
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusBlocked {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func TestRunBrowserProxyEvidenceFreshnessWindow(t *testing.T) {
	requested, err := time.Parse(time.RFC3339Nano, testObservedAt)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name       string
		evidenceAt time.Time
		status     string
	}{
		{name: "lower-bound-inclusive", evidenceAt: requested.Add(-5 * time.Minute), status: StatusPassed},
		{name: "requested-inclusive", evidenceAt: requested, status: StatusPassed},
		{name: "stale", evidenceAt: requested.Add(-5*time.Minute - time.Nanosecond), status: StatusBlocked},
		{name: "future", evidenceAt: requested.Add(time.Nanosecond), status: StatusBlocked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			evidencePath := filepath.Join(dir, "browser.json")
			writeJSON(t, evidencePath, map[string]any{
				"observed_at": tc.evidenceAt.Format(time.RFC3339Nano),
				"browser":     "Firefox", "platform": "Linux", "authenticated": true, "auth_method": "bearer",
				"portal_url": "https://portal.example.test", "request": map[string]any{
					"method": "POST", "url": "https://portal.example.test/api/chat/viewer/send",
				},
				"response":     map[string]any{"status": 200, "job_id": "job-1", "text": "応答"},
				"visible_text": "応答",
			})
			receipt, runErr := Run(context.Background(), Options{
				ManifestPath:    writeManifest(t, `portal_browser_proxy_e2e`, `portal-browser-proxy-e2e`),
				CheckID:         "portal_browser_proxy_e2e",
				ObservedAt:      testObservedAt,
				EvidenceDir:     dir,
				PortalURL:       "https://portal.example.test",
				BrowserEvidence: evidencePath,
				Auth:            Auth{HeaderName: "Authorization", HeaderValue: "Bearer test-only"},
				BrowserRunner:   "playwright-firefox",
			})
			if runErr != nil {
				t.Fatal(runErr)
			}
			if receipt.Status != tc.status {
				t.Fatalf("status=%q receipt=%+v", receipt.Status, receipt)
			}
		})
	}
}

func TestRunCanonicalActorBrowserE2ERequiresRealActorAndTrace(t *testing.T) {
	dir := t.TempDir()
	evidencePath := filepath.Join(dir, "browser.json")
	writeJSON(t, evidencePath, map[string]any{
		"observed_at": testObservedAt,
		"browser":     "Firefox", "platform": "Linux", "authenticated": true, "auth_method": "bearer",
		"portal_url": "https://portal.example.test", "actor": "viewer-user",
		"request":      map[string]any{"method": "POST", "url": "https://portal.example.test/api/chat/viewer/send"},
		"core_path":    "/viewer/send",
		"response":     map[string]any{"status": 200, "job_id": "job-1", "trace_id": "trace-1", "text": "応答"},
		"visible_text": "応答",
	})
	receipt, err := Run(context.Background(), Options{
		ManifestPath:    writeManifest(t, `portal_canonical_actor_e2e`, `portal-canonical-actor-e2e`),
		CheckID:         "portal_canonical_actor_e2e",
		ObservedAt:      testObservedAt,
		EvidenceDir:     dir,
		PortalURL:       "https://portal.example.test",
		BrowserEvidence: evidencePath,
		Auth:            Auth{HeaderName: "Authorization", HeaderValue: "Bearer test-only"},
		BrowserRunner:   "playwright-firefox",
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusPassed || len(receipt.EvidenceRefs) != 1 {
		t.Fatalf("receipt=%+v", receipt)
	}
	assertEvidenceRefsExist(t, dir, receipt.EvidenceRefs)
}

func TestRunCanonicalActorRejectsTestDouble(t *testing.T) {
	dir := t.TempDir()
	evidencePath := filepath.Join(dir, "browser.json")
	writeJSON(t, evidencePath, map[string]any{
		"observed_at": testObservedAt,
		"browser":     "Firefox", "platform": "Linux", "authenticated": true, "auth_method": "bearer",
		"portal_url": "https://portal.example.test", "actor": "dummy-agent",
		"request":      map[string]any{"method": "POST", "url": "https://portal.example.test/api/chat/viewer/send"},
		"response":     map[string]any{"status": 200, "job_id": "job-1", "trace_id": "trace-1", "text": "応答"},
		"visible_text": "応答",
	})
	receipt, err := Run(context.Background(), Options{
		ManifestPath:    writeManifest(t, `portal_canonical_actor_e2e`, `portal-canonical-actor-e2e`),
		CheckID:         "portal_canonical_actor_e2e",
		ObservedAt:      testObservedAt,
		EvidenceDir:     dir,
		PortalURL:       "https://portal.example.test",
		BrowserEvidence: evidencePath,
		Auth:            Auth{HeaderName: "Authorization", HeaderValue: "Bearer test-only"},
		BrowserRunner:   "evidence-input",
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusBlocked || !strings.Contains(receipt.FailureBoundary, "test double") {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func TestRunDeployIdentityChainChecksDigestsAndSourceRevision(t *testing.T) {
	dir := t.TempDir()
	artifactPath := filepath.Join(dir, "artifact.bin")
	publicationPath := filepath.Join(dir, "publication.bin")
	if err := os.WriteFile(artifactPath, []byte("artifact"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(publicationPath, []byte("artifact"), 0o600); err != nil {
		t.Fatal(err)
	}
	requested, err := time.Parse(time.RFC3339Nano, testObservedAt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(artifactPath, requested, requested); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(publicationPath, requested, requested); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "source.json")
	artifact := filepath.Join(dir, "artifact.json")
	publication := filepath.Join(dir, "publication.json")
	writeJSON(t, source, map[string]any{"observed_at": testObservedAt, "revision": "rev-1", "repository": Owner})
	writeJSON(t, artifact, map[string]any{"observed_at": testObservedAt, "source_revision": "rev-1", "path": "artifact.bin"})
	writeJSON(t, publication, map[string]any{"observed_at": testObservedAt, "path": "publication.bin", "published": true})
	receipt, err := Run(context.Background(), Options{
		ManifestPath:        writeManifest(t, `portal_deploy_identity_chain`, `portal-deploy-identity-chain`),
		CheckID:             "portal_deploy_identity_chain",
		ObservedAt:          testObservedAt,
		EvidenceDir:         dir,
		SourceEvidence:      source,
		ArtifactEvidence:    artifact,
		PublicationEvidence: publication,
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusPassed {
		t.Fatalf("receipt=%+v", receipt)
	}
	assertEvidenceRefsExist(t, dir, receipt.EvidenceRefs)
}

func TestLoadPortalCatalogIdentity(t *testing.T) {
	revision := strings.Repeat("a", 40)
	path := filepath.Join(t.TempDir(), "ecosystem.yaml")
	writeJSON(t, path, map[string]any{"components": map[string]any{"portal": map[string]any{"repository": "Nyukimin/RenCrow_PORTAL", "workspace_path": "./RenCrow_PORTAL", "version": revision}}})
	workspace, gotRevision, err := loadPortalCatalogIdentity(path)
	if err != nil || workspace != "./RenCrow_PORTAL" || gotRevision != revision {
		t.Fatalf("identity=(%q,%q,%v)", workspace, gotRevision, err)
	}
}

func TestRunDeployIdentityEvidenceFreshnessWindow(t *testing.T) {
	requested, err := time.Parse(time.RFC3339Nano, testObservedAt)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name       string
		evidenceAt time.Time
		status     string
	}{
		{name: "lower-bound-inclusive", evidenceAt: requested.Add(-5 * time.Minute), status: StatusPassed},
		{name: "requested-inclusive", evidenceAt: requested, status: StatusPassed},
		{name: "stale", evidenceAt: requested.Add(-5*time.Minute - time.Nanosecond), status: StatusBlocked},
		{name: "future", evidenceAt: requested.Add(time.Nanosecond), status: StatusBlocked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			artifactPath := filepath.Join(dir, "artifact.bin")
			publicationPath := filepath.Join(dir, "publication.bin")
			if err := os.WriteFile(artifactPath, []byte("artifact"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(publicationPath, []byte("artifact"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(artifactPath, requested, requested); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(publicationPath, requested, requested); err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(dir, "source.json")
			artifact := filepath.Join(dir, "artifact.json")
			publication := filepath.Join(dir, "publication.json")
			observedAt := tc.evidenceAt.Format(time.RFC3339Nano)
			writeJSON(t, source, map[string]any{"observed_at": observedAt, "revision": "rev-1"})
			writeJSON(t, artifact, map[string]any{"observed_at": observedAt, "source_revision": "rev-1", "path": "artifact.bin"})
			writeJSON(t, publication, map[string]any{"observed_at": observedAt, "path": "publication.bin", "published": true})
			receipt, runErr := Run(context.Background(), Options{
				ManifestPath:        writeManifest(t, `portal_deploy_identity_chain`, `portal-deploy-identity-chain`),
				CheckID:             "portal_deploy_identity_chain",
				ObservedAt:          testObservedAt,
				EvidenceDir:         dir,
				SourceEvidence:      source,
				ArtifactEvidence:    artifact,
				PublicationEvidence: publication,
			})
			if runErr != nil {
				t.Fatal(runErr)
			}
			if receipt.Status != tc.status {
				t.Fatalf("status=%q receipt=%+v", receipt.Status, receipt)
			}
		})
	}
}

func TestRunDeployIdentityArtifactPublicationMtimeFreshness(t *testing.T) {
	requested, err := time.Parse(time.RFC3339Nano, testObservedAt)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name          string
		artifactAt    time.Time
		publicationAt time.Time
		status        string
	}{
		{name: "lower-bound-inclusive", artifactAt: requested.Add(-5 * time.Minute), publicationAt: requested.Add(-5 * time.Minute), status: StatusPassed},
		{name: "requested-inclusive", artifactAt: requested, publicationAt: requested, status: StatusPassed},
		{name: "artifact-stale", artifactAt: requested.Add(-5*time.Minute - time.Second), publicationAt: requested, status: StatusBlocked},
		{name: "publication-future", artifactAt: requested, publicationAt: requested.Add(time.Second), status: StatusBlocked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			artifactPath := filepath.Join(dir, "artifact.bin")
			publicationPath := filepath.Join(dir, "publication.bin")
			if err := os.WriteFile(artifactPath, []byte("artifact"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(publicationPath, []byte("artifact"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(artifactPath, tc.artifactAt, tc.artifactAt); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(publicationPath, tc.publicationAt, tc.publicationAt); err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(dir, "source.json")
			artifact := filepath.Join(dir, "artifact.json")
			publication := filepath.Join(dir, "publication.json")
			writeJSON(t, source, map[string]any{"observed_at": testObservedAt, "revision": "rev-1"})
			writeJSON(t, artifact, map[string]any{"observed_at": testObservedAt, "source_revision": "rev-1", "path": "artifact.bin"})
			writeJSON(t, publication, map[string]any{"observed_at": testObservedAt, "path": "publication.bin", "published": true})
			receipt, runErr := Run(context.Background(), Options{
				ManifestPath:        writeManifest(t, `portal_deploy_identity_chain`, `portal-deploy-identity-chain`),
				CheckID:             "portal_deploy_identity_chain",
				ObservedAt:          testObservedAt,
				EvidenceDir:         dir,
				SourceEvidence:      source,
				ArtifactEvidence:    artifact,
				PublicationEvidence: publication,
			})
			if runErr != nil {
				t.Fatal(runErr)
			}
			if receipt.Status != tc.status {
				t.Fatalf("status=%q receipt=%+v", receipt.Status, receipt)
			}
		})
	}
}

func TestRunRuntimeIdentityRequiresServiceProcessConfigListenerAndSecurity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.json")
	writeJSON(t, path, map[string]any{
		"observed_at": testObservedAt,
		"service":     map[string]any{"name": "rencrow-portal.service", "active": true},
		"pid":         1234,
		"executable":  "/home/test/.local/bin/rencrow-portal",
		"config_path": "/home/test/.rencrow/config/portal.json",
		"listener":    map[string]any{"address": "127.0.0.1:18791", "bound": true},
		"security":    map[string]any{"loopback_only": true},
	})
	receipt, err := Run(context.Background(), Options{
		ManifestPath:    writeManifest(t, `portal_runtime_identity_lifecycle_security`, `portal-runtime-identity-lifecycle-security`),
		CheckID:         "portal_runtime_identity_lifecycle_security",
		ObservedAt:      testObservedAt,
		EvidenceDir:     dir,
		RuntimeEvidence: path,
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusPassed {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func TestRunRuntimeIdentityEvidenceFreshnessWindow(t *testing.T) {
	requested, err := time.Parse(time.RFC3339Nano, testObservedAt)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name       string
		evidenceAt time.Time
		status     string
	}{
		{name: "lower-bound-inclusive", evidenceAt: requested.Add(-5 * time.Minute), status: StatusPassed},
		{name: "requested-inclusive", evidenceAt: requested, status: StatusPassed},
		{name: "stale", evidenceAt: requested.Add(-5*time.Minute - time.Nanosecond), status: StatusBlocked},
		{name: "future", evidenceAt: requested.Add(time.Nanosecond), status: StatusBlocked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "runtime.json")
			writeJSON(t, path, map[string]any{
				"observed_at": tc.evidenceAt.Format(time.RFC3339Nano),
				"service":     map[string]any{"name": "rencrow-portal.service", "active": true},
				"pid":         1234,
				"executable":  "/home/test/.local/bin/rencrow-portal",
				"config_path": "/home/test/.rencrow/config/portal.json",
				"listener":    map[string]any{"address": "127.0.0.1:18791", "bound": true},
				"security":    map[string]any{"loopback_only": true},
			})
			receipt, runErr := Run(context.Background(), Options{
				ManifestPath:    writeManifest(t, `portal_runtime_identity_lifecycle_security`, `portal-runtime-identity-lifecycle-security`),
				CheckID:         "portal_runtime_identity_lifecycle_security",
				ObservedAt:      testObservedAt,
				EvidenceDir:     dir,
				RuntimeEvidence: path,
			})
			if runErr != nil {
				t.Fatal(runErr)
			}
			if receipt.Status != tc.status {
				t.Fatalf("status=%q receipt=%+v", receipt.Status, receipt)
			}
		})
	}
}

func TestRunRuntimeIdentityMissingObservationIsBlocked(t *testing.T) {
	receipt, err := Run(context.Background(), Options{
		ManifestPath: writeManifest(t, `portal_runtime_identity_lifecycle_security`, `portal-runtime-identity-lifecycle-security`),
		CheckID:      "portal_runtime_identity_lifecycle_security",
		ObservedAt:   testObservedAt,
		EvidenceDir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if receipt.Status != StatusBlocked {
		t.Fatalf("receipt=%+v", receipt)
	}
}

func writeManifest(t *testing.T, checkID, commandID string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "runtime.json")
	data := `{"schema_version":2,"purpose":"operational_status","phase":"runtime","checks":[{"check_id":"` + checkID + `","guarantee_id":"guarantee-` + checkID + `","owner":"RenCrow_PORTAL","purpose":"test","target":"test","phase":"runtime","consumer":"test","failure_action":"blocked","cost":"low","safety_gate":false,"coverage":["readiness"],"executor":{"kind":"owner_cli","command_id":"` + commandID + `"},"receipt_schema":"rencrow.check-receipt.v1"}]}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertEvidenceRefsExist(t *testing.T, dir string, refs []string) {
	t.Helper()
	for _, ref := range refs {
		if err := validateEvidenceRef(ref); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, strings.TrimPrefix(ref, "relative:"))
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("evidence ref %q: %v", ref, err)
		}
	}
}
