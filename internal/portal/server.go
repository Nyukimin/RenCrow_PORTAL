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

const (
	interactionProfileHeader = "X-RenCrow-Interaction-Profile"
	controlBodyLimit         = 2 << 20
	viewerSendBodyLimit      = 121 << 20
)

type handler struct {
	cfg       Config
	coreURL   *url.URL
	proxy     *httputil.ReverseProxy
	page      *template.Template
	assets    http.Handler
	readiness *http.Client
}

type pageData struct {
	Mode                  Mode
	Surface               string
	BodyClass             string
	HTMLClass             string
	ShowCharacterSwitcher bool
	ShowChatAvatar        bool
	ShowKuroMidoriAvatars bool
}

// NewHandlerはPORTALのHTTP handlerを構築する。
func NewHandler(cfg Config) (http.Handler, error) {
	cfg = cfg.normalized()
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
		ModifyResponse: func(response *http.Response) error {
			if response.Request != nil && response.Request.URL.Path == "/viewer/games/observer" {
				response.Header.Del("Content-Security-Policy")
				response.Header.Del("Referrer-Policy")
				response.Header.Del("X-Content-Type-Options")
				response.Header.Del("X-Frame-Options")
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
			http.Error(w, "COREへ接続できません: "+proxyErr.Error(), http.StatusBadGateway)
		},
	}
	// PORTAL が自身で拒否したリクエストと CORE へ到達できなかったリクエストは
	// CORE のログに現れない。PORTAL が唯一の証拠元であるため記録する。
	return withAccessLog(newAccessLogger(nil), h), nil
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w)
	switch {
	case r.URL.Path == "/" || r.URL.Path == "/idlechat" || r.URL.Path == "/chat" || r.URL.Path == "/games":
		h.servePage(w, r)
	case r.URL.Path == "/health/live":
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "status": "live", "service": "rencrow-portal", "runtime": "go",
		})
	case r.URL.Path == "/health/ready":
		h.serveReadiness(w, r)
	case strings.HasPrefix(r.URL.Path, "/assets/"):
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/assets")
		h.assets.ServeHTTP(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/"):
		h.serveAPI(w, r)
	case r.URL.Path == "/viewer/games/observer" || strings.HasPrefix(r.URL.Path, "/viewer/games/observer-api/"):
		h.serveGamesObserverProxy(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (h *handler) servePage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	mode, ok := h.modeFromRequest(r)
	if !ok || !h.cfg.modeEnabled(mode) {
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
		Mode:                  mode,
		Surface:               string(mode),
		BodyClass:             "theme-modern portal-room-mode room-stage room-mode room-chat-mode room-partner-shiro",
		HTMLClass:             "portal-chat-fixed-canvas",
		ShowCharacterSwitcher: mode == ModeChat,
		ShowChatAvatar:        mode == ModeChat,
		ShowKuroMidoriAvatars: mode != ModeIdleChat,
	}
	if mode == ModeIdleChat {
		data.BodyClass = "theme-modern portal-room-mode room-stage room-mode room-idlechat-mode room-partner-shiro portal-idlechat-mode"
	}
	if mode == ModeGames {
		data.BodyClass = "theme-modern portal-games-mode"
		data.HTMLClass = ""
	}
	if err := h.page.Execute(w, data); err != nil {
		http.Error(w, "PORTAL HTMLを生成できません", http.StatusInternalServerError)
	}
}

func (h *handler) modeFromRequest(r *http.Request) (Mode, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("mode"))
	if raw == "" {
		raw = strings.Trim(r.URL.Path, "/")
	}
	if raw == "" {
		return h.cfg.DefaultMode, true
	}
	return canonicalMode(Mode(raw))
}

func (h *handler) serveAPI(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/")
	modeText, targetPath, ok := strings.Cut(rest, "/")
	if !ok {
		http.NotFound(w, r)
		return
	}
	mode, ok := canonicalMode(Mode(modeText))
	if !ok {
		http.Error(w, "mode is disabled", http.StatusForbidden)
		return
	}
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
		bodyLimit := int64(controlBodyLimit)
		if targetPath == "/viewer/send" && strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data") {
			// CORE accepts up to 120 MiB of attachments. Keep one MiB for
			// multipart boundaries and metadata while retaining the smaller
			// limit for ordinary control requests.
			bodyLimit = viewerSendBodyLimit
		}
		r.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	}
	r.Header.Set(interactionProfileHeader, interactionProfileForMode(mode))
	r.URL.Path = targetPath
	h.proxy.ServeHTTP(w, r)
}

func interactionProfileForMode(mode Mode) string {
	if mode == ModeChat {
		return "portal-chat"
	}
	if mode == ModeGames {
		return "portal-games"
	}
	return "portal-idlechat"
}

func portalEndpointAllowed(mode Mode, method, path string) bool {
	if mode == ModeGames {
		return portalGamesEndpointAllowed(method, path)
	}
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
	if method == http.MethodPost && path == "/viewer/surface-presence" {
		return true
	}
	if mode != ModeChat {
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
		"/viewer/recipient-selection",
		"/viewer/active-control",
		"/viewer/tts/playback-ack":
		return true
	default:
		return false
	}
}

func portalGamesEndpointAllowed(method, path string) bool {
	if method == http.MethodGet || method == http.MethodHead {
		switch path {
		case "/health",
			"/viewer/games/status",
			"/viewer/games/sessions",
			"/viewer/games/events",
			"/viewer/games/observer":
			return true
		default:
			return strings.HasPrefix(path, "/viewer/games/observer-api/")
		}
	}
	if method != http.MethodPost {
		return false
	}
	if path == "/viewer/games/launch" {
		return true
	}
	return portalGamesSessionActionAllowed(path)
}

func portalGamesSessionActionAllowed(path string) bool {
	const prefix = "/viewer/games/observer-api/games/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
		return false
	}
	return parts[1] == "retry" || parts[1] == "start_over"
}

func (h *handler) serveGamesObserverProxy(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.modeEnabled(ModeGames) {
		http.Error(w, "mode is disabled", http.StatusForbidden)
		return
	}
	if !portalGamesEndpointAllowed(r.Method, r.URL.Path) {
		http.Error(w, "Gamesでは許可されていない操作です", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodPost {
		if !sameOriginOrNonBrowser(r) {
			http.Error(w, "cross-origin controlは許可されていません", http.StatusForbidden)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, controlBodyLimit)
	}
	if r.URL.Path == "/viewer/games/observer" {
		setGamesObserverSecurityHeaders(w.Header())
	}
	r.Header.Set(interactionProfileHeader, interactionProfileForMode(ModeGames))
	h.proxy.ServeHTTP(w, r)
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
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, strings.TrimRight(h.cfg.CoreURL, "/")+"/ready", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "status": "error", "service": "rencrow-portal", "runtime": "go",
			"error_code": "PORTAL_READINESS_FAILED", "error": err.Error(),
		})
		return
	}
	response, err := h.readiness.Do(request)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "status": "unavailable", "service": "rencrow-portal", "runtime": "go",
			"error_code": "PORTAL_CORE_UNAVAILABLE", "core": "unreachable",
		})
		return
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "status": "unavailable", "service": "rencrow-portal", "runtime": "go",
			"error_code": "PORTAL_CORE_UNAVAILABLE", "core_status": response.StatusCode,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "status": "ready", "service": "rencrow-portal", "runtime": "go", "core": "ready",
	})
}

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
}

func setGamesObserverSecurityHeaders(header http.Header) {
	header.Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "SAMEORIGIN")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
