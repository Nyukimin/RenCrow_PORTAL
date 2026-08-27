package verify

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

// Main is the process entrypoint used by cmd/rencrow-portal-verify.  It keeps
// parsing and exit mapping testable without invoking os.Exit from unit tests.
func Main(args []string, stdout, stderr io.Writer) int {
	if stdout == nil {
		stdout = io.Discard
	}
	if stderr == nil {
		stderr = io.Discard
	}
	if len(args) == 0 || args[0] != "run" {
		writeUsage(stderr)
		return ExitCLIError
	}
	options, err := parseRunOptions(args[1:], stderr)
	if err != nil {
		fmt.Fprintln(stderr, "rencrow-portal-verify:", err)
		return ExitCLIError
	}
	receipt, runErr := Run(context.Background(), options)
	if runErr != nil {
		fmt.Fprintln(stderr, "rencrow-portal-verify:", runErr)
		return ExitCLIError
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(receipt); err != nil {
		fmt.Fprintln(stderr, "rencrow-portal-verify: write receipt:", err)
		return ExitCLIError
	}
	return ExitCode(receipt.Status)
}

func parseRunOptions(args []string, stderr io.Writer) (Options, error) {
	flags := flag.NewFlagSet("rencrow-portal-verify run", flag.ContinueOnError)
	flags.SetOutput(stderr)
	var options Options
	var authHeader, authToken, authFile, authCookieFile string
	var timeout time.Duration
	flags.StringVar(&options.ManifestPath, "manifest", "", "owner manifest path")
	flags.StringVar(&options.CheckID, "check-id", "", "declared check id")
	flags.StringVar(&options.ObservedAt, "observed-at", "", "RFC3339 UTC observation time")
	flags.StringVar(&options.EvidenceDir, "evidence-dir", "", "bounded evidence directory")
	defaultURL := strings.TrimSpace(os.Getenv("RENCROW_PORTAL_VERIFY_URL"))
	if defaultURL == "" {
		defaultURL = strings.TrimSpace(os.Getenv("RENCROW_PORTAL_URL"))
	}
	if defaultURL == "" {
		defaultURL = defaultPortalURL
	}
	flags.StringVar(&options.PortalURL, "portal-url", defaultURL, "published Portal URL")
	flags.StringVar(&options.PortalURL, "url", defaultURL, "published Portal URL (alias)")
	flags.StringVar(&authHeader, "auth-header", "", "explicit auth header, for example Authorization: Bearer ...")
	flags.StringVar(&authToken, "auth-token", "", "explicit bearer token (not written to evidence)")
	flags.StringVar(&authFile, "auth-file", "", "file containing an explicit bearer token")
	flags.StringVar(&authFile, "auth-token-file", "", "file containing an explicit bearer token (alias)")
	flags.StringVar(&authCookieFile, "auth-cookie-file", "", "file containing an explicit Cookie header value")
	flags.StringVar(&options.BrowserEvidence, "browser-evidence", "", "JSON evidence captured by an actual browser runner")
	flags.StringVar(&options.BrowserEvidence, "browser-input", "", "JSON browser evidence (alias)")
	flags.StringVar(&options.BrowserRunner, "browser-runner", "", "allowlisted runner id, never a shell command")
	flags.StringVar(&options.BrowserName, "browser-name", "", "explicit browser name when the evidence runner omits it")
	flags.StringVar(&options.BrowserPlatform, "browser-platform", "", "explicit browser platform when the evidence runner omits it")
	flags.StringVar(&options.BrowserPlatform, "platform", "", "explicit browser platform (alias)")
	flags.StringVar(&options.SourceEvidence, "source-evidence", "", "source identity evidence JSON")
	flags.StringVar(&options.SourceEvidence, "source", "", "source identity evidence JSON (alias)")
	flags.StringVar(&options.ArtifactEvidence, "artifact-evidence", "", "artifact identity evidence JSON or artifact file")
	flags.StringVar(&options.ArtifactEvidence, "artifact", "", "artifact identity evidence (alias)")
	flags.StringVar(&options.PublicationEvidence, "publication-evidence", "", "publication identity evidence JSON or installed file")
	flags.StringVar(&options.PublicationEvidence, "publication", "", "publication identity evidence (alias)")
	flags.StringVar(&options.RuntimeEvidence, "runtime-evidence", "", "runtime/service identity evidence JSON")
	flags.StringVar(&options.RuntimeEvidence, "runtime-observation", "", "runtime observation JSON (alias)")
	flags.StringVar(&options.RuntimeEvidence, "runtime", "", "runtime observation JSON (alias)")
	flags.DurationVar(&timeout, "timeout", 5*time.Second, "bounded HTTP observation timeout")
	if err := flags.Parse(args); err != nil {
		return Options{}, err
	}
	if flags.NArg() != 0 {
		return Options{}, errors.New("unexpected positional arguments")
	}
	if strings.TrimSpace(options.ManifestPath) == "" || strings.TrimSpace(options.CheckID) == "" || strings.TrimSpace(options.ObservedAt) == "" || strings.TrimSpace(options.EvidenceDir) == "" {
		return Options{}, errors.New("--manifest, --check-id, --observed-at, and --evidence-dir are required")
	}
	if timeout <= 0 {
		return Options{}, errors.New("--timeout must be positive")
	}
	auth, err := parseAuth(authHeader, authToken, authFile, authCookieFile)
	if err != nil {
		return Options{}, err
	}
	options.Auth = auth
	options.HTTPClient = &http.Client{Timeout: timeout}
	return options, nil
}

func parseAuth(header, token, tokenFile, cookieFile string) (Auth, error) {
	provided := 0
	for _, value := range []string{header, token, tokenFile, cookieFile} {
		if strings.TrimSpace(value) != "" {
			provided++
		}
	}
	if provided > 1 {
		return Auth{}, errors.New("choose exactly one of --auth-header, --auth-token, --auth-file, or --auth-cookie-file")
	}
	if strings.TrimSpace(header) != "" {
		name, value, ok := strings.Cut(header, ":")
		if !ok || strings.TrimSpace(name) == "" || strings.TrimSpace(value) == "" {
			return Auth{}, errors.New("--auth-header must be NAME: VALUE")
		}
		return Auth{HeaderName: strings.TrimSpace(name), HeaderValue: strings.TrimSpace(value)}, nil
	}
	if strings.TrimSpace(token) != "" || strings.TrimSpace(tokenFile) != "" {
		value := strings.TrimSpace(token)
		if tokenFile != "" {
			data, err := readSecretFile(tokenFile, 64<<10)
			if err != nil {
				return Auth{}, fmt.Errorf("read auth file: %w", err)
			}
			value = strings.TrimSpace(string(data))
		}
		if value == "" {
			return Auth{}, errors.New("explicit auth token must not be empty")
		}
		if !strings.HasPrefix(strings.ToLower(value), "bearer ") {
			value = "Bearer " + value
		}
		return Auth{HeaderName: "Authorization", HeaderValue: value}, nil
	}
	if strings.TrimSpace(cookieFile) != "" {
		data, err := readSecretFile(cookieFile, 64<<10)
		if err != nil {
			return Auth{}, fmt.Errorf("read auth cookie file: %w", err)
		}
		value := strings.TrimSpace(string(data))
		if value == "" {
			return Auth{}, errors.New("explicit auth cookie must not be empty")
		}
		return Auth{HeaderName: "Cookie", HeaderValue: value}, nil
	}
	return Auth{}, nil
}

func readSecretFile(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("auth file must be a regular non-symlink file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("auth file must be owner-only (mode 0600 or stricter)")
	}
	return readBoundedFile(path, limit)
}

func writeUsage(out io.Writer) {
	fmt.Fprintln(out, "usage: rencrow-portal-verify run --manifest PATH --check-id ID --observed-at RFC3339-UTC --evidence-dir DIR [owner-specific read-only inputs]")
}
