package portal

import (
	"bytes"
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Exercise the real embed and static route, rather than only checking files
// on disk: an omitted frame would otherwise disappear only after deployment.
func TestLivingHobbyCatalogAndEveryFrameAreServed(t *testing.T) {
	handler, err := NewHandler(DefaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	const base = "/assets/living/assets/hobbies/"
	get := func(name string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, base+name, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("asset %s status %d", name, rec.Code)
		}
		return rec
	}
	var catalog struct {
		Version    int `json:"version"`
		Characters []struct {
			Character string `json:"character"`
			Assets    []struct {
				ID        string `json:"id"`
				ImagePath string `json:"image_path"`
			} `json:"assets"`
		} `json:"characters"`
	}
	if err := json.Unmarshal(get("catalog.json").Body.Bytes(), &catalog); err != nil {
		t.Fatal(err)
	}
	if catalog.Version != 1 || len(catalog.Characters) != 4 {
		t.Fatalf("catalog version/characters = %d/%d", catalog.Version, len(catalog.Characters))
	}
	want := map[string]int{"Mio": 6, "Shiro": 6, "Kuro": 5, "Midori": 5}
	for _, character := range catalog.Characters {
		count, ok := want[character.Character]
		if !ok || len(character.Assets) != count {
			t.Fatalf("unexpected character/frame count %s/%d", character.Character, len(character.Assets))
		}
		delete(want, character.Character)
		seen := make(map[string]bool)
		for _, frame := range character.Assets {
			if frame.ID == "" || seen[frame.ID] || !strings.HasPrefix(frame.ImagePath, character.Character+"/sprites/") {
				t.Fatalf("invalid frame identity/path: %+v", frame)
			}
			seen[frame.ID] = true
			rec := get(frame.ImagePath)
			if !strings.HasPrefix(rec.Header().Get("Content-Type"), "image/png") {
				t.Fatalf("frame %s content type %s", frame.ID, rec.Header().Get("Content-Type"))
			}
			cfg, err := png.DecodeConfig(bytes.NewReader(rec.Body.Bytes()))
			if err != nil || cfg.Width != 320 || cfg.Height != 320 {
				t.Fatalf("frame %s dimensions %+v, error %v", frame.ID, cfg, err)
			}
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing characters: %v", want)
	}
}
