package verify

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

var errUTCRequired = errors.New("observed-at must be RFC3339 UTC")

var stableVerifierID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)

const maxManifestInputs = 32

type ownerManifest struct {
	SchemaVersion int             `json:"schema_version"`
	Purpose       string          `json:"purpose"`
	Phase         string          `json:"phase"`
	Checks        []manifestCheck `json:"checks"`
}

type manifestCheck struct {
	CheckID            string           `json:"check_id"`
	GuaranteeID        string           `json:"guarantee_id"`
	Owner              string           `json:"owner"`
	Purpose            string           `json:"purpose"`
	Target             string           `json:"target"`
	Phase              string           `json:"phase"`
	Consumer           string           `json:"consumer"`
	FailureAction      string           `json:"failure_action"`
	Cost               string           `json:"cost"`
	SafetyGate         bool             `json:"safety_gate"`
	Coverage           []string         `json:"coverage"`
	Executor           manifestExecutor `json:"executor"`
	ReceiptSchema      string           `json:"receipt_schema"`
	Surfaces           []string         `json:"surfaces"`
	ReplacementCheckID string           `json:"replacement_check_id,omitempty"`
	Evidence           json.RawMessage  `json:"evidence,omitempty"`
}

type manifestExecutor struct {
	Kind        string               `json:"kind"`
	CommandID   string               `json:"command_id"`
	Acquisition *manifestAcquisition `json:"acquisition"`
}

type manifestAcquisition struct {
	Mode             string          `json:"mode"`
	VerificationSafe *bool           `json:"verification_safe"`
	Inputs           []manifestInput `json:"inputs"`
}

type manifestInput struct {
	ID       string `json:"id"`
	Class    string `json:"class"`
	Required *bool  `json:"required"`
	Source   string `json:"source"`
}

// commandForCheck is the verifier's fixed allowlist.  It is deliberately
// independent of manifest data: a manifest can select only code that is
// already implemented here.
var commandForCheck = map[string]string{
	"portal_readiness":                           "portal-readiness",
	"portal_browser_proxy_e2e":                   "portal-browser-proxy-e2e",
	"portal_deploy_identity_chain":               "portal-deploy-identity-chain",
	"portal_runtime_identity_lifecycle_security": "portal-runtime-identity-lifecycle-security",
	"portal_canonical_actor_e2e":                 "portal-canonical-actor-e2e",
}

func readOwnerManifest(path string) (ownerManifest, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return ownerManifest{}, errors.New("--manifest is required")
	}
	data, err := readBoundedFile(path, maxManifestBytes)
	if err != nil {
		return ownerManifest{}, fmt.Errorf("read manifest: %w", err)
	}
	var manifest ownerManifest
	if err := decodeStrict(data, &manifest); err != nil {
		return ownerManifest{}, fmt.Errorf("decode manifest: %w", err)
	}
	if manifest.SchemaVersion != 3 {
		return ownerManifest{}, fmt.Errorf("manifest schema_version must be 3, got %d", manifest.SchemaVersion)
	}
	if strings.TrimSpace(manifest.Purpose) == "" || strings.TrimSpace(manifest.Phase) == "" {
		return ownerManifest{}, errors.New("manifest purpose and phase are required")
	}
	if len(manifest.Checks) == 0 || len(manifest.Checks) > 128 {
		return ownerManifest{}, errors.New("manifest checks must contain 1..128 entries")
	}
	seen := make(map[string]struct{}, len(manifest.Checks))
	seenCommands := make(map[string]struct{}, len(manifest.Checks))
	for index := range manifest.Checks {
		check := &manifest.Checks[index]
		if err := validateManifestCheck(*check); err != nil {
			return ownerManifest{}, fmt.Errorf("manifest checks[%d]: %w", index, err)
		}
		if _, exists := seen[check.CheckID]; exists {
			return ownerManifest{}, fmt.Errorf("manifest contains duplicate check_id %q", check.CheckID)
		}
		seen[check.CheckID] = struct{}{}
		if _, exists := seenCommands[check.Executor.CommandID]; exists {
			return ownerManifest{}, fmt.Errorf("manifest contains duplicate executor command_id %q", check.Executor.CommandID)
		}
		seenCommands[check.Executor.CommandID] = struct{}{}
	}
	return manifest, nil
}

func validateManifestCheck(check manifestCheck) error {
	for name, value := range map[string]string{
		"check_id":       check.CheckID,
		"guarantee_id":   check.GuaranteeID,
		"owner":          check.Owner,
		"purpose":        check.Purpose,
		"target":         check.Target,
		"phase":          check.Phase,
		"consumer":       check.Consumer,
		"failure_action": check.FailureAction,
		"cost":           check.Cost,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if check.Owner != Owner {
		return fmt.Errorf("owner must be %q, got %q", Owner, check.Owner)
	}
	if !stableVerifierID.MatchString(check.CheckID) || !stableVerifierID.MatchString(check.GuaranteeID) {
		return errors.New("check and guarantee ids must be stable identifiers")
	}
	if check.ReceiptSchema != ReceiptSchema {
		return fmt.Errorf("receipt_schema must be %q, got %q", ReceiptSchema, check.ReceiptSchema)
	}
	if check.Executor.Kind != "owner_cli" {
		return fmt.Errorf("executor.kind must be owner_cli, got %q", check.Executor.Kind)
	}
	if !stableVerifierID.MatchString(check.Executor.CommandID) {
		return errors.New("executor.command_id must be a stable identifier")
	}
	if err := validateManifestAcquisition(check); err != nil {
		return err
	}
	wantCommand, ok := commandForCheck[check.CheckID]
	if !ok {
		return fmt.Errorf("check_id %q is not implemented by this verifier", check.CheckID)
	}
	if check.Executor.CommandID != wantCommand {
		return fmt.Errorf("executor.command_id %q does not match check %q (want %q)", check.Executor.CommandID, check.CheckID, wantCommand)
	}
	if len(check.Coverage) == 0 {
		return errors.New("coverage must contain at least one entry")
	}
	for _, value := range check.Coverage {
		if strings.TrimSpace(value) == "" {
			return errors.New("coverage entries must not be empty")
		}
	}
	for _, value := range check.Surfaces {
		if strings.TrimSpace(value) == "" {
			return errors.New("surfaces entries must not be empty")
		}
	}
	return nil
}

func validateManifestAcquisition(check manifestCheck) error {
	acquisition := check.Executor.Acquisition
	if acquisition == nil {
		return errors.New("executor.acquisition is required")
	}
	if acquisition.Mode != "owner_self_collect" {
		return fmt.Errorf("executor.acquisition.mode must be owner_self_collect, got %q", acquisition.Mode)
	}
	if acquisition.VerificationSafe == nil {
		return errors.New("executor.acquisition.verification_safe is required")
	}
	if *acquisition.VerificationSafe && !check.SafetyGate {
		return errors.New("executor.acquisition.verification_safe=true requires safety_gate=true")
	}
	if len(acquisition.Inputs) == 0 || len(acquisition.Inputs) > maxManifestInputs {
		return fmt.Errorf("executor.acquisition.inputs must contain 1..%d entries", maxManifestInputs)
	}
	seen := make(map[string]struct{}, len(acquisition.Inputs))
	for index, input := range acquisition.Inputs {
		if !stableVerifierID.MatchString(input.ID) {
			return fmt.Errorf("executor.acquisition.inputs[%d].id must be a stable identifier", index)
		}
		if _, exists := seen[input.ID]; exists {
			return fmt.Errorf("executor.acquisition.inputs contains duplicate id %q", input.ID)
		}
		seen[input.ID] = struct{}{}
		if input.Required == nil {
			return fmt.Errorf("executor.acquisition.inputs[%d].required is required", index)
		}
		switch input.Class {
		case "discoverable", "credential_reference", "verification_fixture", "external_prerequisite":
		default:
			return fmt.Errorf("executor.acquisition.inputs[%d].class is invalid", index)
		}
		switch input.Source {
		case "ecosystem_catalog", "owner_active_config", "owner_service_manager", "owner_operations_api", "owner_fixed_fixture", "owner_external_artifact":
		default:
			return fmt.Errorf("executor.acquisition.inputs[%d].source is invalid", index)
		}
	}
	return nil
}

func selectManifestCheck(manifest ownerManifest, checkID string) (manifestCheck, error) {
	checkID = strings.TrimSpace(checkID)
	if checkID == "" {
		return manifestCheck{}, errors.New("--check-id is required")
	}
	for _, check := range manifest.Checks {
		if check.CheckID == checkID {
			return check, nil
		}
	}
	return manifestCheck{}, fmt.Errorf("check_id %q is not present in manifest", checkID)
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return errors.New("JSON must contain one value")
	} else if err != io.EOF {
		return fmt.Errorf("trailing JSON: %w", err)
	}
	return nil
}

func readBoundedFile(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("path must be a regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := ioReadAllLimit(file, limit)
	if err != nil {
		return nil, err
	}
	return data, nil
}
