package portal

import (
	"strings"
	"testing"
)

func TestPortalChatLoadsStableViewportPolicy(t *testing.T) {
	page, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	content := string(page)
	for _, marker := range []string{
		`<link rel="stylesheet" href="/assets/portal-viewport-lock.css">`,
		`<script src="/assets/portal-viewport-lock.js" defer></script>`,
		`<script src="/assets/portal.js" defer></script>`,
		`<script src="/assets/portal-viewport-unlock.js" defer></script>`,
	} {
		if !strings.Contains(content, marker) {
			t.Errorf("stable viewport asset marker %q is missing", marker)
		}
	}
	if strings.Index(content, `portal-viewport-lock.js`) > strings.Index(content, `portal.js`) {
		t.Error("viewport lock must load before portal.js")
	}
	if strings.Index(content, `portal-viewport-unlock.js`) < strings.Index(content, `portal.js`) {
		t.Error("viewport unlock must load after portal.js")
	}
}

func TestPortalChatViewportPolicyBlocksAutomaticRefit(t *testing.T) {
	lockScript, err := webFiles.ReadFile("web/portal-viewport-lock.js")
	if err != nil {
		t.Fatal(err)
	}
	unlockScript, err := webFiles.ReadFile("web/portal-viewport-unlock.js")
	if err != nil {
		t.Fatal(err)
	}
	stylesheet, err := webFiles.ReadFile("web/portal-viewport-lock.css")
	if err != nil {
		t.Fatal(err)
	}

	lock := string(lockScript)
	for _, marker := range []string{
		`this === window && (type === 'resize' || type === 'pageshow')`,
		`this === visualViewport && (type === 'resize' || type === 'scroll')`,
	} {
		if !strings.Contains(lock, marker) {
			t.Errorf("viewport lock marker %q is missing", marker)
		}
	}
	if !strings.Contains(string(unlockScript), `chatCanvasFitPolicy = 'initial-only'`) {
		t.Error("viewport policy metadata is missing")
	}
	if !strings.Contains(string(stylesheet), `font-size:var(--room-input-font-size,16px) !important;`) {
		t.Error("Chat input must use at least 16px to prevent mobile focus zoom")
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
		`Math.min(viewport.width / profile.logicalWidth, viewport.height / profile.logicalHeight)`,
		`fitChatCanvas(profile, viewport)`,
	} {
		if !strings.Contains(js, marker) {
			t.Errorf("fixed Chat canvas marker %q is missing", marker)
		}
	}
	for _, forbidden := range []string{
		`window.visualViewport`,
		`window.addEventListener('resize'`,
		`window.addEventListener('pageshow'`,
	} {
		if strings.Contains(js, forbidden) {
			t.Errorf("initial-only Chat canvas must not contain %q", forbidden)
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
