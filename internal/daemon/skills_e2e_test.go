package daemon_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// A starting daemon writes the skills into <home>/claude before it serves, replacing
// what an older one left there.
func TestDaemonInstallsSkills(t *testing.T) {
	// Socket paths must fit in 104 bytes, so the home lives under /tmp.
	home, err := os.MkdirTemp("/tmp", "cf-skills-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("HOME", t.TempDir())
	p := paths.New(home)
	stale := filepath.Join(p.Claude(), ".claude", "skills", "code-foundry-old", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(stale), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Info{Version: "v1.2.3-test"}})
	}()
	t.Cleanup(func() {
		stop()
		<-done
	})
	waitEndpoint(t, p)

	if b, err := os.ReadFile(filepath.Join(p.Claude(), "VERSION")); err != nil || string(b) != "v1.2.3-test\n" {
		t.Errorf("VERSION = %q, %v", b, err)
	}
	skills := filepath.Join(p.Claude(), ".claude", "skills")
	for _, f := range []string{
		"code-foundry-orchestrate/SKILL.md", "code-foundry/reference/commands.md",
		"code-foundry-help/SKILL.md", "code-foundry-help/reference/settings.md",
		"code-foundry-plugin/SKILL.md", "code-foundry-plugin/reference/cli.md", "code-foundry-plugin/example/main.go",
	} {
		b, err := os.ReadFile(filepath.Join(skills, f))
		if err != nil || len(b) == 0 {
			t.Errorf("%s: %d bytes, %v", f, len(b), err)
		}
	}
	// The plugin skill restores the example's workflows from where it is installed; a test
	// build has no commit, so it pins the SDK at main.
	plug, _ := os.ReadFile(filepath.Join(skills, "code-foundry-plugin/SKILL.md"))
	if !strings.Contains(string(plug), "pluginsdk@main") {
		t.Error("code-foundry-plugin/SKILL.md lacks pluginsdk@main")
	}
	pub, _ := os.ReadFile(filepath.Join(skills, "code-foundry-plugin/reference/publishing.md"))
	if want := "cp -R " + filepath.Join(skills, "code-foundry-plugin/example") + "/.github ."; !strings.Contains(string(pub), want) {
		t.Errorf("code-foundry-plugin/reference/publishing.md lacks %q", want)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("the old skill is still there: %v", err)
	}
	// The file lists what the running daemon registered.
	b, _ := os.ReadFile(filepath.Join(skills, "code-foundry/reference/commands.md"))
	if !strings.Contains(string(b), "- `thread.new` ") {
		t.Errorf("the command index lacks thread.new:\n%s", b)
	}
}
