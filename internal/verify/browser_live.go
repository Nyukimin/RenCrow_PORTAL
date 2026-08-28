package verify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/chromedp"
)

const (
	portalProxyURL       = "http://127.0.0.1:18791"
	tailscaleActorPrefix = "tailscale-sha256:"
	browserRunTimeout    = 5 * time.Minute
)

var liveBrowserEvidenceCollector = collectLiveBrowserEvidence

type tailscaleServeRoute struct {
	Origin string
	Proxy  string
}

type tailscaleServeStatus struct {
	Web map[string]struct {
		Handlers map[string]struct {
			Proxy string `json:"Proxy"`
		} `json:"Handlers"`
	} `json:"Web"`
	AllowFunnel map[string]json.RawMessage `json:"AllowFunnel"`
}

func discoverPublishedPortal(ctx context.Context) (tailscaleServeRoute, error) {
	tailscale, err := exec.LookPath("tailscale")
	if err != nil {
		return tailscaleServeRoute{}, errors.New(browserPrerequisiteError("tailscale CLI"))
	}
	output, err := exec.CommandContext(ctx, tailscale, "serve", "status", "--json").Output()
	if err != nil {
		return tailscaleServeRoute{}, fmt.Errorf("%s: %w", browserPrerequisiteError("tailscale Serve status"), err)
	}
	return parseTailscaleServeStatus(output)
}

func parseTailscaleServeStatus(raw []byte) (tailscaleServeRoute, error) {
	var status tailscaleServeStatus
	if err := json.NewDecoder(bytes.NewReader(raw)).Decode(&status); err != nil {
		return tailscaleServeRoute{}, fmt.Errorf("decode tailscale Serve status: %w", err)
	}
	var routes []tailscaleServeRoute
	for hostPort, web := range status.Web {
		handler, ok := web.Handlers["/"]
		if !ok || strings.TrimRight(handler.Proxy, "/") != portalProxyURL {
			continue
		}
		if _, exposed := status.AllowFunnel[hostPort]; exposed {
			return tailscaleServeRoute{}, errors.New("Portal Tailscale route has Funnel enabled")
		}
		host, port, err := net.SplitHostPort(hostPort)
		if err != nil || port != "443" || !strings.HasSuffix(strings.ToLower(host), ".ts.net") {
			continue
		}
		routes = append(routes, tailscaleServeRoute{Origin: "https://" + host, Proxy: portalProxyURL})
	}
	if len(routes) != 1 {
		return tailscaleServeRoute{}, fmt.Errorf("expected exactly one tailnet-only Portal Serve route, found %d", len(routes))
	}
	return routes[0], nil
}

func discoverChromium() (string, error) {
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "msedge"} {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	var patterns []string
	if root := strings.TrimSpace(os.Getenv("PLAYWRIGHT_BROWSERS_PATH")); root != "" {
		patterns = append(patterns, chromiumCandidates(root)...)
	}
	if home, err := os.UserHomeDir(); err == nil {
		patterns = append(patterns, chromiumCandidates(filepath.Join(home, ".cache", "ms-playwright"))...)
		patterns = append(patterns, filepath.Join(home, "Library", "Caches", "ms-playwright", "chromium-*", "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"))
	}
	if localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); localAppData != "" {
		patterns = append(patterns, chromiumCandidates(filepath.Join(localAppData, "ms-playwright"))...)
	}
	var matches []string
	for _, pattern := range patterns {
		found, _ := filepath.Glob(pattern)
		for _, path := range found {
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				matches = append(matches, path)
			}
		}
	}
	if len(matches) == 0 {
		return "", errors.New(browserPrerequisiteError("Chromium executable"))
	}
	sort.Strings(matches)
	return matches[len(matches)-1], nil
}

func chromiumCandidates(root string) []string {
	return []string{
		filepath.Join(root, "chromium-*", "chrome-linux", "chrome"),
		filepath.Join(root, "chromium-*", "chrome-linux64", "chrome"),
		filepath.Join(root, "chromium-*", "chrome-win", "chrome.exe"),
		filepath.Join(root, "chromium-*", "chrome-win64", "chrome.exe"),
	}
}

func validateTailscaleActorHeader(value string) error {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, tailscaleActorPrefix) || len(value) != len(tailscaleActorPrefix)+64 {
		return errors.New("Portal response did not provide a bounded Tailscale actor")
	}
	for _, character := range strings.TrimPrefix(value, tailscaleActorPrefix) {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return errors.New("Portal Tailscale actor digest is invalid")
		}
	}
	return nil
}

func browserPlatformEvidence() string { return runtime.GOOS }

func browserPrerequisiteError(name string) string {
	return strings.TrimSpace(name) + " prerequisite is unavailable"
}

type capturedBrowserResponse struct {
	RequestID network.RequestID
	Status    int64
}

func collectLiveBrowserEvidence(parent context.Context, observedAt time.Time) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(parent, browserRunTimeout)
	defer cancel()
	route, err := discoverPublishedPortal(ctx)
	if err != nil {
		return nil, err
	}
	chromium, err := discoverChromium()
	if err != nil {
		return nil, err
	}
	allocator, cancelAllocator := chromedp.NewExecAllocator(ctx, append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chromium), chromedp.Flag("headless", true), chromedp.Flag("disable-gpu", true))...)
	defer cancelAllocator()
	browser, cancelBrowser := chromedp.NewContext(allocator)
	defer cancelBrowser()

	var mu sync.Mutex
	actor := ""
	accepted := capturedBrowserResponse{}
	chromedp.ListenTarget(browser, func(event any) {
		response, ok := event.(*network.EventResponseReceived)
		if !ok {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if response.Type == network.ResourceTypeDocument && strings.HasPrefix(response.Response.URL, route.Origin+"/") {
			for name, value := range response.Response.Headers {
				if strings.EqualFold(name, "X-RenCrow-Authenticated-Actor") {
					actor = fmt.Sprint(value)
				}
			}
		}
		if parsed, parseErr := url.Parse(response.Response.URL); parseErr == nil && parsed.Path == browserSendPath {
			accepted = capturedBrowserResponse{RequestID: response.RequestID, Status: response.Response.Status}
		}
	})

	prompt := fmt.Sprintf("PORTAL E2E %s: Mio、短く『PORTAL確認完了』と返答して。", observedAt.UTC().Format("20060102T150405.000000000Z"))
	var initialArticles int64
	if err := chromedp.Run(browser,
		network.Enable(),
		chromedp.Navigate(route.Origin+"/?mode=Chat"),
		chromedp.WaitVisible(`#roomInput`, chromedp.ByQuery),
	); err != nil {
		return nil, fmt.Errorf("published Portal browser authentication failed: %w", err)
	}
	mu.Lock()
	observedActor := actor
	mu.Unlock()
	if err := validateTailscaleActorHeader(observedActor); err != nil {
		return nil, err
	}
	if err := chromedp.Run(browser,
		chromedp.Evaluate(`localStorage.setItem('rencrow.portal.ttsPreference','off')`, nil),
		chromedp.Evaluate(`document.querySelectorAll('#chat article').length`, &initialArticles),
		chromedp.Click(`#roomMioChip`, chromedp.ByQuery),
		chromedp.SetValue(`#roomInput`, prompt, chromedp.ByQuery),
		chromedp.KeyEvent("\r"),
	); err != nil {
		return nil, fmt.Errorf("published Portal browser interaction failed: %w", err)
	}

	deadline := time.Now().Add(30 * time.Second)
	for {
		mu.Lock()
		capture := accepted
		mu.Unlock()
		if capture.RequestID != "" {
			break
		}
		if time.Now().After(deadline) {
			return nil, errors.New("Portal browser did not observe the allowlisted send response")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	mu.Lock()
	capture := accepted
	mu.Unlock()
	if capture.Status < 200 || capture.Status >= 300 {
		return nil, fmt.Errorf("Portal send returned HTTP %d", capture.Status)
	}

	var responseBody []byte
	for attempts := 0; attempts < 20; attempts++ {
		responseBody, err = network.GetResponseBody(capture.RequestID).Do(browser)
		if err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return nil, fmt.Errorf("read Portal send receipt: %w", err)
	}
	var acceptedObject map[string]any
	if err := json.Unmarshal(responseBody, &acceptedObject); err != nil {
		return nil, fmt.Errorf("decode Portal send receipt: %w", err)
	}
	jobID := firstString(acceptedObject, "job_id", "jobID")
	if jobID == "" {
		return nil, errors.New("Portal send receipt is missing CORE job_id")
	}

	var visibleText string
	waitExpression := fmt.Sprintf(`document.querySelectorAll('#chat article').length > %d && document.getElementById('operationStatus').textContent.includes('応答を受信しました')`, initialArticles)
	responseContext, cancelResponse := context.WithTimeout(browser, 4*time.Minute)
	defer cancelResponse()
	if err := chromedp.Run(responseContext,
		chromedp.Poll(waitExpression, nil, chromedp.WithPollingInterval(500*time.Millisecond)),
		chromedp.Evaluate(`(() => { const items = document.querySelectorAll('#chat article'); return items.length ? items[items.length - 1].innerText.trim() : ''; })()`, &visibleText),
	); err != nil {
		return nil, fmt.Errorf("real CORE Agent response was not rendered by Portal: %w", err)
	}
	visibleText = strings.TrimSpace(visibleText)
	if visibleText == "" || strings.Contains(visibleText, prompt) {
		return nil, errors.New("Portal did not render a distinct Agent response")
	}

	return map[string]any{
		"observed_at": observedAt.UTC().Format(time.RFC3339Nano), "browser": "Chromium", "platform": browserPlatformEvidence(),
		"authenticated": true, "auth_method": "tailscale_serve", "authenticated_user": observedActor, "actor": observedActor,
		"portal_url": route.Origin, "published": true,
		"request":   map[string]any{"method": "POST", "url": route.Origin + browserSendPath, "path": browserSendPath},
		"core_path": browserCoreSendPath,
		"response":  map[string]any{"status": capture.Status, "job_id": jobID, "trace_id": jobID, "user_visible_result": visibleText},
		"job_id":    jobID, "trace_id": jobID, "user_visible_result": visibleText,
	}, nil
}
