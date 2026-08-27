package verify

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const evidenceFreshnessWindow = 5 * time.Minute

// evidenceFresh keeps an observation inside the inclusive window anchored by
// the caller's requested receipt time.  It deliberately does not compare to
// wall-clock time: a receipt is a statement about one requested observation,
// not an invitation to accept whatever happens to be current while running.
func evidenceFresh(evidenceObserved, requested time.Time) bool {
	if requested.IsZero() || evidenceObserved.IsZero() {
		return false
	}
	lowerBound := requested.Add(-evidenceFreshnessWindow)
	return !evidenceObserved.Before(lowerBound) && !evidenceObserved.After(requested)
}

func validateFreshStructuredEvidence(object map[string]any, requested time.Time) error {
	value, ok := object["observed_at"]
	if !ok {
		return errors.New("structured evidence is missing observed_at")
	}
	observedAt, ok := value.(string)
	if !ok || strings.TrimSpace(observedAt) == "" {
		return errors.New("structured evidence observed_at must be an RFC3339 UTC string")
	}
	parsed, err := parseObservedAt(observedAt)
	if err != nil {
		return fmt.Errorf("structured evidence observed_at: %w", err)
	}
	if !evidenceFresh(parsed, requested) {
		return errors.New("structured evidence observed_at is stale or in the future")
	}
	return nil
}

func readFreshStructuredEvidence(path string, requested time.Time) (map[string]any, error) {
	data, err := readBoundedFile(path, maxEvidenceBytes)
	if err != nil {
		return nil, err
	}
	object, err := decodeObject(data)
	if err != nil {
		return nil, err
	}
	if err := validateFreshStructuredEvidence(object, requested); err != nil {
		return nil, err
	}
	return object, nil
}

// digestFreshArtifactFile is used only for the concrete artifact and
// publication files in the deploy identity chain.  Their bytes do not carry
// structured observed_at, so the regular file's actual mtime is the bounded
// freshness evidence after digesting it.
func digestFreshArtifactFile(path string, requested time.Time) (string, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return "", errors.New("artifact/publication path must be a regular non-symlink file")
	}
	if !evidenceFresh(before.ModTime().UTC(), requested) {
		return "", errors.New("artifact/publication file mtime is stale or in the future")
	}
	digest, err := digestFile(path)
	if err != nil {
		return "", err
	}
	after, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if after.Mode()&os.ModeSymlink != 0 || !after.Mode().IsRegular() {
		return "", errors.New("artifact/publication path changed from a regular non-symlink file")
	}
	if !os.SameFile(before, after) {
		return "", errors.New("artifact/publication file changed while it was being observed")
	}
	if !evidenceFresh(after.ModTime().UTC(), requested) {
		return "", errors.New("artifact/publication file mtime is stale or in the future")
	}
	return digest, nil
}

func decodeObject(data []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var object map[string]any
	if err := decoder.Decode(&object); err != nil {
		return nil, err
	}
	if object == nil {
		return nil, errors.New("JSON response must be an object")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, errors.New("JSON response contains trailing values")
		}
		return nil, err
	}
	return object, nil
}

func stringField(object map[string]any, key string) (string, bool) {
	if object == nil {
		return "", false
	}
	want := normalizeFieldName(key)
	for candidate, value := range object {
		if normalizeFieldName(candidate) != want {
			continue
		}
		if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text), true
		}
	}
	return "", false
}

func boolField(object map[string]any, key string) (bool, bool) {
	value, ok := fieldValue(object, key)
	if !ok {
		return false, false
	}
	return boolValue(value)
}

func firstString(value any, keys ...string) string {
	if len(keys) == 0 {
		return ""
	}
	wanted := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		wanted[normalizeFieldName(key)] = struct{}{}
	}
	return findString(value, wanted, 0)
}

func findString(value any, wanted map[string]struct{}, depth int) string {
	if depth > 10 {
		return ""
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if _, ok := wanted[normalizeFieldName(key)]; !ok {
				continue
			}
			if text, ok := child.(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
		for _, child := range typed {
			if text := findString(child, wanted, depth+1); text != "" {
				return text
			}
		}
	case []any:
		for _, child := range typed {
			if text := findString(child, wanted, depth+1); text != "" {
				return text
			}
		}
	}
	return ""
}

func firstBool(value any, keys ...string) (bool, bool) {
	wanted := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		wanted[normalizeFieldName(key)] = struct{}{}
	}
	return findBool(value, wanted, 0)
}

func findBool(value any, wanted map[string]struct{}, depth int) (bool, bool) {
	if depth > 10 {
		return false, false
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if _, ok := wanted[normalizeFieldName(key)]; !ok {
				continue
			}
			if result, ok := boolValue(child); ok {
				return result, true
			}
		}
		for _, child := range typed {
			if result, ok := findBool(child, wanted, depth+1); ok {
				return result, true
			}
		}
	case []any:
		for _, child := range typed {
			if result, ok := findBool(child, wanted, depth+1); ok {
				return result, true
			}
		}
	}
	return false, false
}

func boolValue(value any) (bool, bool) {
	switch typed := value.(type) {
	case bool:
		return typed, true
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true", "yes", "ok", "ready", "active", "running", "1":
			return true, true
		case "false", "no", "fail", "failed", "unavailable", "inactive", "0":
			return false, true
		}
	case json.Number:
		if typed == "1" {
			return true, true
		}
		if typed == "0" {
			return false, true
		}
	}
	return false, false
}

func firstInteger(value any, keys ...string) (int64, bool) {
	wanted := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		wanted[normalizeFieldName(key)] = struct{}{}
	}
	return findInteger(value, wanted, 0)
}

func findInteger(value any, wanted map[string]struct{}, depth int) (int64, bool) {
	if depth > 10 {
		return 0, false
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if _, ok := wanted[normalizeFieldName(key)]; !ok {
				continue
			}
			if result, ok := parseInteger(child); ok {
				return result, true
			}
		}
		for _, child := range typed {
			if result, ok := findInteger(child, wanted, depth+1); ok {
				return result, true
			}
		}
	case []any:
		for _, child := range typed {
			if result, ok := findInteger(child, wanted, depth+1); ok {
				return result, true
			}
		}
	}
	return 0, false
}

func firstMap(value any, keys ...string) map[string]any {
	wanted := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		wanted[normalizeFieldName(key)] = struct{}{}
	}
	return findMap(value, wanted, 0)
}

func findMap(value any, wanted map[string]struct{}, depth int) map[string]any {
	if depth > 10 {
		return nil
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if _, ok := wanted[normalizeFieldName(key)]; !ok {
				continue
			}
			if result, ok := child.(map[string]any); ok {
				return result
			}
		}
		for _, child := range typed {
			if result := findMap(child, wanted, depth+1); result != nil {
				return result
			}
		}
	case []any:
		for _, child := range typed {
			if result := findMap(child, wanted, depth+1); result != nil {
				return result
			}
		}
	}
	return nil
}

func firstSlice(value any, keys ...string) []any {
	wanted := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		wanted[normalizeFieldName(key)] = struct{}{}
	}
	return findSlice(value, wanted, 0)
}

func findSlice(value any, wanted map[string]struct{}, depth int) []any {
	if depth > 10 {
		return nil
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if _, ok := wanted[normalizeFieldName(key)]; !ok {
				continue
			}
			if result, ok := child.([]any); ok {
				return result
			}
		}
		for _, child := range typed {
			if result := findSlice(child, wanted, depth+1); result != nil {
				return result
			}
		}
	case []any:
		for _, child := range typed {
			if result := findSlice(child, wanted, depth+1); result != nil {
				return result
			}
		}
	}
	return nil
}

func fieldValue(object map[string]any, key string) (any, bool) {
	if object == nil {
		return nil, false
	}
	want := normalizeFieldName(key)
	for candidate, value := range object {
		if normalizeFieldName(candidate) == want {
			return value, true
		}
	}
	return nil, false
}

func normalizeFieldName(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "_", "")
	value = strings.ReplaceAll(value, "-", "")
	value = strings.ReplaceAll(value, " ", "")
	return value
}

func formatEvidenceError(label string, err error) error {
	if err == nil {
		return errors.New(label)
	}
	return fmt.Errorf("%s: %w", label, err)
}
