package portal

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestLivingGamesNavigationWebLifecycle runs the LIVING navigation tests and
// the adjacent LIVING view/WORLD contract tests from the repository's Node suite.
func TestLivingGamesNavigationWebLifecycle(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("node is required in CI to test LIVING Games navigation: %v", err)
		}
		t.Skipf("node not found; skipping LIVING Games navigation tests: %v", err)
	}

	testFiles := []string{
		"games_catalog.test.js",
		"living_games_navigation.test.js",
		"living_portal.test.js",
		"living_legacy_rest.test.js",
		"living_world_home.test.js",
	}
	args := []string{"--test"}
	var firstScript string
	for _, name := range testFiles {
		script, err := filepath.Abs(filepath.Join("webtest", name))
		if err != nil {
			t.Fatalf("resolve %s: %v", name, err)
		}
		if firstScript == "" {
			firstScript = script
		}
		args = append(args, script)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, args...)
	cmd.Dir = filepath.Dir(firstScript)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node LIVING Games navigation tests failed: %v\n%s", err, out)
	}
	t.Logf("Node LIVING tests output:\n%s", out)
}
