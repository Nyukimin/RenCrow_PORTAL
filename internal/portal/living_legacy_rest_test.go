package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLivingLegacyRestRelayAndRecovery(t *testing.T) {
	activity := map[string]any{"kind": "rest", "label": "休憩中", "phase": "resting", "revision": 1}
	actor := map[string]any{"actor_id": "ao", "state": "running", "activity_kind": "routine", "routine_availability": "available", "ongoing_activity": "rest", "current_activity": activity}
	body := func() []byte {
		agents := make([]map[string]any, 0, 8)
		for _, id := range []string{"mio", "shiro", "kuro", "midori", "aka", "ao", "kin", "gin"} {
			entry := map[string]any{"actor_id": id, "state": "waiting"}
			if id == "ao" {
				entry = actor
			}
			agents = append(agents, entry)
		}
		encoded, err := json.Marshal(map[string]any{"observed_at": "2026-11-26T08:00:00Z", "agents": agents})
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/viewer/living/heartbeat" || r.Header.Get(interactionProfileHeader) != "portal-living" {
			t.Error("incorrect CORE relay path or profile")
		}
		_, _ = w.Write(body())
	}))
	defer core.Close()
	cfg := DefaultConfig()
	cfg.CoreURL = core.URL
	handler, err := NewHandler(cfg)
	if err != nil {
		t.Fatal(err)
	}
	request := func(want int) {
		t.Helper()
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/living/heartbeat", nil))
		if rec.Code != want {
			t.Fatalf("status=%d body=%s, want %d", rec.Code, rec.Body.String(), want)
		}
		if want == http.StatusOK {
			var got livingHeartbeatResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || len(got.Agents) != 8 {
				t.Fatalf("missing eight-actor projection: %s", rec.Body.String())
			}
			current, err := parseLivingCurrentActivity(got.Agents[5].CurrentActivityRaw, "ao")
			if err != nil || current.Kind != "rest" || current.Label != "休憩中" {
				t.Fatalf("rest descriptor lost: %v %v", current, err)
			}
		}
	}
	request(http.StatusOK)
	actor["state"] = "waiting"
	request(http.StatusOK)
	actor["state"] = "running"
	for _, mutation := range []struct {
		key   string
		value any
	}{
		{"current_activity", nil}, {"activity_kind", "private"}, {"routine_availability", "disabled"},
		{"state", "checking"}, {"ongoing_activity", "sleep_window"},
	} {
		before := actor[mutation.key]
		actor[mutation.key] = mutation.value
		request(http.StatusServiceUnavailable)
		actor[mutation.key] = before
	}
	for _, mutation := range []struct {
		key   string
		value any
	}{
		{"kind", "unknown"}, {"label", "private"}, {"phase", "sleeping"}, {"revision", 0}, {"task_id", "private"},
	} {
		before, exists := activity[mutation.key]
		activity[mutation.key] = mutation.value
		request(http.StatusServiceUnavailable)
		if exists {
			activity[mutation.key] = before
		} else {
			delete(activity, mutation.key)
		}
	}
	request(http.StatusOK)
}
