package portal

import (
	"strings"
	"testing"
)

func TestPortalChatLoadsDynamicViewportPolicy(t *testing.T) {
	page, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	content := string(page)
	for _, marker := range []string{
		`<link rel="stylesheet" href="/assets/portal.css">`,
		`<script src="/assets/portal.js" defer></script>`,
	} {
		if !strings.Contains(content, marker) {
			t.Errorf("dynamic viewport asset marker %q is missing", marker)
		}
	}
	for _, forbidden := range []string{
		`portal-viewport-lock.css`,
		`portal-viewport-lock.js`,
		`portal-viewport-unlock.js`,
	} {
		if strings.Contains(content, forbidden) {
			t.Errorf("obsolete viewport lock asset %q must not load", forbidden)
		}
	}
}

func TestPortalChatViewportPolicyRefitsOnLayoutViewportChanges(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}

	js := string(script)
	for _, marker := range []string{
		`function scheduleChatViewportSync()`,
		`chatViewportFrameID = requestAnimationFrame(() => {`,
		`window.addEventListener('resize', scheduleChatViewportSync, {passive: true});`,
		`window.addEventListener('pageshow', scheduleChatViewportSync, {passive: true});`,
		`window.matchMedia('(orientation: portrait)')`,
		`chatOrientationMedia.addEventListener('change', scheduleChatViewportSync);`,
		`body.dataset.chatCanvasFitPolicy = 'dynamic-layout-viewport';`,
	} {
		if !strings.Contains(js, marker) {
			t.Errorf("dynamic viewport marker %q is missing", marker)
		}
	}
	if !strings.Contains(string(stylesheet), `font-size:var(--room-input-font-size,16px) !important;`) {
		t.Error("Chat input must use at least 16px to prevent mobile focus zoom")
	}
	for _, forbidden := range []string{
		`window.visualViewport`,
		`EventTarget.prototype`,
		`chatCanvasFitPolicy = 'initial-only'`,
	} {
		if strings.Contains(js, forbidden) {
			t.Errorf("dynamic layout viewport policy must not contain %q", forbidden)
		}
	}
}

func TestPortalChatUsesOnlyFixedLandscapeAndPortraitCanvases(t *testing.T) {
	script, err := webFiles.ReadFile("web/portal.js")
	if err != nil {
		t.Fatal(err)
	}
	stylesheet, err := webFiles.ReadFile("web/portal.css")
	if err != nil {
		t.Fatal(err)
	}

	js := string(script)
	for _, marker := range []string{
		`physicalWidth: 1920`,
		`physicalHeight: 1080`,
		`logicalWidth: 1920`,
		`logicalHeight: 1080`,
		`physicalWidth: 1179`,
		`physicalHeight: 2556`,
		`logicalWidth: 393`,
		`logicalHeight: 852`,
		`root.clientWidth || window.innerWidth`,
		`root.clientHeight || window.innerHeight`,
		`return viewport.width >= viewport.height ? viewportProfiles.landscape : viewportProfiles.portrait;`,
		`Math.min(viewport.width / profile.logicalWidth, viewport.height / profile.logicalHeight)`,
		`fitChatCanvas(profile, viewport)`,
		`document.documentElement.classList.toggle('portal-chat-landscape', profile.id === 'landscape');`,
		`document.documentElement.classList.toggle('portal-chat-portrait', profile.id === 'portrait');`,
	} {
		if !strings.Contains(js, marker) {
			t.Errorf("fixed Chat canvas marker %q is missing", marker)
		}
	}
	selectorStart := strings.Index(js, `function readLayoutViewportSize()`)
	selectorEnd := strings.Index(js, `function setViewportProfileMetadata(profile)`)
	if selectorStart < 0 || selectorEnd <= selectorStart {
		t.Fatal("viewport profile selector boundary is missing")
	}
	selector := js[selectorStart:selectorEnd]
	for _, forbidden := range []string{
		`navigator.userAgent`,
		`screen.width`,
		`screen.height`,
	} {
		if strings.Contains(selector, forbidden) {
			t.Errorf("viewport profile selection must not contain %q", forbidden)
		}
	}

	css := string(stylesheet)
	for _, marker := range []string{
		`html.portal-chat-fixed-canvas.portal-chat-landscape`,
		`width:1920px;`,
		`height:1080px;`,
		`html.portal-chat-fixed-canvas.portal-chat-portrait`,
		`width:393px;`,
		`height:852px;`,
		`transform:scale(var(--chat-canvas-scale));`,
		`left:var(--chat-canvas-offset-x);`,
		`top:var(--chat-canvas-offset-y);`,
	} {
		if !strings.Contains(css, marker) {
			t.Errorf("fixed Chat canvas stylesheet marker %q is missing", marker)
		}
	}
}
