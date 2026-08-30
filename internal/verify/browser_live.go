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
	portalProxyURL                     = "http://127.0.0.1:18791"
	tailscaleActorPrefix               = "tailscale-sha256:"
	browserRunTimeout                  = 5 * time.Minute
	browserSendCaptureTimeout          = 90 * time.Second
	taggedBrowserBoundary              = "external_untagged_browser_prerequisite_absent"
	portalBrowserPreferencesExpression = `localStorage.setItem('roomConversation.selectedPartner','mio'); localStorage.setItem('rencrow.portal.ttsPreference','off')`
	surfaceReadyExpression             = `!document.querySelector('#roomInput').disabled && !document.querySelector('#roomMioChip').disabled`
	mioReadyExpression                 = `document.querySelector('#roomMioChip').getAttribute('aria-pressed') === 'true' && !document.querySelector('#roomMioChip').disabled && !document.querySelector('#roomInput').disabled`
	submitMessageExpression            = `document.querySelector('#roomInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`
	portalAgentResponsePageFunction    = `function(jobID) {
  const items = document.querySelectorAll('#chat article');
  for (const item of items) {
    if (item.getAttribute('data-job-id') !== String(jobID)) continue;
    if (item.getAttribute('data-event-type') !== 'agent.response') continue;
    const text = item.innerText.trim();
    if (text) return text;
  }
  return false;
}`
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
	tailscale, err := discoverTailscaleCLI()
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
	if runtime.GOOS == "darwin" {
		patterns = append(patterns,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		)
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

func validatePortalAgentResponseText(visibleText string) error {
	if strings.TrimSpace(visibleText) == "" {
		return errors.New("Portal did not render a distinct Agent response")
	}
	return nil
}

type capturedBrowserResponse struct {
	RequestID network.RequestID
	Status    int64
}

func collectLiveBrowserEvidence(parent context.Context, observedAt time.Time, publishedURL, checkID string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(parent, browserRunTimeout)
	defer cancel()
	var route tailscaleServeRoute
	preferred := strings.TrimRight(strings.TrimSpace(publishedURL), "/")
	if strings.HasPrefix(preferred, "https://") {
		parsed, err := validatePortalURL(preferred)
		if err != nil || !strings.HasSuffix(strings.ToLower(parsed.Hostname()), ".ts.net") {
			return nil, errors.New("published Portal URL must be an HTTPS Tailscale Serve origin")
		}
		route = tailscaleServeRoute{Origin: preferred, Proxy: portalProxyURL}
	} else {
		var err error
		route, err = discoverPublishedPortal(ctx)
		if err != nil {
			return nil, err
		}
	}
	tagged, err := localTailscaleSourceIsTagged(ctx)
	if err != nil {
		return nil, err
	}
	if tagged {
		return collectRemoteBrowserEvidence(ctx, observedAt, checkID)
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
	var sentRequestID network.RequestID
	accepted := capturedBrowserResponse{}
	chromedp.ListenTarget(browser, func(event any) {
		mu.Lock()
		defer mu.Unlock()
		switch observed := event.(type) {
		case *network.EventRequestWillBeSent:
			if parsed, parseErr := url.Parse(observed.Request.URL); parseErr == nil && parsed.Path == browserSendPath {
				sentRequestID = observed.RequestID
			}
		case *network.EventResponseReceived:
			if observed.Type == network.ResourceTypeDocument && strings.HasPrefix(observed.Response.URL, route.Origin+"/") {
				for name, value := range observed.Response.Headers {
					if strings.EqualFold(name, "X-RenCrow-Authenticated-Actor") {
						actor = fmt.Sprint(value)
					}
				}
			}
			if sentRequestID != "" && observed.RequestID == sentRequestID {
				accepted = capturedBrowserResponse{RequestID: observed.RequestID, Status: observed.Response.Status}
			}
		}
	})

	prompt := fmt.Sprintf("PORTAL E2E %s: Mio、短く『PORTAL確認完了』と返答して。", observedAt.UTC().Format("20060102T150405.000000000Z"))
	if err := chromedp.Run(browser,
		network.Enable(),
		chromedp.Navigate(route.Origin+"/health/live"),
		chromedp.Evaluate(portalBrowserPreferencesExpression, nil),
		chromedp.Navigate(route.Origin+"/?mode=Chat"),
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
		chromedp.WaitVisible(`#roomInput`, chromedp.ByQuery),
		chromedp.Poll(surfaceReadyExpression, nil, chromedp.WithPollingInterval(200*time.Millisecond), chromedp.WithPollingTimeout(45*time.Second)),
	); err != nil {
		return nil, fmt.Errorf("published Portal surface did not become ready: %w", err)
	}
	if err := chromedp.Run(browser,
		chromedp.Poll(mioReadyExpression, nil, chromedp.WithPollingInterval(200*time.Millisecond), chromedp.WithPollingTimeout(45*time.Second)),
		chromedp.SetValue(`#roomInput`, prompt, chromedp.ByQuery),
		chromedp.Evaluate(submitMessageExpression, nil),
	); err != nil {
		return nil, fmt.Errorf("published Portal browser interaction failed: %w", err)
	}

	deadline := time.Now().Add(browserSendCaptureTimeout)
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
		err = chromedp.Run(browser, chromedp.ActionFunc(func(actionContext context.Context) error {
			var bodyErr error
			responseBody, bodyErr = network.GetResponseBody(capture.RequestID).Do(actionContext)
			return bodyErr
		}))
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
	responseContext, cancelResponse := context.WithTimeout(browser, 4*time.Minute)
	defer cancelResponse()
	if err := chromedp.Run(responseContext,
		chromedp.PollFunction(portalAgentResponsePageFunction, &visibleText, chromedp.WithPollingArgs(jobID), chromedp.WithPollingInterval(500*time.Millisecond), chromedp.WithPollingTimeout(4*time.Minute)),
	); err != nil {
		return nil, fmt.Errorf("real CORE Agent response was not rendered by Portal: %w", err)
	}
	visibleText = strings.TrimSpace(visibleText)
	if err := validatePortalAgentResponseText(visibleText); err != nil {
		return nil, err
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

func localTailscaleSourceIsTagged(ctx context.Context) (bool, error) {
	tailscale, err := discoverTailscaleCLI()
	if err != nil {
		return false, errors.New(browserPrerequisiteError("tailscale CLI"))
	}
	output, err := exec.CommandContext(ctx, tailscale, "status", "--json").Output()
	if err != nil {
		return false, fmt.Errorf("%s: %w", browserPrerequisiteError("tailscale node identity"), err)
	}
	var status struct {
		Self struct {
			Tags []string `json:"Tags"`
		} `json:"Self"`
	}
	if err := json.Unmarshal(output, &status); err != nil {
		return false, fmt.Errorf("decode tailscale node identity: %w", err)
	}
	return len(status.Self.Tags) > 0, nil
}

func discoverTailscaleCLI() (string, error) {
	if path, err := exec.LookPath("tailscale"); err == nil {
		return path, nil
	}
	if runtime.GOOS == "darwin" {
		const appCLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if info, err := os.Stat(appCLI); err == nil && !info.IsDir() {
			return appCLI, nil
		}
	}
	return "", errors.New(browserPrerequisiteError("tailscale CLI"))
}
