package purupurusync

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	_ "image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestVendoredCharacterPackagesAreCompleteAndTransparent(t *testing.T) {
	root := filepath.Join("..", "portal", "web", "purupuru", "assets")
	layers := []string{
		"back-hair.png",
		"front-hair.png",
		"eyes-open-mouth-closed.png",
		"eyes-open-mouth-half.png",
		"eyes-open-mouth-open.png",
		"eyes-closed-mouth-closed.png",
		"eyes-closed-mouth-half.png",
		"eyes-closed-mouth-open.png",
	}
	for _, character := range Characters {
		t.Run(character, func(t *testing.T) {
			var expected image.Rectangle
			for _, layer := range layers {
				path := filepath.Join(root, character, layer)
				file, err := os.Open(path)
				if err != nil {
					t.Fatalf("open %s: %v", layer, err)
				}
				decoded, _, decodeErr := image.Decode(file)
				_ = file.Close()
				if decodeErr != nil {
					t.Fatalf("decode %s: %v", layer, decodeErr)
				}
				bounds := decoded.Bounds()
				if expected.Empty() {
					expected = bounds
				}
				if bounds != expected {
					t.Errorf("%s bounds = %v, want %v", layer, bounds, expected)
				}
				if bounds.Dx() != bounds.Dy() || bounds.Dx() < 1024 {
					t.Errorf("%s must use a square high-resolution canvas, got %v", layer, bounds)
				}
				transparent, visible := false, false
				for y := bounds.Min.Y; y < bounds.Max.Y && !(transparent && visible); y += 8 {
					for x := bounds.Min.X; x < bounds.Max.X; x += 8 {
						_, _, _, alpha := decoded.At(x, y).RGBA()
						transparent = transparent || alpha < 0xffff
						visible = visible || alpha > 0
					}
				}
				if !transparent || !visible {
					t.Errorf("%s transparency/visible-pixel check failed", layer)
				}
			}

			settingsPath := filepath.Join(root, character, "default-settings.json")
			data, err := os.ReadFile(settingsPath)
			if err != nil {
				t.Fatal(err)
			}
			data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
			var settings map[string]json.RawMessage
			if err := json.Unmarshal(data, &settings); err != nil {
				t.Fatalf("settings JSON: %v", err)
			}
			for _, key := range []string{"avatarImageSize", "state", "faceCenterSetup", "eyeSetup", "faceDepthSetup", "neckPivotSetup", "hairBundleSetup", "itemLayers"} {
				if len(settings[key]) == 0 || string(settings[key]) == "null" {
					t.Errorf("settings key %q is missing", key)
				}
			}
			var itemLayers []struct {
				File string `json:"file"`
			}
			if err := json.Unmarshal(settings["itemLayers"], &itemLayers); err != nil {
				t.Fatalf("itemLayers JSON: %v", err)
			}
			if len(itemLayers) == 0 {
				t.Fatal("itemLayers must include the generated body/accessory layers")
			}
			for _, layer := range itemLayers {
				if layer.File == "" {
					t.Error("item layer file is missing")
					continue
				}
				path := filepath.Join(root, character, filepath.FromSlash(layer.File))
				file, err := os.Open(path)
				if err != nil {
					t.Errorf("open package item %s: %v", layer.File, err)
					continue
				}
				decoded, _, decodeErr := image.Decode(file)
				_ = file.Close()
				if decodeErr != nil {
					t.Errorf("decode package item %s: %v", layer.File, decodeErr)
					continue
				}
				bounds := decoded.Bounds()
				if bounds.Empty() || bounds.Dx() > expected.Dx() || bounds.Dy() > expected.Dy() {
					t.Errorf("package item %s bounds = %v, must fit avatar canvas %v", layer.File, bounds, expected)
				}
			}
		})
	}
}

func TestVendoredManifestMatchesFiles(t *testing.T) {
	root := filepath.Join("..", "portal", "web", "purupuru")
	data, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.SourceCommit == "" || manifest.SourceCommit == "unknown" {
		t.Fatal("manifest source_commit is missing")
	}
	for character, packageName := range CharacterPackages {
		if manifest.CharacterPackage[character] != packageName {
			t.Errorf("manifest package %s = %q, want %q", character, manifest.CharacterPackage[character], packageName)
		}
		if len(manifest.PackageSHA256[character]) != 64 {
			t.Errorf("manifest package hash %s is invalid", character)
		}
	}
	for relative, expected := range manifest.Files {
		file, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Errorf("manifest file %s: %v", relative, err)
			continue
		}
		hash := sha256.Sum256(file)
		if actual := hex.EncodeToString(hash[:]); actual != expected {
			t.Errorf("manifest hash %s = %s, want %s", relative, actual, expected)
		}
	}
}
