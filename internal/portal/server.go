package portal

import (
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

//go:embed web/*
var webFiles embed.FS

type handler struct {
	cfg       Config
	coreURL   *url.URL
	proxy     *httputil.ReverseProxy
	page      *template.Template
	assets    http.Handler
	readiness *http.Client
}

type pageData struct {
	Mode      Mode
	Surface   string
	BodyClass string
}

// NewHandlerはPORTALのHTTP handlerを構築する。
func NewHandler(cfg Config) (http.Handler, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	coreURL, err := url.Parse(cfg.CoreURL)
	if err != nil {
		return nil, fmt.Errorf("core_urlを解析する: %w", err)
	}
	pageBytes, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		return nil, fmt.Errorf("PORTAL HTMLを読む: %w", err)
	}
	page, err := template.New("index").Parse(string(pageBytes))
	if err != nil {
		return nil, fmt.Errorf("PORTAL HTMLを解析する: %w", err)
	}
	assetFS, err := fs.Sub(webFiles, "web")
	if err != nil {
		return nil, fmt.Errorf("PORTAL asset FSを作る: %w", err)
	}
	h := &handler{
		cfg:       cfg,
		coreURL:   coreURL,
		page:      page,
		assets:    http.FileServer(http.FS(assetFS)),
		readiness: &http.Client{Timeout: 3 * time.Second},
	}
	h.proxy = &httputil.ReverseProxy{
		Director:      h.directProxyRequest,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
			http.Error(w, "COREへ接続できません: "+proxyErr.Error(), http.StatusBadGateway)
		},
	}
	return h, nil
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w)
	switch {
	case r.URL.Path == "/" || r.URL.Path == "/view" || r.URL.Path == "/live" || r.URL.Path == "/lab":
		h.servePage(w, r)
	case r.URL.Path == "/health/live":
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "rencrow-portal"})
	case r.URL.Path == "/health/ready":
		h.serveReadiness(w, r)
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/assets")
		h.assets.ServeHTTP(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/"):
		h.serveAPI(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *handler) servePage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	mode := h.modeFromRequest(r)
	if !h.cfg.modeEnabled(mode) {
		http.Error(w, "mode is disabled", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	data := pageData{
		Mode:      mode,
		Surface:   "lab",
		BodyClass: "theme-modern live-mode lab-mode lab-chat-mode lab-partner-shiro portal-view-mode",
	}
	if mode == ModeLab {
		data.BodyClass = "theme-modern live-mode lab-mode lab-chat-mode lab-partner-shiro"
	}
	if mode == ModeLive {
		data.Surface = "live"
		data.BodyClass = "theme-modern live-mode portal-live-mode"
	}
	if err := h.page.Execute(w, data); err != nil {
		http.Error(w, "PORTAL HTMLを生成できません", http.StatusInternalServerError)
	}
}

func (h *handler) modeFromRequest(r *http.Request) Mode {
	raw := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("mode")))
	if raw == "" {
		raw = strings.Trim(strings.ToLower(r.URL.Path), "/")
	}
	mode := Mode(raw)
	if mode != ModeView && mode != ModeLive && mode != ModeLab {
		return h.cfg.DefaultMode
	}
	return mode
}

func (h *handler) serveAPI(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/")
	modeText, targetPath, ok := strings.Cut(rest, "/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	mode := Mode(strings.ToLower(modeText))
	targetPath = "/" + targetPath
	if !h.cfg.modeEnabled(mode) {
		http.Error(w, "mode is disabled", http.StatusForbidden)
		return
	}
	if !portalEndpointAllowed(mode, r.Method, targetPath) {
		http.Error(w, "このmodeでは許可されていない操作です", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodPost || targetPath == "/stt" {
		if !sameOriginOrNonBrowser(r) {
			http.Error(w, "cross-origin controlは許可されていません", http.StatusForbidden)
			return
		}
	}
	if r.Method == http.MethodPost {
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	}
	r.URL.Path = targetPath
	h.proxy.ServeHTTP(w, r)
}

func portalEndpointAllowed(mode Mode, method, path string) bool {
	readEndpoints := map[string]bool{
		"/health":                  true,
		"/viewer/events":           true,
		"/viewer/idlechat/status":  true,
		"/viewer/runtime-config":   true,
		"/viewer/character-states": true,
	}
	if method == http.MethodGet && readEndpoints[path] {
		return true
	}
	if mode != ModeLab {
		return false
	}
	if method == http.MethodGet {
		switch path {
		case "/viewer/tts/audio", "/stt":
			return true
		default:
			return false
		}
	}
	if method != http.MethodPost {
		return false
	}
	switch path {
	case "/viewer/send",
		"/viewer/idlechat/start",
		"/viewer/idlechat/stop",
		"/viewer/recipient-selection",
		"/viewer/active-control",
		"/viewer/tts/playback-ack":
		return true
	default:
		return false
	}
}

func (h *handler) directProxyRequest(r *http.Request) {
	originalHost := r.Host
	r.URL.Scheme = h.coreURL.Scheme
	r.URL.Host = h.coreURL.Host
	r.Host = h.coreURL.Host
	r.Header.Set("X-Forwarded-Host", originalHost)
	r.Header.Set("X-RenCrow-Client", "RenCrow_PORTAL")
}

func sameOriginOrNonBrowser(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return false
	}
	return strings.EqualFold(parsed.Host, r.Host)
}

func (h *handler) serveReadiness(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, strings.TrimRight(h.cfg.CoreURL, "/")+"/health", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	response, err := h.readiness.Do(request)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "core": "unreachable"})
		return
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "core_status": response.StatusCode})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "core": "ready"})
}

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
