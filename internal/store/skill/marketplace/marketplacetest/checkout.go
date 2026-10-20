// Package marketplacetest builds marketplace checkouts for tests: the fixture tree in
// ../testdata/registry, committed with fixed dates so per-directory versions are
// deterministic.
package marketplacetest

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The fixture's history: Initial adds every file, then PRReview edits
// enterprise/skills/pr-review and Catalog edits the enterprise-data plugin's catalog
// skill.
var (
	Initial  = time.Date(2026, 1, 10, 9, 0, 0, 0, time.UTC)
	PRReview = time.Date(2026, 3, 5, 12, 0, 0, 0, time.UTC)
	Catalog  = time.Date(2026, 4, 1, 8, 30, 0, 0, time.UTC)
)

// Fixture is the fixture tree's path.
func Fixture() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "testdata", "registry")
}

// Checkout copies the fixture into a new temporary directory, commits it as Initial,
// PRReview and Catalog, and returns the checkout's path.
func Checkout(t testing.TB) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "ai-marketplace")
	if err := os.CopyFS(dir, os.DirFS(Fixture())); err != nil {
		t.Fatal(err)
	}
	Git(t, dir, time.Time{}, "init", "-q", "-b", "main")
	Git(t, dir, Initial, "add", "-A")
	Git(t, dir, Initial, "commit", "-q", "-m", "initial")
	Commit(t, dir, PRReview, map[string]string{
		"enterprise/skills/pr-review/SKILL.md": appendTo(t, dir, "enterprise/skills/pr-review/SKILL.md", "\nMore checks.\n"),
	})
	Commit(t, dir, Catalog, map[string]string{
		"enterprise/c1-claude-code-marketplace/enterprise-data/skills/catalog/SKILL.md": appendTo(t, dir,
			"enterprise/c1-claude-code-marketplace/enterprise-data/skills/catalog/SKILL.md", "\nMore tables.\n"),
	})
	return dir
}

// Commit writes files (repo-relative path → content) in dir and commits them at at.
func Commit(t testing.TB, dir string, at time.Time, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	Git(t, dir, at, "add", "-A")
	Git(t, dir, at, "commit", "-q", "-m", "change at "+at.Format(time.RFC3339))
}

// Git runs git in dir with the author and committer dates set to at (when not zero),
// isolated from the user's git configuration, and returns its trimmed stdout.
func Git(t testing.TB, dir string, at time.Time, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com",
		"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if !at.IsZero() {
		d := at.Format(time.RFC3339)
		cmd.Env = append(cmd.Env, "GIT_AUTHOR_DATE="+d, "GIT_COMMITTER_DATE="+d)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func appendTo(t testing.TB, dir, rel, more string) string {
	t.Helper()
	b, err := fs.ReadFile(os.DirFS(dir), rel)
	if err != nil {
		t.Fatal(err)
	}
	return string(b) + more
}
