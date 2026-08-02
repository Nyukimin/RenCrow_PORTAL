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
	if !strings.Contains(string(stylesheet), `font-size:16px !important;`) {
		t.Error("Chat input must use at least 16px to prevent mobile focus zoom")
	}
}
