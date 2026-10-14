package purupurusync

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSyncSeparatePackageRootPreservesDeliveredLayers(t *testing.T) {
	source := filepath.Join("..", "portal", "web", "purupuru")
	packages := filepath.Join("..", "..", "avatar-packages")
	destination := filepath.Join(t.TempDir(), "runtime")
	manifest, err := SyncSelectedWithPackages(source, packages, destination, "9dc1e735155faae8f54f9ee3076b52db7da36624", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.CharacterPackage) != 5 {
		t.Fatalf("character count = %d", len(manifest.CharacterPackage))
	}
	for _, character := range Characters {
		archive, err := zip.OpenReader(filepath.Join(packages, character, CharacterPackages[character]))
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range archive.File {
			name := entry.Name
			relative := ""
			switch {
			case len(name) > 7 && name[:7] == "avatar/":
				relative = name[7:]
			case len(name) > 6 && name[:6] == "items/":
				relative = name
			case name == "settings.json":
				relative = "default-settings.json"
			default:
				continue
			}
			reader, err := entry.Open()
			if err != nil {
				t.Fatal(err)
			}
			buffer := new(bytes.Buffer)
			_, err = buffer.ReadFrom(reader)
			reader.Close()
			if err != nil {
				t.Fatal(err)
			}
			actual, err := os.ReadFile(filepath.Join(destination, "assets", character, filepath.FromSlash(relative)))
			if err != nil {
				t.Fatal(err)
			}
			if name == "settings.json" {
				var a, b any
				if json.Unmarshal(actual, &a) != nil || json.Unmarshal(buffer.Bytes(), &b) != nil {
					t.Fatal("invalid settings")
				}
				expected, _ := json.Marshal(b)
				got, _ := json.Marshal(a)
				if !bytes.Equal(expected, got) {
					t.Fatalf("%s settings changed", character)
				}
			} else if !bytes.Equal(actual, buffer.Bytes()) {
				t.Fatalf("%s %s PNG bytes changed", character, name)
			}
		}
		archive.Close()
	}
}
