package session

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/claudestream/fakeclaude"
)

const fakeClaudeEnv = fakeclaude.Env

// fakeClaudeBin is the fake `claude -p` (cmd/fakeclaude), built once per test run by
// TestMain. It is a separate, uninstrumented binary on purpose: under -race a process
// start costs about a second on macOS, and this package starts a few hundred.
var fakeClaudeBin string

// fakeSpawn is what a fake claude process recorded about itself (CF_FAKE_CLAUDE_SPAWN).
type fakeSpawn = fakeclaude.Spawn

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakeclaude")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fakeClaudeBin = filepath.Join(dir, "claude")
	build := exec.Command("go", "build", "-o", fakeClaudeBin, "github.com/alexwaumann/code-foundry/cmd/fakeclaude")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "build cmd/fakeclaude:", err)
		os.Exit(2)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func fixturePath(name string) string {
	p, _ := filepath.Abs(filepath.Join("..", "..", "claudestream", "testdata", name+".jsonl"))
	return p
}
