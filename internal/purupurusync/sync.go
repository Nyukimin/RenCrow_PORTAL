package purupurusync

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Characters is the PORTAL-visible set. The directory names are part of the
// PuruPuru package contract and intentionally retain their original casing.
var Characters = []string{"Mio", "Shiro", "Midori"}

// CharacterPackages pins the generated model that PORTAL renders. Loose PNGs
// in each directory can be intermediate material and are not necessarily the
// same content as the latest exported .purupuru package.
var CharacterPackages = map[string]string{
	"Mio":    "Mio.purupuru",
	"Shiro":  "Shiro02.purupuru",
	"Midori": "Midori02.purupuru",
}

type Manifest struct {
	SourceCommit     string            `json:"source_commit"`
	AppSHA256        string            `json:"app_sha256"`
	CharacterPackage map[string]string `json:"character_packages"`
	PackageSHA256    map[string]string `json:"package_sha256"`
	Files            map[string]string `json:"files"`
}

// TransformApp wraps the upstream PuruPuru application in an instance factory.
// Rendering, deformation, physics and expression code remain byte-for-byte
// inside the wrapper; only boot, asset routing and external input boundaries are
// adapted for PORTAL.
func TransformApp(source []byte) ([]byte, error) {
	s := strings.ReplaceAll(string(source), "\r\n", "\n")
	var err error
	replace := func(old, replacement, label string) {
		if err != nil {
			return
		}
		if strings.Count(s, old) != 1 {
			err = fmt.Errorf("%s marker count = %d, want 1", label, strings.Count(s, old))
			return
		}
		s = strings.Replace(s, old, replacement, 1)
	}

	replace("// SPDX-License-Identifier: Apache-2.0\n(() => {\n  \"use strict\";", `// SPDX-License-Identifier: Apache-2.0
// Generated from upstream app.js by internal/purupurusync. Do not edit by hand.
(function registerPuruPuruRuntime(hostWindow) {
  "use strict";

  const registry = hostWindow.PuruPuruRuntime || (hostWindow.PuruPuruRuntime = {});
  registry.boot = function bootPuruPuruRuntime(runtime) {
  "use strict";

  if (!runtime || !runtime.window || !runtime.document || !runtime.assetBaseURL) {
    throw new Error("PuruPuru runtime requires scoped window, document and assetBaseURL");
  }
  const window = runtime.window;
  const document = runtime.document;
  const localStorage = runtime.localStorage || hostWindow.localStorage;
  const indexedDB = runtime.indexedDB || hostWindow.indexedDB;`, "factory header")

	replace(`  const OBS_MODE = APP_MODE === "obs";`, `  const OBS_MODE = APP_MODE === "obs";
  const PORTAL_RUNTIME_MODE = Boolean(runtime.portal);
  const PORTAL_CHARACTER_DIRS = Object.freeze({ mio: "Mio", shiro: "Shiro", midori: "Midori" });
  const PORTAL_CHARACTER = Object.hasOwn(PORTAL_CHARACTER_DIRS, String(runtime.character || "").toLowerCase())
    ? String(runtime.character).toLowerCase()
    : "mio";
  const PORTAL_CHARACTER_DIR = PORTAL_CHARACTER_DIRS[PORTAL_CHARACTER];`, "runtime mode")

	assetStart := strings.Index(s, "  const ASSETS = {\n")
	assetEnd := strings.Index(s, "  const DEMO_AVATAR02_ASSETS = {\n")
	if assetStart < 0 || assetEnd <= assetStart {
		return nil, fmt.Errorf("asset block markers not found")
	}
	originalAssets := s[assetStart:assetEnd]
	originalAssets = strings.Replace(originalAssets, "  const ASSETS = ", "  const DEFAULT_ASSETS = ", 1)
	portalAssets := `  function portalAssetURL(path) {
    return new URL(path, runtime.assetBaseURL).href;
  }
  function portalAvatarAssets(directory) {
    const root = ` + "`assets/${directory}/`" + `;
    return {
      backHair: portalAssetURL(root + "back-hair.png"),
      frontHair: portalAssetURL(root + "front-hair.png"),
      eyesOpenMouthClosed: portalAssetURL(root + "eyes-open-mouth-closed.png"),
      eyesOpenMouthHalf: portalAssetURL(root + "eyes-open-mouth-half.png"),
      eyesOpenMouthOpen: portalAssetURL(root + "eyes-open-mouth-open.png"),
      eyesClosedMouthClosed: portalAssetURL(root + "eyes-closed-mouth-closed.png"),
      eyesClosedMouthHalf: portalAssetURL(root + "eyes-closed-mouth-half.png"),
      eyesClosedMouthOpen: portalAssetURL(root + "eyes-closed-mouth-open.png"),
    };
  }
` + originalAssets + `  const ASSETS = PORTAL_RUNTIME_MODE ? portalAvatarAssets(PORTAL_CHARACTER_DIR) : DEFAULT_ASSETS;
`
	s = s[:assetStart] + portalAssets + s[assetEnd:]

	replace(`  const DEFAULT_SETTINGS_URL = "assets/demo-avatar/default-settings.json";`, `  const DEFAULT_SETTINGS_URL = PORTAL_RUNTIME_MODE
    ? portalAssetURL(`+"`assets/${PORTAL_CHARACTER_DIR}/default-settings.json`"+`)
    : "assets/demo-avatar/default-settings.json";`, "settings URL")
	replace(`  const OBS_TRANSPARENT = OBS_MODE && URL_PARAMS.get("transparent") !== "0";`, `  const OBS_TRANSPARENT = (OBS_MODE || PORTAL_RUNTIME_MODE) && URL_PARAMS.get("transparent") !== "0";`, "PORTAL transparent canvas")

	replace(`  const obsExternalInput = {
    targetX: 0,
    targetY: 0,
    angleX: 0,
    angleY: 0,
    voiceRaw: 0,
    updatedAt: 0,
    connected: false,
  };`, `  const obsExternalInput = {
    targetX: 0,
    targetY: 0,
    angleX: 0,
    angleY: 0,
    voiceRaw: 0,
    updatedAt: 0,
    connected: false,
  };
  // PORTAL supplies the same pre-gain RMS signal used by PuruPuru's mic
  // input. Keep it independent from pose freshness so a voice-only update
  // never recenters or otherwise changes the character pose.
  const portalVoiceInput = {
    raw: 0,
    updatedAt: 0,
  };`, "PORTAL voice input")

	replace(`  function applyObsModeDefaults() {
    document.documentElement.classList.toggle("obs-mode", OBS_MODE);
    document.body.classList.toggle("obs-mode", OBS_MODE);
    if (!OBS_MODE) return;`, `  function applyObsModeDefaults() {
    document.documentElement.classList.toggle("obs-mode", OBS_MODE);
    document.body.classList.toggle("obs-mode", OBS_MODE);
    if (!OBS_MODE || PORTAL_RUNTIME_MODE) return;`, "PORTAL settings fidelity")

	replace(`      panelRectCache = document.querySelector(".control-card")?.getBoundingClientRect() || null;`, `      panelRectCache = PORTAL_RUNTIME_MODE && Number.isFinite(Number(runtime.controlPanelLeft))
        ? { left: clamp(Number(runtime.controlPanelLeft), 0, stage.w) }
        : (document.querySelector(".control-card")?.getBoundingClientRect() || null);`, "PORTAL pointer geometry")

	replace(`  function updateVoice(nowMs, delta = 1 / 60) {
    const raw = OBS_MODE ? externalVoiceLevel(nowMs) : currentRawVoiceLevel();
    updateVoiceFromRaw(raw, nowMs, delta);
  }`, `  function portalVoiceLevel(nowMs) {
    const age = Math.max(0, nowMs - portalVoiceInput.updatedAt);
    const decay = age <= 250 ? 1 : clamp(1 - (age - 250) / 200, 0, 1);
    return portalVoiceInput.raw * (state.micGain / 100) * decay;
  }

  function updateVoice(nowMs, delta = 1 / 60) {
    const raw = PORTAL_RUNTIME_MODE
      ? portalVoiceLevel(nowMs)
      : (OBS_MODE ? externalVoiceLevel(nowMs) : currentRawVoiceLevel());
    updateVoiceFromRaw(raw, nowMs, delta);
  }`, "PORTAL voice fidelity")

	replace(`      const obsFrameInterval = OBS_MODE ? 1000 / currentObsRenderFps() : 0;`, `      const obsFrameInterval = OBS_MODE && !PORTAL_RUNTIME_MODE ? 1000 / currentObsRenderFps() : 0;`, "PORTAL frame rate")
	replace(`      if (OBS_MODE && obsLastFrameAt && timestamp - obsLastFrameAt < obsFrameSkipThreshold) {`, `      if (OBS_MODE && !PORTAL_RUNTIME_MODE && obsLastFrameAt && timestamp - obsLastFrameAt < obsFrameSkipThreshold) {`, "PORTAL frame skip")
	replace(`      if (OBS_MODE) obsLastFrameAt = timestamp;`, `      if (OBS_MODE && !PORTAL_RUNTIME_MODE) obsLastFrameAt = timestamp;`, "PORTAL frame timestamp")
	replace(`      if (OBS_MODE) {
        applyObsExternalTarget(timestamp);
      } else {
        updateIdleMotionTarget(timestamp);
      }`, `      if (OBS_MODE && !PORTAL_RUNTIME_MODE) {
        applyObsExternalTarget(timestamp);
      } else {
        // PORTAL follows the normal PuruPuru motion path. In particular, the
        // package's mouseFollowEnabled and idleMotionEnabled values remain the
        // source of truth instead of the OBS stale-input fallback changing them.
        updateIdleMotionTarget(timestamp);
      }`, "PORTAL motion path")

	replace(`  function requestMainAnimationFrame() {
    if (mainAnimationPaused || mainRafId !== null) return;`, `  function requestMainAnimationFrame() {
    if (PORTAL_RUNTIME_MODE || mainAnimationPaused || mainRafId !== null) return;`, "shared scheduler")

	replace(`  function connectObsEventSource() {
    if (!OBS_MODE || obsEventSource) return;`, `  function connectObsEventSource() {
    if (!OBS_MODE || PORTAL_RUNTIME_MODE || obsEventSource) return;`, "OBS event boundary")

	startup := `  scheduleBlink();
  loadAssets()
    .then(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!OBS_MODE) await initializeCharacterLibraryAfterAssetsReady();
      return Promise.all([loadObsSnapshotIfAvailable(), loadObsConfigIfAvailable()]);
    })
    .catch((error) => {
      loadError = error instanceof Error ? error.message : String(error);
      setStatus("error");
      console.error("loadAssets failed", error);
    });
  connectObsEventSource();
  requestMainAnimationFrame();
})();`
	replacementStartup := `  scheduleBlink();
  let destroyed = false;
  let ready;
  const controller = {
    character: PORTAL_CHARACTER,
    canvas,
    get ready() { return ready; },
    frame(timestamp) {
      if (!destroyed) tick(timestamp);
    },
    setPointer(clientX, clientY) {
      if (destroyed || !state.mouseFollowEnabled || interactionModeActive() || isFaceTrackingActive()) return;
      updatePointerTarget(Number(clientX) || 0, Number(clientY) || 0);
    },
    setVoiceLevel(raw) {
      portalVoiceInput.raw = clamp(Number(raw) || 0, 0, 2);
      portalVoiceInput.updatedAt = performance.now();
    },
    setInput(input = {}) {
      if (Object.hasOwn(input, "voiceRaw")) controller.setVoiceLevel(input.voiceRaw);
      if (Object.hasOwn(input, "pointerX") && Object.hasOwn(input, "pointerY")) {
        controller.setPointer(input.pointerX, input.pointerY);
      }
      if (Object.hasOwn(input, "targetX") || Object.hasOwn(input, "angleX")) {
        state.targetX = clamp(Number(input.targetX ?? input.angleX) || 0, -3, 3);
      }
      if (Object.hasOwn(input, "targetY") || Object.hasOwn(input, "angleY")) {
        state.targetY = clamp(Number(input.targetY ?? input.angleY) || 0, -3, 3);
      }
    },
    debugState() {
      return {
        character: PORTAL_CHARACTER,
        imagesReady,
        loadError,
        stage: { ...stage },
        targetX: state.targetX,
        targetY: state.targetY,
        angleX: state.angleX,
        angleY: state.angleY,
        mouthState,
        voiceLevel,
        followSpeed: state.followSpeed,
        mouseFollowEnabled: state.mouseFollowEnabled,
        idleMotionEnabled: state.idleMotionEnabled,
        micGain: state.micGain,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      pauseMainAnimationLoop();
      clearTimeout(blinkTimer);
      closeObsEventSource();
      faceTracker?.stop?.();
      meshRenderer?.dispose?.();
      audioEngine.close();
    },
  };
  ready = loadAssets()
    .then(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (PORTAL_RUNTIME_MODE && runtime.mouseFollowEnabled === false) {
        state.mouseFollowEnabled = false;
        if (!isFaceTrackingActive()) {
          state.targetX = 0;
          state.targetY = 0;
        }
        updateMouseFollowButton();
      }
      if (!OBS_MODE && !PORTAL_RUNTIME_MODE) await initializeCharacterLibraryAfterAssetsReady();
      if (!PORTAL_RUNTIME_MODE) {
        await Promise.all([loadObsSnapshotIfAvailable(), loadObsConfigIfAvailable()]);
      }
      runtime.onReady?.(controller);
      return controller;
    })
    .catch((error) => {
      loadError = error instanceof Error ? error.message : String(error);
      setStatus("error");
      runtime.onError?.(error);
      console.error("loadAssets failed", error);
      throw error;
    });
  if (!PORTAL_RUNTIME_MODE) {
    connectObsEventSource();
    requestMainAnimationFrame();
  }
  return controller;
  };
})(window);`
	replace(startup, replacementStartup, "startup")

	if err != nil {
		return nil, err
	}
	return []byte(s), nil
}

func Sync(sourceRoot, destinationRoot, sourceCommit string) (*Manifest, error) {
	app, err := os.ReadFile(filepath.Join(sourceRoot, "app.js"))
	if err != nil {
		return nil, fmt.Errorf("read upstream app.js: %w", err)
	}
	runtimeApp, err := TransformApp(app)
	if err != nil {
		return nil, fmt.Errorf("transform app.js: %w", err)
	}
	if err := os.MkdirAll(destinationRoot, 0o755); err != nil {
		return nil, err
	}

	manifest := &Manifest{
		SourceCommit:     sourceCommit,
		CharacterPackage: map[string]string{},
		PackageSHA256:    map[string]string{},
		Files:            map[string]string{},
	}
	appHash := sha256.Sum256(app)
	manifest.AppSHA256 = hex.EncodeToString(appHash[:])

	for _, name := range []string{"app.js", "index.html", "styles.css", "LICENSE"} {
		if err := copyFile(filepath.Join(sourceRoot, name), filepath.Join(destinationRoot, name)); err != nil {
			return nil, err
		}
	}
	if err := os.WriteFile(filepath.Join(destinationRoot, "runtime-app.js"), runtimeApp, 0o644); err != nil {
		return nil, err
	}
	for _, character := range Characters {
		sourceDir := filepath.Join(sourceRoot, "assets", character)
		destinationDir := filepath.Join(destinationRoot, "assets", character)
		packageName := CharacterPackages[character]
		if packageName == "" {
			return nil, fmt.Errorf("%s package is not configured", character)
		}
		packagePath := filepath.Join(sourceDir, packageName)
		packageData, err := os.ReadFile(packagePath)
		if err != nil {
			return nil, fmt.Errorf("read %s package: %w", character, err)
		}
		packageHash := sha256.Sum256(packageData)
		manifest.CharacterPackage[character] = packageName
		manifest.PackageSHA256[character] = hex.EncodeToString(packageHash[:])
		if err := resetGeneratedCharacterDir(destinationRoot, destinationDir); err != nil {
			return nil, fmt.Errorf("reset %s destination: %w", character, err)
		}
		if err := extractRuntimePackage(packagePath, destinationDir); err != nil {
			return nil, fmt.Errorf("extract %s: %w", character, err)
		}
	}
	if err := hashTree(destinationRoot, manifest.Files); err != nil {
		return nil, err
	}
	delete(manifest.Files, "manifest.json")
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	encoded = append(encoded, '\n')
	if err := os.WriteFile(filepath.Join(destinationRoot, "manifest.json"), encoded, 0o644); err != nil {
		return nil, err
	}
	return manifest, nil
}

func resetGeneratedCharacterDir(destinationRoot, destinationDir string) error {
	root, err := filepath.Abs(filepath.Join(destinationRoot, "assets"))
	if err != nil {
		return err
	}
	target, err := filepath.Abs(destinationDir)
	if err != nil {
		return err
	}
	if filepath.Dir(target) != root || !contains(Characters, filepath.Base(target)) {
		return fmt.Errorf("refusing to reset unexpected path %s", target)
	}
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	return os.MkdirAll(target, 0o755)
}

func extractRuntimePackage(packagePath, destinationDir string) error {
	archive, err := zip.OpenReader(packagePath)
	if err != nil {
		return err
	}
	defer archive.Close()

	required := map[string]bool{
		"avatar/back-hair.png":                false,
		"avatar/front-hair.png":               false,
		"avatar/eyes-open-mouth-closed.png":   false,
		"avatar/eyes-open-mouth-half.png":     false,
		"avatar/eyes-open-mouth-open.png":     false,
		"avatar/eyes-closed-mouth-closed.png": false,
		"avatar/eyes-closed-mouth-half.png":   false,
		"avatar/eyes-closed-mouth-open.png":   false,
		"settings.json":                       false,
	}
	for _, entry := range archive.File {
		name := filepath.ToSlash(entry.Name)
		var relative string
		switch {
		case strings.HasPrefix(name, "avatar/") && strings.HasSuffix(strings.ToLower(name), ".png"):
			relative = strings.TrimPrefix(name, "avatar/")
		case strings.HasPrefix(name, "items/") && strings.HasSuffix(strings.ToLower(name), ".png"):
			relative = name
		case name == "settings.json":
			relative = "default-settings.json"
		case name == "thumbnail.png":
			relative = "package-thumbnail.png"
		case name == "manifest.json":
			relative = "package-manifest.json"
		default:
			continue
		}
		if _, tracked := required[name]; tracked {
			required[name] = true
		}
		if err := extractPackageFile(entry, destinationDir, relative); err != nil {
			return err
		}
	}
	for name, found := range required {
		if !found {
			return fmt.Errorf("required package entry %s is missing", name)
		}
	}
	return nil
}

func extractPackageFile(entry *zip.File, destinationRoot, relative string) error {
	clean := filepath.Clean(filepath.FromSlash(relative))
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("unsafe package path %q", relative)
	}
	destination := filepath.Join(destinationRoot, clean)
	root, err := filepath.Abs(destinationRoot)
	if err != nil {
		return err
	}
	target, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return fmt.Errorf("package path escapes destination: %q", relative)
	}
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	output, err := os.Create(target)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, reader)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func copyTree(sourceRoot, destinationRoot string) error {
	return filepath.WalkDir(sourceRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(sourceRoot, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(destinationRoot, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		return copyFile(path, destination)
	})
}

func copyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	output, err := os.Create(destination)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func hashTree(root string, hashes map[string]string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		hash := sha256.Sum256(data)
		hashes[filepath.ToSlash(relative)] = hex.EncodeToString(hash[:])
		return nil
	})
}

func EqualNormalized(a, b []byte) bool {
	normalize := func(value []byte) []byte { return bytes.ReplaceAll(value, []byte("\r\n"), []byte("\n")) }
	return bytes.Equal(normalize(a), normalize(b))
}
