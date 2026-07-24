package purupurusync

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTransformAppBuildsScopedMultiInstanceRuntime(t *testing.T) {
	sourcePath := filepath.Join("..", "portal", "web", "purupuru", "app.js")
	runtimePath := filepath.Join("..", "portal", "web", "purupuru", "runtime-app.js")
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	generated, err := TransformApp(source)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := os.ReadFile(runtimePath)
	if err != nil {
		t.Fatal(err)
	}
	if !EqualNormalized(generated, committed) {
		t.Fatal("runtime-app.js is stale; run cmd/sync-purupuru")
	}
	text := string(generated)
	for _, marker := range []string{
		"registry.boot = function bootPuruPuruRuntime(runtime)",
		"const PORTAL_RUNTIME_MODE = Boolean(runtime.portal)",
		"if (PORTAL_RUNTIME_MODE || mainAnimationPaused",
		"OBS_MODE && !PORTAL_RUNTIME_MODE",
		"function portalVoiceLevel(nowMs)",
		"(OBS_MODE || PORTAL_RUNTIME_MODE)",
		"runtime.controlPanelLeft",
		"frame(timestamp)",
		"setPointer(clientX, clientY)",
		"setVoiceLevel(raw)",
		"setInput(input = {})",
		`Object.hasOwn(input, "voiceRaw")`,
		`runtime.mouseFollowEnabled === false`,
		`kuro: "Kuro"`,
		"mouseFollowEnabled: state.mouseFollowEnabled",
		"idleMotionEnabled: state.idleMotionEnabled",
		"meshRenderer?.dispose?.()",
	} {
		if !strings.Contains(text, marker) {
			t.Errorf("generated runtime marker %q is missing", marker)
		}
	}
	for _, stale := range []string{
		`if (!OBS_MODE) return;
    document.body.classList.add("dock-hidden");`,
		`runtime.setInput({voiceRaw: 0, angleX: 0, angleY: 0})`,
		`if (!OBS_MODE) await initializeCharacterLibraryAfterAssetsReady();`,
	} {
		if strings.Contains(text, stale) {
			t.Errorf("generated runtime still contains stale PORTAL behavior %q", stale)
		}
	}
}

func TestConfiguredCharactersSupportsTargetedKuroSync(t *testing.T) {
	selected, err := configuredCharacters([]string{"kuro", "KURO"})
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 1 || selected[0] != "Kuro" {
		t.Fatalf("selected = %#v, want []string{\"Kuro\"}", selected)
	}
	if _, err := configuredCharacters([]string{"unknown"}); err == nil {
		t.Fatal("unknown character should be rejected")
	}
}

func TestTransformAppRejectsUnexpectedUpstreamShape(t *testing.T) {
	if _, err := TransformApp([]byte("not the PuruPuru application")); err == nil {
		t.Fatal("TransformApp should reject an unknown upstream shape")
	}
}

func TestTransformAppPreservesUpstreamMotionCore(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "portal", "web", "purupuru", "app.js"))
	if err != nil {
		t.Fatal(err)
	}
	generated, err := TransformApp(source)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name         string
		start        string
		sourceEnd    string
		generatedEnd string
	}{
		{"pointer response", "    const panelRect = panelRectCache;", "  function setPreviewTarget", "  function setPreviewTarget"},
		{"idle motion", "  function idleMotionEase", "  function affineFromTriangles", "  function affineFromTriangles"},
		{"hair physics", "  function updateHairPhysics", "  function sampleHairSpringState", "  function sampleHairSpringState"},
		{"rendering", "  function render()", "  function createFaceTracker", "  function createFaceTracker"},
		{"voice response", "  function updateVoiceFromRaw", "  function updateVoice(", "  function portalVoiceLevel"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sourceBlock := scriptBlock(t, string(source), test.start, test.sourceEnd)
			generatedBlock := scriptBlock(t, string(generated), test.start, test.generatedEnd)
			if sourceBlock != generatedBlock {
				t.Fatalf("upstream %s code changed inside the PORTAL transform", test.name)
			}
		})
	}
}

func scriptBlock(t *testing.T, script, startMarker, endMarker string) string {
	t.Helper()
	start := strings.Index(script, startMarker)
	if start < 0 {
		t.Fatalf("start marker %q is missing", startMarker)
	}
	endOffset := strings.Index(script[start+len(startMarker):], endMarker)
	if endOffset < 0 {
		t.Fatalf("end marker %q is missing after %q", endMarker, startMarker)
	}
	end := start + len(startMarker) + endOffset
	return script[start:end]
}
