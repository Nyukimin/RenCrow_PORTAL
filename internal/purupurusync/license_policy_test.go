package purupurusync

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const puruPuruSourceURL = "https://github.com/rotejin/PuruPuruPNGTuber"

func TestPuruPuruLicenseNoticesAndBoundaries(t *testing.T) {
	repoRoot := filepath.Join("..", "..")
	puruPuruRoot := filepath.Join(repoRoot, "internal", "portal", "web", "purupuru")

	for name, expectedNotice := range map[string]string{
		"app.js":     puruPuruJSNotice,
		"index.html": puruPuruHTMLNotice,
		"styles.css": puruPuruCSSNotice,
	} {
		data := readPolicyFile(t, filepath.Join(puruPuruRoot, name))
		if !strings.Contains(string(data), expectedNotice) {
			t.Errorf("%s is missing its PuruPuru attribution and modification notice", name)
		}
		if strings.Count(string(data), "SPDX-License-Identifier: Apache-2.0") != 1 {
			t.Errorf("%s must retain exactly one Apache-2.0 SPDX marker", name)
		}
	}

	runtime := string(readPolicyFile(t, filepath.Join(puruPuruRoot, "runtime-app.js")))
	for _, marker := range []string{
		puruPuruJSNotice,
		"Generated from upstream app.js by internal/purupurusync. Do not edit by hand.",
	} {
		if !strings.Contains(runtime, marker) {
			t.Errorf("runtime-app.js is missing %q", marker)
		}
	}

	for _, name := range []string{"runtime-host.js", "runtime-host.css"} {
		text := string(readPolicyFile(t, filepath.Join(puruPuruRoot, name)))
		for _, apacheMarker := range []string{
			"SPDX-License-Identifier: Apache-2.0",
			"Copyright 2026 masa",
			"Modified for RenCrow_PORTAL; derived from PuruPuru PNGTuber.",
		} {
			if strings.Contains(text, apacheMarker) {
				t.Errorf("%s is RenCrow_PORTAL-specific MIT code but contains Apache marker %q", name, apacheMarker)
			}
		}
	}

	mitLicense := string(readPolicyFile(t, filepath.Join(repoRoot, "LICENSE")))
	if !strings.HasPrefix(mitLicense, "MIT License\n") || !strings.Contains(mitLicense, "Copyright (c) 2026 Nyukimin") {
		t.Error("root LICENSE must remain the RenCrow_PORTAL MIT License")
	}

	apacheLicense := string(readPolicyFile(t, filepath.Join(puruPuruRoot, "LICENSE")))
	for _, marker := range []string{
		"Copyright 2026 masa",
		"Apache License\nVersion 2.0, January 2004",
		"TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
		"9. Accepting Warranty or Additional Liability.",
		"END OF TERMS AND CONDITIONS",
	} {
		if !strings.Contains(apacheLicense, marker) {
			t.Errorf("PuruPuru LICENSE is missing %q", marker)
		}
	}

	notices := string(readPolicyFile(t, filepath.Join(repoRoot, "THIRD_PARTY_NOTICES.md")))
	for _, marker := range []string{
		"## PuruPuru PNGTuber",
		"Copyright 2026 masa",
		"Licensed under the Apache License, Version 2.0.",
		puruPuruSourceURL,
		"internal/portal/web/purupuru/LICENSE",
		"Adapted for the scoped multi-avatar runtime used by RenCrow_PORTAL.",
		"currently has no `NOTICE` file",
		"`runtime-host.js` and `runtime-host.css`",
	} {
		if !strings.Contains(notices, marker) {
			t.Errorf("THIRD_PARTY_NOTICES.md is missing %q", marker)
		}
	}

	if _, err := os.Stat(filepath.Join(puruPuruRoot, "NOTICE")); !os.IsNotExist(err) {
		t.Errorf("expected no inherited upstream NOTICE in the current snapshot, got %v", err)
	}
}

func TestPuruPuruCodeNoticeGenerationIsIdempotent(t *testing.T) {
	for name, input := range map[string]string{
		"app.js":     "// SPDX-License-Identifier: Apache-2.0\n(() => {})\n",
		"index.html": "<!doctype html>\n<!-- SPDX-License-Identifier: Apache-2.0 -->\n<html></html>\n",
		"styles.css": "/* SPDX-License-Identifier: Apache-2.0 */\n:root{}\n",
	} {
		first, err := addPuruPuruNotice(name, []byte(input))
		if err != nil {
			t.Fatalf("add notice to %s: %v", name, err)
		}
		second, err := addPuruPuruNotice(name, first)
		if err != nil {
			t.Fatalf("re-add notice to %s: %v", name, err)
		}
		if string(first) != string(second) {
			t.Errorf("notice generation for %s is not idempotent", name)
		}
		for _, marker := range []string{
			"SPDX-License-Identifier: Apache-2.0",
			"PuruPuru PNGTuber",
			"Copyright 2026 masa",
			"Licensed under the Apache License, Version 2.0.",
			puruPuruSourceURL,
			"Modified for RenCrow_PORTAL; derived from PuruPuru PNGTuber.",
		} {
			if !strings.Contains(string(first), marker) {
				t.Errorf("generated %s notice is missing %q", name, marker)
			}
		}
	}
}

func TestPuruPuruSyncStopsForANewUpstreamNotice(t *testing.T) {
	sourceRoot := t.TempDir()
	if err := requireReviewedUpstreamNotice(sourceRoot); err != nil {
		t.Fatalf("source without NOTICE was rejected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "NOTICE"), []byte("new attribution\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := requireReviewedUpstreamNotice(sourceRoot)
	if err == nil || !strings.Contains(err.Error(), "review and inherit") {
		t.Fatalf("new upstream NOTICE must stop sync for review, got %v", err)
	}
}

func TestPuruPuruSubtreeExcludesUpstreamMediaAndFonts(t *testing.T) {
	root := filepath.Join("..", "portal", "web", "purupuru")
	fontExtensions := map[string]bool{
		".eot": true, ".otf": true, ".ttf": true, ".woff": true, ".woff2": true,
	}
	imageExtensions := map[string]bool{
		".gif": true, ".ico": true, ".jpeg": true, ".jpg": true,
		".png": true, ".svg": true, ".webp": true,
	}
	forbiddenDirectories := map[string]bool{
		"demo-avatar": true, "demo-avatar02": true, "demo-avatar03": true,
		"font": true, "fonts": true, "icon": true, "icons": true,
		"image": true, "images": true, "screenshot": true, "screenshots": true,
		"vendor": true,
	}
	characters := map[string]bool{}
	for _, character := range Characters {
		characters[strings.ToLower(character)] = true
	}

	imageCount := 0
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		parts := strings.Split(strings.ToLower(filepath.ToSlash(relative)), "/")
		for _, part := range parts {
			if forbiddenDirectories[part] {
				t.Errorf("PuruPuru upstream media/vendor directory must not be bundled: %s", filepath.ToSlash(relative))
			}
		}
		if entry.IsDir() {
			return nil
		}

		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if fontExtensions[extension] {
			t.Errorf("font must not be bundled in the PuruPuru subtree: %s", filepath.ToSlash(relative))
		}
		if !imageExtensions[extension] {
			return nil
		}
		imageCount++
		if extension != ".png" || len(parts) < 3 || parts[0] != "assets" || !characters[parts[1]] {
			t.Errorf("only configured RenCrow avatar-package PNGs may be bundled: %s", filepath.ToSlash(relative))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if imageCount == 0 {
		t.Fatal("asset audit did not inspect any configured RenCrow avatar PNGs")
	}
}

func readPolicyFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return normalizeUTF8Text(data)
}
