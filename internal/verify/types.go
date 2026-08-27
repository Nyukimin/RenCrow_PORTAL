// Package verify implements the read-only RenCrow_PORTAL owner checks.
//
// The package intentionally does not import the Portal server package.  A
// verifier observes the published owner boundary; it must not turn an
// in-process handler (or a test double) into production E2E evidence.
package verify

import (
	"context"
	"net/http"
	"strings"
	"time"
)

const (
	Owner         = "RenCrow_PORTAL"
	ReceiptSchema = "rencrow.check-receipt.v1"
	SchemaVersion = 1

	StatusPassed        = "passed"
	StatusFailed        = "failed"
	StatusBlocked       = "blocked"
	StatusUnverified    = "unverified"
	StatusNotApplicable = "not_applicable"

	ExitPassed     = 0
	ExitFailed     = 10
	ExitBlocked    = 20
	ExitUnverified = 30
	ExitCLIError   = 2

	defaultPortalURL  = "http://127.0.0.1:18791"
	maxManifestBytes  = 1 << 20
	maxEvidenceBytes  = 4 << 20
	maxResponseBytes  = 256 << 10
	maxReceiptMessage = 256
)

// Receipt is the owner receipt defined by full-system-verification.md.
// Keep this shape deliberately small: aggregate-set treats additional
// owner-specific fields as a schema error.
type Receipt struct {
	SchemaVersion   int      `json:"schema_version"`
	ReceiptSchema   string   `json:"receipt_schema"`
	CheckID         string   `json:"check_id"`
	GuaranteeID     string   `json:"guarantee_id"`
	Owner           string   `json:"owner"`
	Status          string   `json:"status"`
	ObservedAt      string   `json:"observed_at"`
	RouteOrTarget   string   `json:"route_or_target"`
	EvidenceRefs    []string `json:"evidence_refs"`
	FailureBoundary string   `json:"failure_boundary"`
}

// Observation is returned by a check observer.  Production observers are
// deterministic functions below; tests can inject one without mocking a
// CORE/Portal actor or changing runtime state.
type Observation struct {
	Status          string
	RouteOrTarget   string
	Evidence        any
	EvidenceRefs    []string
	FailureBoundary string
}

// Auth contains an explicit, caller-provided browser/proxy credential.  Its
// value is never included in receipts or evidence snapshots.
type Auth struct {
	HeaderName  string
	HeaderValue string
}

// ReadinessInput is the only input needed by the live Portal readiness check.
type ReadinessInput struct {
	PortalURL  string
	Auth       Auth
	HTTPClient *http.Client
}

// BrowserInput describes an externally captured browser run.  Runner is an
// allowlisted identifier, never a shell command.  Browser evidence remains an
// input artifact; this verifier does not synthesize a browser request.
type BrowserInput struct {
	PortalURL       string
	Auth            Auth
	EvidencePath    string
	BrowserRunner   string
	BrowserName     string
	BrowserPlatform string
	ObservedAt      time.Time
}

// DeployIdentityInput identifies three explicit, read-only evidence inputs.
// Each path may point to a JSON observation document; artifact/publication
// documents may in turn identify the file whose digest was observed.
type DeployIdentityInput struct {
	EvidenceDir         string
	SourceEvidence      string
	ArtifactEvidence    string
	PublicationEvidence string
	ObservedAt          time.Time
}

// RuntimeIdentityInput identifies the explicit process/service observation
// document.  Process enumeration and service-manager calls are intentionally
// not performed by the verifier, keeping this check portable and read-only.
type RuntimeIdentityInput struct {
	EvidenceDir string
	Observation string
	ObservedAt  time.Time
}

// Observers is a narrow injection seam for deterministic unit tests and
// owner-specific platform adapters.  A nil observer selects the production
// read-only observer.  Callers must not use an observer to bypass browser,
// authentication, route, or evidence validation.
type Observers struct {
	Readiness       func(context.Context, ReadinessInput) (Observation, error)
	BrowserProxyE2E func(context.Context, BrowserInput) (Observation, error)
	DeployIdentity  func(context.Context, DeployIdentityInput) (Observation, error)
	RuntimeIdentity func(context.Context, RuntimeIdentityInput) (Observation, error)
	CanonicalActor  func(context.Context, BrowserInput) (Observation, error)
}

// Options is the verifier request.  The common fields mirror the owner CLI
// contract; all owner-specific values are explicit inputs and never arbitrary
// commands.
type Options struct {
	ManifestPath string
	CheckID      string
	ObservedAt   string
	EvidenceDir  string

	PortalURL       string
	Auth            Auth
	BrowserEvidence string
	BrowserRunner   string
	BrowserName     string
	BrowserPlatform string

	SourceEvidence      string
	ArtifactEvidence    string
	PublicationEvidence string
	RuntimeEvidence     string

	HTTPClient *http.Client
	Observers  Observers
}

// CLIError marks a request/manifest/schema failure.  Such errors must not be
// converted into an owner receipt because the full-system aggregator cannot
// safely consume a malformed receipt.
type CLIError struct{ Err error }

func (e *CLIError) Error() string {
	if e == nil || e.Err == nil {
		return "verifier CLI error"
	}
	return e.Err.Error()
}

func (e *CLIError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// ExitCode maps a valid receipt status to the owner verifier exit contract.
func ExitCode(status string) int {
	switch status {
	case StatusPassed, StatusNotApplicable:
		return ExitPassed
	case StatusFailed:
		return ExitFailed
	case StatusBlocked:
		return ExitBlocked
	case StatusUnverified:
		return ExitUnverified
	default:
		return ExitCLIError
	}
}

func parseObservedAt(raw string) (time.Time, error) {
	value := strings.TrimSpace(raw)
	if !strings.HasSuffix(value, "Z") {
		return time.Time{}, errUTCRequired
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}
