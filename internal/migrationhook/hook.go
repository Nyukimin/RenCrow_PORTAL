// Package migrationhook implements the bounded Workspace migration contract
// owned by RenCrow_PORTAL. PORTAL has no durable server-side application state.
package migrationhook

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/Nyukimin/RenCrow_PORTAL/internal/portal"
)

const (
	MaxDocumentBytes        = 64 * 1024
	RequestContractVersion  = "rencrow-migration-owner-hook-request/v1"
	ResponseContractVersion = "rencrow-migration-owner-hook/v1"
	Owner                   = "RenCrow_PORTAL"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type request struct {
	ContractVersion string  `json:"contract_version"`
	Owner           string  `json:"owner"`
	Operation       string  `json:"operation"`
	RequestID       string  `json:"request_id"`
	CandidateConfig *string `json:"candidate_config,omitempty"`
}

type Failure struct {
	Code     string `json:"code"`
	Boundary string `json:"boundary"`
}

type Artifact struct{}

type Receipt struct {
	ContractVersion string         `json:"contract_version"`
	Owner           string         `json:"owner"`
	Operation       string         `json:"operation"`
	RequestID       string         `json:"request_id"`
	Status          string         `json:"status"`
	ConfigValid     bool           `json:"config_valid,omitempty"`
	StateClass      string         `json:"state_class,omitempty"`
	SchemaRevision  string         `json:"schema_revision,omitempty"`
	ConsistencyMode string         `json:"consistency_mode,omitempty"`
	Artifact        *Artifact      `json:"artifact"`
	Counts          map[string]int `json:"counts"`
	Failure         *Failure       `json:"failure"`
}

func Execute(stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	value, err := decodeRequest(stdin)
	if err != nil || validateRequest(value) != nil {
		fmt.Fprintln(stderr, "[NG] invalid migration-hook request")
		return 2
	}
	receipt := Receipt{
		ContractVersion: ResponseContractVersion,
		Owner:           Owner,
		Operation:       value.Operation,
		RequestID:       value.RequestID,
		Counts:          map[string]int{},
	}
	switch value.Operation {
	case "config_validate":
		if value.CandidateConfig == nil || strings.TrimSpace(*value.CandidateConfig) == "" {
			fmt.Fprintln(stderr, "[NG] invalid migration-hook request")
			return 2
		}
		info, statErr := os.Lstat(*value.CandidateConfig)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return rejectConfig(stdout, stderr, receipt)
		}
		if _, loadErr := portal.LoadConfig(*value.CandidateConfig); loadErr != nil {
			return rejectConfig(stdout, stderr, receipt)
		}
		receipt.Status = "completed"
		receipt.ConfigValid = true
	case "state_describe":
		if value.CandidateConfig != nil {
			fmt.Fprintln(stderr, "[NG] invalid migration-hook request")
			return 2
		}
		receipt.Status = "completed"
		receipt.StateClass = "none"
		receipt.SchemaRevision = "none"
		receipt.ConsistencyMode = "none"
	default:
		fmt.Fprintln(stderr, "[NG] unsupported migration-hook operation")
		return 2
	}
	if err := writeReceipt(stdout, receipt); err != nil {
		fmt.Fprintln(stderr, "[NG] migration-hook receipt unavailable")
		return 30
	}
	return 0
}

func rejectConfig(stdout io.Writer, stderr io.Writer, receipt Receipt) int {
	receipt.Status = "rejected"
	receipt.Failure = &Failure{Code: "config_invalid", Boundary: "candidate_config"}
	if err := writeReceipt(stdout, receipt); err != nil {
		fmt.Fprintln(stderr, "[NG] migration-hook receipt unavailable")
		return 30
	}
	fmt.Fprintln(stderr, "[NG] candidate config rejected")
	return 10
}

func decodeRequest(input io.Reader) (request, error) {
	data, err := io.ReadAll(io.LimitReader(input, MaxDocumentBytes+1))
	if err != nil || len(data) == 0 || len(data) > MaxDocumentBytes {
		return request{}, errors.New("request size is invalid")
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	var value request
	if err := decoder.Decode(&value); err != nil {
		return request{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return request{}, errors.New("request must contain exactly one JSON object")
	}
	return value, nil
}

func validateRequest(value request) error {
	if value.ContractVersion != RequestContractVersion || value.Owner != Owner || !requestIDPattern.MatchString(value.RequestID) {
		return errors.New("request identity is invalid")
	}
	return nil
}

func writeReceipt(output io.Writer, receipt Receipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if len(data) > MaxDocumentBytes {
		return errors.New("receipt exceeds bounded size")
	}
	written, err := output.Write(data)
	if err == nil && written != len(data) {
		return io.ErrShortWrite
	}
	return err
}
