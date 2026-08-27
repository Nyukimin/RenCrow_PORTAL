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
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Run validates the owner manifest and executes exactly the selected,
// allowlisted check.  Request/manifest/schema errors are returned as
// *CLIError.  Runtime prerequisites and check failures are represented by a
// valid Receipt, including a blocked receipt when the canonical route or
// explicit evidence is unavailable.
func Run(ctx context.Context, options Options) (Receipt, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	manifest, err := readOwnerManifest(options.ManifestPath)
	if err != nil {
		return Receipt{}, &CLIError{Err: err}
	}
	check, err := selectManifestCheck(manifest, options.CheckID)
	if err != nil {
		return Receipt{}, &CLIError{Err: err}
	}
	observed, err := parseObservedAt(strings.TrimSpace(options.ObservedAt))
	if err != nil {
		return Receipt{}, &CLIError{Err: fmt.Errorf("--observed-at: %w", err)}
	}
	if strings.TrimSpace(options.EvidenceDir) == "" {
		return Receipt{}, &CLIError{Err: errors.New("--evidence-dir is required")}
	}
	if err := validateEvidenceDir(options.EvidenceDir); err != nil {
		return Receipt{}, &CLIError{Err: err}
	}

	if strings.TrimSpace(options.PortalURL) == "" {
		options.PortalURL = defaultPortalURL
	}
	options.PortalURL = strings.TrimRight(strings.TrimSpace(options.PortalURL), "/")
	if options.HTTPClient == nil {
		options.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if err := validateAuth(options.Auth); err != nil {
		return Receipt{}, &CLIError{Err: err}
	}

	receipt := newReceipt(check, observed)
	var observation Observation
	switch check.Executor.CommandID {
	case "portal-readiness":
		observation, err = runReadiness(ctx, ReadinessInput{PortalURL: options.PortalURL, Auth: options.Auth, HTTPClient: options.HTTPClient})
		if options.Observers.Readiness != nil {
			observation, err = options.Observers.Readiness(ctx, ReadinessInput{PortalURL: options.PortalURL, Auth: options.Auth, HTTPClient: options.HTTPClient})
		}
	case "portal-browser-proxy-e2e":
		observation, err = runBrowserCheck(ctx, options, false)
		if options.Observers.BrowserProxyE2E != nil && browserPrerequisites(options) == nil {
			observation, err = options.Observers.BrowserProxyE2E(ctx, browserInput(options, observed))
			observation = validateInjectedBrowserObservation(observation, options, false, err)
		}
	case "portal-deploy-identity-chain":
		input := DeployIdentityInput{EvidenceDir: options.EvidenceDir, SourceEvidence: options.SourceEvidence, ArtifactEvidence: options.ArtifactEvidence, PublicationEvidence: options.PublicationEvidence, ObservedAt: observed}
		observation, err = runDeployIdentity(ctx, input)
		if options.Observers.DeployIdentity != nil {
			observation, err = options.Observers.DeployIdentity(ctx, input)
			observation = validateInjectedEvidenceObservation(observation, deployTarget, observed, err)
		}
	case "portal-runtime-identity-lifecycle-security":
		input := RuntimeIdentityInput{EvidenceDir: options.EvidenceDir, Observation: options.RuntimeEvidence, ObservedAt: observed}
		observation, err = runRuntimeIdentity(ctx, input)
		if options.Observers.RuntimeIdentity != nil {
			observation, err = options.Observers.RuntimeIdentity(ctx, input)
			observation = validateInjectedEvidenceObservation(observation, runtimeTarget, observed, err)
		}
	case "portal-canonical-actor-e2e":
		observation, err = runBrowserCheck(ctx, options, true)
		if options.Observers.CanonicalActor != nil && browserPrerequisites(options) == nil {
			observation, err = options.Observers.CanonicalActor(ctx, browserInput(options, observed))
			observation = validateInjectedBrowserObservation(observation, options, true, err)
		}
	default:
		// readOwnerManifest validates this before reaching the switch. Keep a
		// defensive branch so adding an allowlist item can never pass silently.
		return Receipt{}, &CLIError{Err: fmt.Errorf("executor command %q is not implemented", check.Executor.CommandID)}
	}
	if err != nil {
		observation = Observation{Status: StatusBlocked, RouteOrTarget: check.Target, FailureBoundary: err.Error()}
	}
	return finalizeReceipt(receipt, observation, options.EvidenceDir, check.CheckID)
}

func newReceipt(check manifestCheck, observed time.Time) Receipt {
	return Receipt{
		SchemaVersion: SchemaVersion,
		ReceiptSchema: ReceiptSchema,
		CheckID:       check.CheckID,
		GuaranteeID:   check.GuaranteeID,
		Owner:         Owner,
		ObservedAt:    observed.Format(time.RFC3339Nano),
		RouteOrTarget: check.Target,
		EvidenceRefs:  []string{},
	}
}

func finalizeReceipt(receipt Receipt, observation Observation, evidenceDir, checkID string) (Receipt, error) {
	status := strings.TrimSpace(observation.Status)
	if status == "" {
		status = StatusUnverified
		observation.FailureBoundary = "observer returned no status"
	}
	if ExitCode(status) == ExitCLIError {
		status = StatusUnverified
		observation.FailureBoundary = "observer returned unsupported status"
	}
	receipt.Status = status
	if strings.TrimSpace(receipt.RouteOrTarget) == "" {
		receipt.RouteOrTarget = checkID
	}
	receipt.FailureBoundary = truncateReceiptMessage(strings.TrimSpace(observation.FailureBoundary))
	receipt.EvidenceRefs = append([]string{}, observation.EvidenceRefs...)
	// The observer may supply a structured object or a scalar diagnostic.
	// Normalize both into the immutable evidence snapshot without exposing
	// credentials in the receipt itself.
	evidence := observation.Evidence
	if evidence == nil {
		evidence = map[string]any{}
	}
	if object, ok := evidence.(map[string]any); ok {
		copyObject := make(map[string]any, len(object)+5)
		for key, value := range object {
			copyObject[key] = value
		}
		copyObject["schema_version"] = SchemaVersion
		copyObject["receipt_schema"] = ReceiptSchema
		copyObject["check_id"] = receipt.CheckID
		copyObject["status"] = receipt.Status
		copyObject["observed_at"] = receipt.ObservedAt
		copyObject["failure_boundary"] = receipt.FailureBoundary
		evidence = copyObject
	} else {
		evidence = map[string]any{
			"schema_version":   SchemaVersion,
			"receipt_schema":   ReceiptSchema,
			"check_id":         receipt.CheckID,
			"status":           receipt.Status,
			"observed_at":      receipt.ObservedAt,
			"failure_boundary": receipt.FailureBoundary,
			"observation":      evidence,
		}
	}
	ref, err := writeEvidenceSnapshot(evidenceDir, checkID, evidence)
	if err != nil {
		if receipt.Status == StatusPassed || receipt.Status == StatusNotApplicable {
			receipt.Status = StatusBlocked
			receipt.FailureBoundary = "evidence output unavailable"
		}
	} else {
		receipt.EvidenceRefs = append(receipt.EvidenceRefs, ref)
	}
	receipt.FailureBoundary = truncateReceiptMessage(receipt.FailureBoundary)
	if receipt.EvidenceRefs == nil {
		receipt.EvidenceRefs = []string{}
	}
	if err := validateReceipt(receipt); err != nil {
		return Receipt{}, &CLIError{Err: err}
	}
	return receipt, nil
}

func truncateReceiptMessage(value string) string {
	if len(value) <= maxReceiptMessage {
		return value
	}
	return value[:maxReceiptMessage]
}

func validateReceipt(receipt Receipt) error {
	if receipt.SchemaVersion != SchemaVersion || receipt.ReceiptSchema != ReceiptSchema {
		return errors.New("receipt schema is invalid")
	}
	for name, value := range map[string]string{
		"check_id":        receipt.CheckID,
		"guarantee_id":    receipt.GuaranteeID,
		"owner":           receipt.Owner,
		"status":          receipt.Status,
		"observed_at":     receipt.ObservedAt,
		"route_or_target": receipt.RouteOrTarget,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("receipt %s is required", name)
		}
	}
	if receipt.Owner != Owner {
		return fmt.Errorf("receipt owner must be %q", Owner)
	}
	if _, err := parseObservedAt(receipt.ObservedAt); err != nil {
		return fmt.Errorf("receipt observed_at: %w", err)
	}
	if ExitCode(receipt.Status) == ExitCLIError {
		return fmt.Errorf("receipt status %q is invalid", receipt.Status)
	}
	for _, ref := range receipt.EvidenceRefs {
		if err := validateEvidenceRef(ref); err != nil {
			return err
		}
	}
	return nil
}

func validateAuth(auth Auth) error {
	name := strings.TrimSpace(auth.HeaderName)
	value := strings.TrimSpace(auth.HeaderValue)
	if (name == "") != (value == "") {
		return errors.New("auth header name and value must be supplied together")
	}
	if name == "" {
		return nil
	}
	if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
		return errors.New("auth header must not contain newlines")
	}
	if !httpHeaderNamePattern.MatchString(name) {
		return fmt.Errorf("invalid auth header name %q", name)
	}
	return nil
}

func validateEvidenceDir(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("evidence directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("evidence directory must be a directory")
	}
	clean := filepath.Clean(path)
	if clean == string(filepath.Separator) {
		return errors.New("evidence directory must be bounded")
	}
	return nil
}

func validateEvidenceRef(ref string) error {
	ref = strings.TrimSpace(ref)
	if !strings.HasPrefix(ref, "relative:") {
		return fmt.Errorf("evidence_ref must use relative: prefix: %q", ref)
	}
	path := strings.TrimPrefix(ref, "relative:")
	if path == "" || filepath.IsAbs(path) || filepath.Clean(path) == "." || filepath.Clean(path) == ".." || strings.HasPrefix(filepath.Clean(path), ".."+string(filepath.Separator)) {
		return fmt.Errorf("evidence_ref escapes evidence directory: %q", ref)
	}
	return nil
}

func writeEvidenceSnapshot(dir, checkID string, value any) (string, error) {
	if err := validateEvidenceDir(dir); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(redactEvidence(value), "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode: %w", err)
	}
	data = append(data, '\n')
	hash := sha256.Sum256(data)
	name := fmt.Sprintf("%s-%s.json", safeFileToken(checkID), hex.EncodeToString(hash[:])[:16])
	path := filepath.Join(dir, name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		if _, writeErr := file.Write(data); writeErr != nil {
			_ = file.Close()
			return "", fmt.Errorf("write %s: %w", name, writeErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			return "", fmt.Errorf("close %s: %w", name, closeErr)
		}
	} else if !errors.Is(err, os.ErrExist) {
		return "", fmt.Errorf("write %s: %w", name, err)
	} else {
		// Reusing an identical immutable snapshot keeps repeated checks
		// idempotent.  A pre-existing path with different bytes is treated as
		// an evidence collision rather than overwritten.
		existing, readErr := os.ReadFile(path)
		if readErr != nil {
			return "", fmt.Errorf("read existing %s: %w", name, readErr)
		}
		if !bytes.Equal(existing, data) {
			return "", fmt.Errorf("evidence path collision: %s", name)
		}
	}
	return "relative:" + name, nil
}

func safeFileToken(value string) string {
	var builder strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			builder.WriteRune(r)
		} else {
			builder.WriteByte('-')
		}
	}
	if builder.Len() == 0 {
		return "check"
	}
	return builder.String()
}

func redactEvidence(value any) any {
	switch typed := value.(type) {
	case json.RawMessage:
		var decoded any
		if json.Unmarshal(typed, &decoded) == nil {
			return redactEvidence(decoded)
		}
		return "[invalid-json]"
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			if sensitiveEvidenceKey(key) {
				result[key] = "[redacted]"
				continue
			}
			result[key] = redactEvidence(item)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = redactEvidence(item)
		}
		return result
	default:
		return value
	}
}

func sensitiveEvidenceKey(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(key), "-", "_"), " ", "_"))
	for _, marker := range []string{"token", "password", "secret", "api_key", "apikey", "credential", "cookie", "authorization", "auth_header_value"} {
		if strings.Contains(key, marker) {
			return true
		}
	}
	return false
}

func ioReadAllLimit(reader io.Reader, limit int64) ([]byte, error) {
	if limit <= 0 {
		return nil, errors.New("read limit must be positive")
	}
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("input exceeds bounded size %d", limit)
	}
	return data, nil
}

// authHeaderRegexp is kept local to avoid accepting arbitrary control values
// through http.Header.Set.  It covers the token and cookie header names used
// by authenticated Portal front doors while remaining a normal HTTP field
// name.
var httpHeaderNamePattern = mustCompileHeaderName()

func mustCompileHeaderName() interface{ MatchString(string) bool } {
	return headerNameMatcher{}
}

type headerNameMatcher struct{}

func (headerNameMatcher) MatchString(value string) bool {
	if value == "" {
		return false
	}
	for index, r := range value {
		if !(r == '!' || r >= '#' && r <= '\'' || r >= '*' && r <= '+' || r == '-' || r == '.' || r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= '^' && r <= 'z' || r == '|' || r == '~') {
			if index == 0 || r == ' ' {
				return false
			}
			return false
		}
	}
	return true
}

// parseInteger accepts JSON numbers and the common string representation in
// platform evidence while rejecting fractional or negative process IDs.
func parseInteger(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed < 0 || typed != float64(int64(typed)) {
			return 0, false
		}
		return int64(typed), true
	case json.Number:
		parsed, err := strconv.ParseInt(string(typed), 10, 64)
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed, err == nil
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	default:
		return 0, false
	}
}
