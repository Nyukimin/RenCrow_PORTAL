package verify

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func discoverPortalRuntimeIdentity(observedAt time.Time) (Observation, error) {
	if runtime.GOOS != "linux" {
		return blockedObservation(runtimeTarget, errors.New("automatic Portal runtime observation requires canonical Linux systemd deployment")), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "systemctl", "--user", "show", "rencrow-portal.service", "--no-pager", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "NRestarts").Output()
	if err != nil {
		return blockedObservation(runtimeTarget, errors.New("Portal systemd observation failed")), nil
	}
	properties := parsePortalProperties(string(output))
	pid, pidErr := strconv.Atoi(properties["MainPID"])
	restarts, restartErr := strconv.Atoi(properties["NRestarts"])
	if pidErr != nil || pid <= 0 || restartErr != nil {
		return blockedObservation(runtimeTarget, errors.New("Portal systemd identity is incomplete")), nil
	}
	if properties["ActiveState"] != "active" || properties["SubState"] != "running" || restarts != 0 {
		return Observation{Status: StatusFailed, RouteOrTarget: runtimeTarget, FailureBoundary: "Portal service lifecycle is not stable", Evidence: properties}, nil
	}
	executable, err := filepath.EvalSymlinks(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return blockedObservation(runtimeTarget, errors.New("Portal process executable unavailable")), nil
	}
	cmdlineBytes, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return blockedObservation(runtimeTarget, errors.New("Portal process command line unavailable")), nil
	}
	cmdline := splitPortalCmdline(cmdlineBytes)
	home, err := os.UserHomeDir()
	if err != nil {
		return blockedObservation(runtimeTarget, err), nil
	}
	expectedExecutable := filepath.Join(home, ".local", "bin", "rencrow-portal")
	expectedConfig := filepath.Join(home, ".rencrow", "config", "portal.json")
	if executable != expectedExecutable || len(cmdline) != 3 || cmdline[0] != expectedExecutable || cmdline[1] != "--config" || cmdline[2] != expectedConfig {
		return Observation{Status: StatusFailed, RouteOrTarget: runtimeTarget, FailureBoundary: "Portal process executable or config identity mismatch", Evidence: map[string]any{"pid": pid, "cmdline": cmdline}}, nil
	}
	listenerCtx, listenerCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer listenerCancel()
	listenerOutput, err := exec.CommandContext(listenerCtx, "ss", "-H", "-ltnp", "sport", "=", ":18791").Output()
	if err != nil {
		return blockedObservation(runtimeTarget, errors.New("Portal listener observation failed")), nil
	}
	address, ok := parsePortalListener(string(listenerOutput), pid)
	if !ok {
		return blockedObservation(runtimeTarget, errors.New("Portal loopback listener is not owned by MainPID")), nil
	}
	raw := map[string]any{"observed_at": observedAt.Format(time.RFC3339Nano), "service_name": "rencrow-portal.service", "active": true, "pid": pid, "executable": executable, "config_path": expectedConfig, "listener": map[string]any{"address": address, "bound": true}, "security": map[string]any{"loopback_only": true, "auth_proxy": false}, "service": properties, "cmdline": cmdline}
	if err := validateRuntimeObservation(raw); err != nil {
		return Observation{Status: StatusFailed, RouteOrTarget: runtimeTarget, FailureBoundary: err.Error(), Evidence: raw}, nil
	}
	return Observation{Status: StatusPassed, RouteOrTarget: runtimeTarget, Evidence: raw}, nil
}

func parsePortalProperties(value string) map[string]string {
	result := map[string]string{}
	for _, line := range strings.Split(value, "\n") {
		key, raw, ok := strings.Cut(line, "=")
		if ok && strings.TrimSpace(key) != "" {
			result[strings.TrimSpace(key)] = strings.TrimSpace(raw)
		}
	}
	return result
}
func splitPortalCmdline(value []byte) []string {
	trimmed := strings.TrimRight(string(value), "\x00")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "\x00")
}
func parsePortalListener(output string, pid int) (string, bool) {
	needle := fmt.Sprintf("pid=%d,", pid)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 4 && strings.Contains(line, needle) && fields[3] == "127.0.0.1:18791" {
			return fields[3], true
		}
	}
	return "", false
}
