package verify

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	readinessTarget      = "portal:/health/ready"
	browserSendPath      = "/api/chat/viewer/send"
	browserCoreSendPath  = "/viewer/send"
	browserProxyTarget   = "portal:/api/chat/viewer/send -> CORE:/viewer/send"
	canonicalActorTarget = browserProxyTarget
	runtimeTarget        = "portal installed artifact -> owner process/service and protected bind"
	deployTarget         = "RenCrow_PORTAL source revision -> built artifact -> installed publication"
)

func runReadiness(ctx context.Context, input ReadinessInput) (Observation, error) {
	portalURL, err := validatePortalURL(input.PortalURL)
	if err != nil {
		return blockedObservation(readinessTarget, err), nil
	}
	client := input.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	target := joinPortalURL(portalURL, "/health/ready")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return blockedObservation(readinessTarget, fmt.Errorf("create readiness request: %w", err)), nil
	}
	applyAuth(request, input.Auth)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return blockedObservation(readinessTarget, fmt.Errorf("Portal readiness unavailable: %w", err)), nil
	}
	defer response.Body.Close()
	body, readErr := ioReadAllLimit(response.Body, maxResponseBytes)
	if readErr != nil {
		return Observation{Status: StatusUnverified, RouteOrTarget: readinessTarget, FailureBoundary: fmt.Sprintf("readiness response: %v", readErr), Evidence: map[string]any{"url": target, "http_status": response.StatusCode}}, nil
	}
	decoded, decodeErr := decodeObject(body)
	evidence := map[string]any{
		"url":         target,
		"http_status": response.StatusCode,
		"response":    decoded,
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		if response.StatusCode == http.StatusServiceUnavailable || response.StatusCode == http.StatusBadGateway || response.StatusCode == http.StatusGatewayTimeout {
			return Observation{Status: StatusBlocked, RouteOrTarget: readinessTarget, FailureBoundary: fmt.Sprintf("Portal readiness returned HTTP %d", response.StatusCode), Evidence: evidence}, nil
		}
		return Observation{Status: StatusFailed, RouteOrTarget: readinessTarget, FailureBoundary: fmt.Sprintf("Portal readiness returned HTTP %d", response.StatusCode), Evidence: evidence}, nil
	}
	if decodeErr != nil {
		return Observation{Status: StatusFailed, RouteOrTarget: readinessTarget, FailureBoundary: fmt.Sprintf("decode Portal readiness: %v", decodeErr), Evidence: map[string]any{"url": target, "http_status": response.StatusCode, "body": string(body)}}, nil
	}
	if !readinessJSONIsReady(decoded) {
		return Observation{Status: StatusBlocked, RouteOrTarget: readinessTarget, FailureBoundary: "Portal readiness response did not report status=ready and ok=true", Evidence: evidence}, nil
	}
	return Observation{Status: StatusPassed, RouteOrTarget: readinessTarget, Evidence: evidence}, nil
}

func readinessJSONIsReady(value map[string]any) bool {
	readyOK, okPresent := boolField(value, "ok")
	status, statusOK := stringField(value, "status")
	if !okPresent || !readyOK || !statusOK || !strings.EqualFold(status, "ready") {
		return false
	}
	service, serviceOK := stringField(value, "service")
	if serviceOK && service != "rencrow-portal" {
		return false
	}
	return true
}

func validatePortalURL(raw string) (*url.URL, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return nil, errors.New("Portal URL is required")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("Portal URL must be an http or https URL without userinfo")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("Portal URL must not contain query or fragment")
	}
	return parsed, nil
}

func joinPortalURL(base *url.URL, path string) string {
	joined := *base
	basePath := strings.TrimRight(base.Path, "/")
	joined.Path = basePath + path
	joined.RawPath = ""
	joined.RawQuery = ""
	joined.Fragment = ""
	return joined.String()
}

func applyAuth(request *http.Request, auth Auth) {
	if strings.TrimSpace(auth.HeaderName) != "" && strings.TrimSpace(auth.HeaderValue) != "" {
		request.Header.Set(strings.TrimSpace(auth.HeaderName), strings.TrimSpace(auth.HeaderValue))
	}
}

func browserPrerequisites(options Options) error {
	if strings.TrimSpace(options.BrowserEvidence) == "" && options.Observers.BrowserProxyE2E == nil && options.Observers.CanonicalActor == nil {
		return errors.New("browser evidence or an allowlisted browser runner is required")
	}
	if strings.TrimSpace(options.Auth.HeaderName) == "" || strings.TrimSpace(options.Auth.HeaderValue) == "" {
		return errors.New("explicit browser authentication is required")
	}
	if strings.TrimSpace(options.BrowserPlatform) == "" && strings.TrimSpace(options.BrowserEvidence) == "" {
		if options.Observers.BrowserProxyE2E == nil && options.Observers.CanonicalActor == nil {
			return errors.New("browser platform evidence is required")
		}
	}
	if strings.TrimSpace(options.BrowserRunner) != "" && !isAllowlistedBrowserRunner(options.BrowserRunner) {
		return errors.New("browser runner is not allowlisted")
	}
	return nil
}

func browserInput(options Options, observedAt time.Time) BrowserInput {
	runner := strings.TrimSpace(options.BrowserRunner)
	if runner == "" {
		runner = "evidence-input"
	}
	return BrowserInput{
		PortalURL:       options.PortalURL,
		Auth:            options.Auth,
		EvidencePath:    options.BrowserEvidence,
		BrowserRunner:   runner,
		BrowserName:     options.BrowserName,
		BrowserPlatform: options.BrowserPlatform,
		ObservedAt:      observedAt,
	}
}

func isAllowlistedBrowserRunner(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "evidence", "evidence-input", "playwright", "playwright-firefox", "firefox", "chromium":
		return true
	default:
		return false
	}
}

func runBrowserCheck(_ context.Context, options Options, canonical bool) (Observation, error) {
	if commonArgsOnly(options) {
		return blockedObservation(browserTarget(canonical), errors.New("authentication_unavailable")), nil
	}
	if err := browserPrerequisites(options); err != nil {
		return blockedObservation(browserTarget(canonical), err), nil
	}
	requested, err := parseObservedAt(strings.TrimSpace(options.ObservedAt))
	if err != nil {
		return blockedObservation(browserTarget(canonical), fmt.Errorf("browser evidence observation time unavailable: %w", err)), nil
	}
	object, err := readFreshStructuredEvidence(options.BrowserEvidence, requested)
	if err != nil {
		return blockedObservation(browserTarget(canonical), fmt.Errorf("browser evidence unavailable or stale: %w", err)), nil
	}
	if err := validateBrowserEvidence(object, options, canonical); err != nil {
		return blockedObservation(browserTarget(canonical), err), nil
	}
	return Observation{Status: StatusPassed, RouteOrTarget: browserTarget(canonical), Evidence: object}, nil
}

func commonArgsOnly(options Options) bool {
	return strings.TrimSpace(options.BrowserEvidence) == "" &&
		strings.TrimSpace(options.BrowserRunner) == "" &&
		strings.TrimSpace(options.BrowserName) == "" &&
		strings.TrimSpace(options.BrowserPlatform) == "" &&
		strings.TrimSpace(options.Auth.HeaderName) == "" &&
		strings.TrimSpace(options.Auth.HeaderValue) == ""
}

func browserTarget(canonical bool) string {
	if canonical {
		return canonicalActorTarget
	}
	return browserProxyTarget
}

func validateInjectedBrowserObservation(observation Observation, options Options, canonical bool, observerErr error) Observation {
	if observerErr != nil || observation.Status != StatusPassed {
		return observation
	}
	object, ok := observation.Evidence.(map[string]any)
	if !ok {
		if raw, rawOK := observation.Evidence.(json.RawMessage); rawOK {
			var decoded any
			if json.Unmarshal(raw, &decoded) == nil {
				object, ok = decoded.(map[string]any)
			}
		}
	}
	if !ok {
		return blockedObservation(browserTarget(canonical), errors.New("browser observer must return captured browser evidence"))
	}
	requested, err := parseObservedAt(strings.TrimSpace(options.ObservedAt))
	if err != nil {
		return blockedObservation(browserTarget(canonical), fmt.Errorf("browser evidence observation time unavailable: %w", err))
	}
	if strings.TrimSpace(options.BrowserEvidence) != "" {
		if _, err := readFreshStructuredEvidence(options.BrowserEvidence, requested); err != nil {
			return blockedObservation(browserTarget(canonical), fmt.Errorf("browser evidence unavailable or stale: %w", err))
		}
	}
	if err := validateFreshStructuredEvidence(object, requested); err != nil {
		return blockedObservation(browserTarget(canonical), err)
	}
	if err := validateBrowserEvidence(object, options, canonical); err != nil {
		return blockedObservation(browserTarget(canonical), err)
	}
	return observation
}

// validateInjectedEvidenceObservation prevents an injected owner adapter from
// turning an unbounded or synthetic result into a passed receipt.  The adapter
// may observe on a platform-specific boundary, but it must still return the
// same structured evidence contract as the file-backed path.
func validateInjectedEvidenceObservation(observation Observation, target string, requested time.Time, observerErr error) Observation {
	if observerErr != nil || observation.Status != StatusPassed {
		return observation
	}
	object, ok := observation.Evidence.(map[string]any)
	if !ok {
		if raw, rawOK := observation.Evidence.(json.RawMessage); rawOK {
			var decoded any
			if json.Unmarshal(raw, &decoded) == nil {
				object, ok = decoded.(map[string]any)
			}
		}
	}
	if !ok {
		return blockedObservation(target, errors.New("owner observer must return structured evidence"))
	}
	if err := validateFreshStructuredEvidence(object, requested); err != nil {
		return blockedObservation(target, err)
	}
	return observation
}

func validateBrowserEvidence(raw map[string]any, options Options, canonical bool) error {
	browserName := firstString(raw, "browser", "browser_name", "engine")
	if browserName == "" {
		browserName = strings.TrimSpace(options.BrowserName)
	}
	platform := firstString(raw, "platform", "browser_platform", "os", "operating_system")
	if platform == "" {
		platform = strings.TrimSpace(options.BrowserPlatform)
	}
	if browserName == "" || platform == "" {
		return errors.New("browser name and platform evidence are required")
	}
	if !isAllowlistedBrowserRunner(options.BrowserRunner) && strings.TrimSpace(options.BrowserRunner) != "" {
		return errors.New("browser runner is not allowlisted")
	}
	authenticated, authPresent := firstBool(raw, "authenticated", "is_authenticated", "auth_ok")
	authValue := firstString(raw, "auth_method", "authentication_method", "auth_scheme")
	authObject := firstMap(raw, "auth", "authentication")
	if authValue == "" && authObject != nil {
		authValue = firstString(authObject, "method", "scheme", "type")
		if value, present := firstBool(authObject, "authenticated", "ok"); present {
			authenticated, authPresent = value, true
		}
	}
	if !authPresent || !authenticated || (authValue == "" && strings.TrimSpace(options.Auth.HeaderName) == "") {
		return errors.New("browser evidence does not prove explicit authentication")
	}

	portalURL, err := validatePortalURL(options.PortalURL)
	if err != nil {
		return err
	}
	declaredPortal := firstString(raw, "portal_url", "published_portal_url", "surface_url", "origin")
	if declaredPortal != "" {
		declared, parseErr := validatePortalURL(declaredPortal)
		if parseErr != nil || !sameOrigin(declared, portalURL) {
			return errors.New("browser evidence Portal origin does not match the published Portal")
		}
	}
	if published, present := firstBool(raw, "published", "published_portal"); present && !published {
		return errors.New("browser evidence is not from the published Portal")
	}

	requestObject := firstMap(raw, "request", "browser_request", "proxy_request")
	if requestObject == nil {
		if requests := firstSlice(raw, "requests", "network"); len(requests) > 0 {
			requestObject, _ = requests[0].(map[string]any)
		}
	}
	method := firstString(requestObject, "method", "http_method")
	if method == "" {
		method = firstString(raw, "method", "http_method")
	}
	requestURL := firstString(requestObject, "url", "request_url", "href", "address")
	if requestURL == "" {
		requestURL = firstString(raw, "request_url", "browser_url", "request_address")
	}
	requestPath := firstString(requestObject, "path", "request_path", "endpoint")
	if requestPath == "" {
		requestPath = firstString(raw, "request_path", "browser_path", "route")
	}
	if requestURL != "" {
		parsed, parseErr := url.Parse(requestURL)
		if parseErr != nil || parsed.User != nil {
			return errors.New("browser request URL is invalid")
		}
		if parsed.Path != "" {
			requestPath = parsed.Path
		}
		if parsed.IsAbs() {
			if parsed.Host == "" || !sameOrigin(parsed, portalURL) {
				return errors.New("browser request bypasses the published Portal origin")
			}
		}
	}
	if requestPath == "" {
		return errors.New("browser evidence is missing request path")
	}
	if requestPath != browserSendPath {
		return fmt.Errorf("browser request path %q is not the allowlisted Portal path %q", requestPath, browserSendPath)
	}
	if !strings.EqualFold(method, http.MethodPost) {
		return fmt.Errorf("browser request method %q is not POST", method)
	}
	corePath := firstString(raw, "core_path", "proxied_path", "target_path", "upstream_path")
	if corePath != "" && corePath != browserCoreSendPath {
		return fmt.Errorf("browser upstream path %q is not the allowlisted CORE route %q", corePath, browserCoreSendPath)
	}
	if directURL := firstString(raw, "core_url", "upstream_url", "backend_url"); directURL != "" {
		parsed, parseErr := url.Parse(directURL)
		if parseErr != nil || parsed.Host != "" && sameOrigin(parsed, portalURL) {
			return errors.New("browser evidence contains an unsafe direct CORE target")
		}
		// A CORE URL may be recorded as a non-request observation, but the
		// actual browser request above must still be the Portal origin.
	}

	responseObject := firstMap(raw, "response", "browser_response", "result")
	statusCode, statusPresent := firstInteger(responseObject, "status", "status_code", "http_status")
	if !statusPresent {
		statusCode, statusPresent = firstInteger(raw, "status_code", "http_status", "response_status")
	}
	if !statusPresent || statusCode < http.StatusOK || statusCode >= http.StatusMultipleChoices {
		return errors.New("browser evidence does not prove a successful Portal response")
	}
	visible := firstString(raw, "user_visible_result", "user_visible_response", "visible_text", "rendered_text", "response_text", "message")
	if visible == "" && responseObject != nil {
		visible = firstString(responseObject, "user_visible_result", "visible_text", "text", "content", "message")
	}
	if visible == "" {
		return errors.New("browser evidence is missing the user-visible result")
	}
	jobID := firstString(raw, "job_id", "jobID", "request_id")
	traceID := firstString(raw, "trace_id", "traceID", "receipt_id", "receipt_ref", "correlation_id")
	if responseObject != nil {
		if jobID == "" {
			jobID = firstString(responseObject, "job_id", "jobID", "request_id")
		}
		if traceID == "" {
			traceID = firstString(responseObject, "trace_id", "traceID", "receipt_id", "receipt_ref", "correlation_id")
		}
	}
	if jobID == "" {
		return errors.New("browser evidence is missing the CORE job receipt")
	}
	if canonical && traceID == "" {
		return errors.New("canonical browser evidence is missing a receipt trace")
	}
	if canonical {
		actor := firstString(raw, "actor", "actor_id", "actor_type", "user_id", "authenticated_user")
		if actor == "" {
			return errors.New("canonical browser evidence is missing the authenticated actor")
		}
		if looksLikeTestDouble(actor) || looksLikeTestDouble(firstString(raw, "brain", "agent", "provider")) {
			return errors.New("canonical browser evidence identifies a test double, not a real actor")
		}
	}
	return nil
}

func sameOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) && strings.EqualFold(left.Host, right.Host)
}

func looksLikeTestDouble(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, marker := range []string{"test", "dummy", "fake", "stub", "mock", "rulebased", "rule_based", "placeholder"} {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}

func runDeployIdentity(_ context.Context, input DeployIdentityInput) (Observation, error) {
	if strings.TrimSpace(input.SourceEvidence) == "" || strings.TrimSpace(input.ArtifactEvidence) == "" || strings.TrimSpace(input.PublicationEvidence) == "" {
		if input.SourceEvidence == "" && input.ArtifactEvidence == "" && input.PublicationEvidence == "" {
			return discoverPortalDeployIdentity(input.ObservedAt)
		}
		return blockedObservation(deployTarget, errors.New("source, artifact, and publication evidence are all required")), nil
	}
	if input.ObservedAt.IsZero() {
		return blockedObservation(deployTarget, errors.New("deploy evidence observation time is required")), nil
	}
	source, sourceRef, err := loadIdentityDocument(input.EvidenceDir, input.SourceEvidence, "source", input.ObservedAt)
	if err != nil {
		return blockedObservation(deployTarget, err), nil
	}
	artifact, artifactRef, err := loadIdentityDocument(input.EvidenceDir, input.ArtifactEvidence, "artifact", input.ObservedAt)
	if err != nil {
		return blockedObservation(deployTarget, err), nil
	}
	publication, publicationRef, err := loadIdentityDocument(input.EvidenceDir, input.PublicationEvidence, "publication", input.ObservedAt)
	if err != nil {
		return blockedObservation(deployTarget, err), nil
	}
	if err := validateIdentityChain(source, artifact, publication); err != nil {
		return Observation{Status: StatusFailed, RouteOrTarget: deployTarget, FailureBoundary: err.Error(), Evidence: map[string]any{"source": source, "artifact": artifact, "publication": publication, "evidence_refs": []string{sourceRef, artifactRef, publicationRef}}}, nil
	}
	return Observation{Status: StatusPassed, RouteOrTarget: deployTarget, Evidence: map[string]any{"source": source, "artifact": artifact, "publication": publication, "evidence_refs": []string{sourceRef, artifactRef, publicationRef}}}, nil
}

type identityDocument struct {
	Kind           string
	Revision       string
	SourceRevision string
	Path           string
	SHA256         string
	ArtifactSHA256 string
	Published      bool
	HasPublished   bool
}

func loadIdentityDocument(evidenceDir, path, kind string, requested time.Time) (identityDocument, string, error) {
	path = strings.TrimSpace(path)
	data, err := readBoundedFile(path, maxEvidenceBytes)
	if err != nil {
		return identityDocument{}, "", fmt.Errorf("%s evidence unavailable: %w", kind, err)
	}
	document := identityDocument{Kind: kind}
	var raw map[string]any
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		raw, err = decodeObject(data)
		if err != nil {
			return identityDocument{}, "", fmt.Errorf("decode %s evidence: %w", kind, err)
		}
		if err := validateFreshStructuredEvidence(raw, requested); err != nil {
			return identityDocument{}, "", fmt.Errorf("%s evidence is stale or missing a trustworthy observation time: %w", kind, err)
		}
		document.Revision = firstString(raw, "revision", "source_revision", "commit", "commit_sha", "source_commit")
		document.SourceRevision = firstString(raw, "source_revision", "revision", "commit", "commit_sha")
		document.Path = firstString(raw, "path", "file", "artifact_path", "publication_path", "installed_path")
		document.SHA256 = normalizeDigest(firstString(raw, "sha256", "digest", "file_sha256", "artifact_sha256", "publication_sha256", "published_sha256", "build_sha256"))
		document.ArtifactSHA256 = normalizeDigest(firstString(raw, "artifact_sha256", "artifact_digest", "build_sha256", "sha256", "digest"))
		if published, present := firstBool(raw, "published", "installed", "deployed"); present {
			document.Published, document.HasPublished = published, true
		}
	} else {
		document.Path = path
		document.SHA256 = digestBytes(data)
		document.ArtifactSHA256 = document.SHA256
	}
	if document.Path != "" {
		resolved := document.Path
		if !filepath.IsAbs(resolved) {
			resolved = filepath.Join(filepath.Dir(path), resolved)
			if strings.TrimSpace(evidenceDir) != "" {
				candidate := filepath.Join(evidenceDir, document.Path)
				if _, statErr := os.Lstat(candidate); statErr == nil {
					resolved = candidate
				}
			}
		}
		info, statErr := os.Lstat(resolved)
		if statErr != nil {
			return identityDocument{}, "", fmt.Errorf("%s referenced file unavailable: %w", kind, statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return identityDocument{}, "", fmt.Errorf("%s referenced path must be a regular non-symlink file", kind)
		}
		document.Path = resolved
		var actual string
		var hashErr error
		if kind == "artifact" || kind == "publication" {
			actual, hashErr = digestFreshArtifactFile(resolved, requested)
		} else {
			actual, hashErr = digestFile(resolved)
		}
		if hashErr != nil {
			return identityDocument{}, "", fmt.Errorf("%s digest or freshness: %w", kind, hashErr)
		}
		if document.SHA256 == "" {
			document.SHA256 = actual
		}
		if document.SHA256 != actual {
			return identityDocument{}, "", fmt.Errorf("%s digest mismatch: evidence=%s actual=%s", kind, document.SHA256, actual)
		}
	}
	if document.SHA256 == "" {
		document.SHA256 = digestBytes(data)
	}
	if document.ArtifactSHA256 == "" {
		document.ArtifactSHA256 = document.SHA256
	}
	return document, evidenceReference(evidenceDir, path), nil
}

func validateIdentityChain(source, artifact, publication identityDocument) error {
	if strings.TrimSpace(source.Revision) == "" {
		return errors.New("source evidence is missing an immutable revision")
	}
	if strings.TrimSpace(artifact.SourceRevision) == "" || artifact.SourceRevision != source.Revision {
		return errors.New("artifact evidence does not identify the observed source revision")
	}
	if strings.TrimSpace(artifact.SHA256) == "" {
		return errors.New("artifact evidence is missing sha256")
	}
	if !isSHA256Digest(artifact.SHA256) {
		return errors.New("artifact evidence sha256 is not a valid SHA-256 digest")
	}
	if strings.TrimSpace(publication.SHA256) == "" || publication.SHA256 != artifact.SHA256 {
		return errors.New("publication digest does not match the built artifact")
	}
	if !isSHA256Digest(publication.SHA256) {
		return errors.New("publication evidence sha256 is not a valid SHA-256 digest")
	}
	if artifact.Path != "" && publication.Path != "" && sameFilePath(artifact.Path, publication.Path) {
		return errors.New("artifact and publication evidence identify the same file")
	}
	if publication.HasPublished && !publication.Published {
		return errors.New("publication evidence reports that the artifact is not published")
	}
	return nil
}

func normalizeDigest(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "sha256:")
	if len(value) != 64 {
		return value
	}
	if _, err := hex.DecodeString(value); err != nil {
		return value
	}
	return value
}

func isSHA256Digest(value string) bool {
	value = strings.TrimSpace(strings.TrimPrefix(strings.ToLower(value), "sha256:"))
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func sameFilePath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if absoluteLeft, err := filepath.Abs(left); err == nil {
		left = absoluteLeft
	}
	if absoluteRight, err := filepath.Abs(right); err == nil {
		right = absoluteRight
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

func digestBytes(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func digestFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, maxEvidenceBytes+1))
	if err != nil {
		return "", err
	}
	if count > maxEvidenceBytes {
		return "", fmt.Errorf("file exceeds bounded size %d", maxEvidenceBytes)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func evidenceReference(evidenceDir, path string) string {
	if evidenceDir != "" {
		if relative, err := filepath.Rel(evidenceDir, path); err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative) {
			return "relative:" + filepath.ToSlash(relative)
		}
	}
	return "relative:" + safeFileToken(filepath.Base(path))
}

func runRuntimeIdentity(_ context.Context, input RuntimeIdentityInput) (Observation, error) {
	if strings.TrimSpace(input.Observation) == "" {
		if input.ObservedAt.IsZero() || time.Since(input.ObservedAt) > evidenceFreshnessWindow || time.Until(input.ObservedAt) > 0 {
			return blockedObservation(runtimeTarget, errors.New("runtime service/PID/config/listener/bind observation is required")), nil
		}
		return discoverPortalRuntimeIdentity(input.ObservedAt)
	}
	if input.ObservedAt.IsZero() {
		return blockedObservation(runtimeTarget, errors.New("runtime observation time is required")), nil
	}
	raw, err := readFreshStructuredEvidence(input.Observation, input.ObservedAt)
	if err != nil {
		return blockedObservation(runtimeTarget, fmt.Errorf("runtime observation unavailable or stale: %w", err)), nil
	}
	if err := validateRuntimeObservation(raw); err != nil {
		status := StatusBlocked
		if strings.Contains(strings.ToLower(err.Error()), "unsafe") || strings.Contains(strings.ToLower(err.Error()), "mismatch") {
			status = StatusFailed
		}
		return Observation{Status: status, RouteOrTarget: runtimeTarget, FailureBoundary: err.Error(), Evidence: raw}, nil
	}
	return Observation{Status: StatusPassed, RouteOrTarget: runtimeTarget, Evidence: raw}, nil
}

func validateRuntimeObservation(raw map[string]any) error {
	serviceName := firstString(raw, "service_name", "unit", "service", "service_unit")
	if serviceObject := firstMap(raw, "service", "unit"); serviceObject != nil {
		if value := firstString(serviceObject, "name", "unit", "service_name"); value != "" {
			serviceName = value
		}
		if active, present := firstBool(serviceObject, "active", "running", "ready"); present && !active {
			return errors.New("runtime service is not active")
		}
	}
	if serviceName == "" {
		return errors.New("runtime observation is missing service identity")
	}
	if !validPortalServiceName(serviceName) {
		return fmt.Errorf("runtime service identity mismatch: %q", serviceName)
	}
	active, activePresent := firstBool(raw, "active", "running", "ready")
	if !activePresent {
		return errors.New("runtime observation is missing active service state")
	}
	if !active {
		return errors.New("runtime service is not active")
	}
	pid, present := firstInteger(raw, "pid", "process_id", "process_pid")
	if !present || pid <= 0 {
		return errors.New("runtime observation is missing a positive PID")
	}
	executable := firstString(raw, "executable", "exe", "binary", "process_executable", "artifact")
	if executable == "" {
		return errors.New("runtime observation is missing executable identity")
	}
	if !validPortalExecutable(executable) {
		return fmt.Errorf("runtime executable identity mismatch: %q", executable)
	}
	configPath := firstString(raw, "config", "config_path", "configuration", "configuration_path")
	if configObject := firstMap(raw, "config", "configuration"); configObject != nil {
		if value := firstString(configObject, "path", "config_path", "file"); value != "" {
			configPath = value
		}
	}
	if configPath == "" {
		return errors.New("runtime observation is missing config identity")
	}
	listenerHost, listenerPort, bound, listenerPresent := runtimeListener(raw)
	if !listenerPresent || listenerHost == "" || listenerPort == 0 || !bound {
		return errors.New("runtime observation is missing listener/bind state")
	}
	if listenerPort != 18791 {
		return fmt.Errorf("runtime listener port mismatch: %d", listenerPort)
	}
	if listenerHost == "0.0.0.0" || listenerHost == "::" || listenerHost == "[::]" {
		proxy, proxyPresent := firstBool(raw, "auth_proxy", "authenticated_proxy", "front_proxy")
		if !proxyPresent || !proxy {
			return errors.New("unsafe public bind without an authenticated front proxy")
		}
	}
	securityObject := firstMap(raw, "security", "security_exposure", "hardening")
	loopbackOnly, loopbackPresent := firstBool(raw, "loopback_only", "loopback_bind")
	proxy, proxyPresent := firstBool(raw, "auth_proxy", "authenticated_proxy", "front_proxy")
	if securityObject != nil {
		if value, present := firstBool(securityObject, "loopback_only", "loopback_bind"); present {
			loopbackOnly, loopbackPresent = value, true
		}
		if value, present := firstBool(securityObject, "auth_proxy", "authenticated_proxy", "front_proxy"); present {
			proxy, proxyPresent = value, true
		}
	}
	if !loopbackPresent && !proxyPresent {
		return errors.New("runtime observation is missing security exposure state")
	}
	if (listenerHost == "127.0.0.1" || listenerHost == "localhost" || listenerHost == "::1") && !loopbackOnly && !proxy {
		return errors.New("runtime observation does not prove a protected loopback or authenticated proxy boundary")
	}
	return nil
}

func validPortalServiceName(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "rencrow-portal", "rencrow-portal.service", "rencrow_portal":
		return true
	default:
		return false
	}
}

func validPortalExecutable(value string) bool {
	base := strings.ToLower(strings.TrimSpace(filepath.Base(value)))
	return base == "rencrow-portal" || base == "rencrow-portal.exe"
}

func runtimeListener(raw map[string]any) (string, int64, bool, bool) {
	listenerHost := firstString(raw, "bind", "bind_host", "listener_host", "listen_host", "listen", "listen_address", "host")
	listenerPort, portPresent := firstInteger(raw, "port", "listener_port", "listen_port")
	bound, boundPresent := firstBool(raw, "bound", "listener_bound", "listening")
	listener := firstMap(raw, "listener", "listen", "socket", "endpoint")
	if listener != nil {
		if value := firstString(listener, "address", "bind", "endpoint", "listen", "host"); value != "" {
			if host, port, parseErr := net.SplitHostPort(value); parseErr == nil {
				listenerHost, listenerPort, portPresent = host, int64(portNumber(port)), true
			} else if listenerHost == "" {
				listenerHost = value
			}
		}
		if value, present := firstInteger(listener, "port", "listener_port", "listen_port"); present {
			listenerPort, portPresent = value, true
		}
		if value, present := firstBool(listener, "bound", "listening", "ready"); present {
			bound, boundPresent = value, true
		}
	}
	if listenerHost == "" {
		if value := firstString(raw, "listener_address", "listen_address", "endpoint"); value != "" {
			if host, port, parseErr := net.SplitHostPort(value); parseErr == nil {
				listenerHost, listenerPort, portPresent = host, int64(portNumber(port)), true
			}
		}
	}
	if listenerPort == 0 && strings.Contains(listenerHost, ":") {
		if host, port, parseErr := net.SplitHostPort(listenerHost); parseErr == nil {
			listenerHost, listenerPort, portPresent = host, int64(portNumber(port)), true
		}
	}
	return listenerHost, listenerPort, bound, portPresent && boundPresent
}

func portNumber(value string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < 0 || parsed > 65535 {
		return 0
	}
	return parsed
}

func blockedObservation(target string, err error) Observation {
	message := "blocked"
	if err != nil {
		message = err.Error()
	}
	return Observation{Status: StatusBlocked, RouteOrTarget: target, FailureBoundary: message}
}
