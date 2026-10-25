package preview

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

func TestFloor(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(home, ".code-foundry")
	f := NewFloor(home, paths.New(cfg))
	// A config home elsewhere under home makes its ancestors too broad as well.
	custom := NewFloor(home, paths.New(filepath.Join(home, "dev", "cf")))
	h := func(rel string) string { return filepath.Join(home, rel) }

	tests := []struct {
		name             string
		floor            Floor
		p                string
		guarded, scopeOK bool
	}{
		{"home", f, home, false, false},
		{"above home", f, filepath.Dir(home), false, false},
		{"project", f, h("src/app"), false, true},
		{"loose subfolder", f, h("Downloads"), false, true},
		{"config home", f, cfg, true, false},
		{"token", f, h(".code-foundry/daemon.token"), true, false},
		{"logs", f, h(".code-foundry/logs"), true, false},
		{"config home worktree", f, h(".code-foundry/worktrees/app/wt"), false, true},
		{"config home worktrees folder", f, h(".code-foundry/worktrees"), false, true},
		{"config home project", f, h(".code-foundry/projects/app"), false, true},
		{"a thread's pages", f, h(".code-foundry/pages/s-1"), false, true},
		{"a thread's page", f, h(".code-foundry/pages/s-1/form.html"), false, true},
		{"a thread's TMPDIR", f, h(".code-foundry/tmp/s-1"), true, false},
		{"ssh", f, h(".ssh"), true, false},
		{"ssh key", f, h(".ssh/id_ed25519"), true, false},
		{"library", f, h("Library/Application Support/x"), true, false},
		{"gh token", f, h(".config/gh/hosts.yml"), true, false},
		{"netrc", f, h(".netrc"), true, false},
		{"case-folded ssh", f, h(".SSH/id_rsa"), true, false},
		{"custom config home ancestor", custom, h("dev"), false, false},
		{"custom config home sibling", custom, h("dev/site"), false, true},
		{"custom config home token", custom, h("dev/cf/daemon.token"), true, false},
		{"outside home", f, "/etc", false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.floor.Guarded(tc.p); got != tc.guarded {
				t.Errorf("Guarded(%s) = %v, want %v", tc.p, got, tc.guarded)
			}
			if got := tc.floor.ScopeOK(tc.p); got != tc.scopeOK {
				t.Errorf("ScopeOK(%s) = %v, want %v", tc.p, got, tc.scopeOK)
			}
		})
	}
}

// TestFloorOtherHomes covers two daemons side by side: a test daemon under a custom
// CODE_FOUNDRY_HOME must not serve the default home, or another custom home it was never
// told about, to its pages.
func TestFloorOtherHomes(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := func(rel string) string { return filepath.Join(home, rel) }
	// cf-1 is a running daemon's home, cf-3 a stopped one's (only pages.port is left),
	// dev/cf-4 one inside a folder, deep/a/cf-5 one further down, and wt is a test home
	// inside the default home's worktrees.
	for _, rel := range []string{
		"cf-1/daemon.token", "cf-1/pages.port", "cf-1/db.sqlite", "cf-1/worktrees/app/index.html", "cf-1/pages/s-1/p.html",
		"cf-3/pages.port", "cf-3/db.sqlite",
		"dev/cf-4/daemon.token", "dev/site/index.html",
		"deep/a/cf-5/daemon.token", "deep/a/cf-5/db.sqlite", "deep/index.html",
		".code-foundry/worktrees/app/wt/home/daemon.token", ".code-foundry/worktrees/app/wt/index.html",
		"site/index.html",
	} {
		write(t, h(rel), "x")
	}
	for link, target := range map[string]string{"link": "cf-1", "site/cf": "cf-1", "loose/token.txt": "cf-1/daemon.token"} {
		if err := os.MkdirAll(filepath.Dir(h(link)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(h(target), h(link)); err != nil {
			t.Fatal(err)
		}
	}
	// The test daemon: its own home is cf-2; it knows the default home, nothing else.
	f := NewFloor(home, paths.New(h("cf-2")))

	tests := []struct {
		name             string
		p                string
		guarded, scopeOK bool
	}{
		{"own home", h("cf-2"), true, false},
		{"default home, absent on disk", h(".code-foundry"), true, false},
		{"default home token", h(".code-foundry/daemon.token"), true, false},
		{"default home db", h(".code-foundry/db.sqlite"), true, false},
		{"default home worktree", h(".code-foundry/worktrees/app"), false, true},
		{"default home pages", h(".code-foundry/pages/s-1"), false, true},
		{"other home", h("cf-1"), true, false},
		{"other home token", h("cf-1/daemon.token"), true, false},
		{"other home pages port", h("cf-1/pages.port"), true, false},
		{"other home db", h("cf-1/db.sqlite"), true, false},
		{"other home logs", h("cf-1/logs"), true, false},
		{"other home worktree", h("cf-1/worktrees/app"), false, true},
		{"other home page", h("cf-1/pages/s-1/p.html"), false, true},
		{"stopped home", h("cf-3"), true, false},
		{"stopped home db", h("cf-3/db.sqlite"), true, false},
		{"folder holding a home", h("dev"), false, false},
		{"that home's token", h("dev/cf-4/daemon.token"), true, false},
		{"its sibling", h("dev/site"), false, true},
		// Deeper than the direct children: the tree is allowed, the home inside it is not.
		{"folder holding a home further down", h("deep"), false, true},
		{"that home's db", h("deep/a/cf-5/db.sqlite"), true, false},
		{"home inside a worktree", h(".code-foundry/worktrees/app/wt/home"), true, false},
		{"that home's token", h(".code-foundry/worktrees/app/wt/home/daemon.token"), true, false},
		{"the worktree holding it", h(".code-foundry/worktrees/app/wt"), false, false},
		// Symlinks, unresolved: the markers are found through them.
		{"link to a home", h("link"), true, false},
		{"token through the link", h("link/daemon.token"), true, false},
		{"folder linking a home", h("site"), false, false},
		{"plain folder", h("loose"), false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := f.Guarded(tc.p); got != tc.guarded {
				t.Errorf("Guarded(%s) = %v, want %v", tc.p, got, tc.guarded)
			}
			if got := f.ScopeOK(tc.p); got != tc.scopeOK {
				t.Errorf("ScopeOK(%s) = %v, want %v", tc.p, got, tc.scopeOK)
			}
		})
	}
}
