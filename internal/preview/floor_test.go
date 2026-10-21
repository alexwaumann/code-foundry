package preview

import (
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
