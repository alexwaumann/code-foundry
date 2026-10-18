package daemon_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/client"
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
	for i := 0; ; i++ {
		if _, err := client.ReadEndpoint(p); err == nil {
			break
		}
		if i > 200 {
			t.Fatalf("daemon did not start: %v", err)
		}
		time.Sleep(25 * time.Millisecond)
	}

	if b, err := os.ReadFile(filepath.Join(p.Claude(), "VERSION")); err != nil || string(b) != "v1.2.3-test\n" {
		t.Errorf("VERSION = %q, %v", b, err)
	}
	skills := filepath.Join(p.Claude(), ".claude", "skills")
	for _, f := range []string{
		"code-foundry-orchestrate/SKILL.md", "code-foundry-orchestrate/reference/commands.md",
		"code-foundry-help/SKILL.md", "code-foundry-help/reference/settings.md",
		"code-foundry-plugin/SKILL.md", "code-foundry-plugin/reference/cli.md", "code-foundry-plugin/example/main.go",
	} {
		b, err := os.ReadFile(filepath.Join(skills, f))
		if err != nil || len(b) == 0 {
			t.Errorf("%s: %d bytes, %v", f, len(b), err)
		}
	}
	// The plugin skill copies the example from where it is installed; a test build has
	// no commit, so it pins the SDK at main.
	plug, _ := os.ReadFile(filepath.Join(skills, "code-foundry-plugin/SKILL.md"))
	for _, want := range []string{"cp -R " + filepath.Join(skills, "code-foundry-plugin/example") + "/. .", "pluginsdk@main"} {
		if !strings.Contains(string(plug), want) {
			t.Errorf("code-foundry-plugin/SKILL.md lacks %q", want)
		}
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("the old skill is still there: %v", err)
	}
	// thread.new's model and effort defaults come from the settings at start; the files
	// leave the value out (it would go stale) and keep the setting's name.
	b, _ := os.ReadFile(filepath.Join(skills, "code-foundry-orchestrate/reference/commands.md"))
	model := ""
	for line := range strings.Lines(string(b)) {
		if strings.HasPrefix(line, "  - `--model ") && model == "" {
			model = line
		}
	}
	if !strings.Contains(model, "(default: settings threads.default_model)") || strings.Contains(model, "(default \"") {
		t.Errorf("thread.new's --model line: %q", model)
	}
}
