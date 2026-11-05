package preview

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/fsx"
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

// TestFloorInConfigHome covers what a write may not reach: the config home, known or found
// by its markers, outside its checkouts. Nothing of the credential list counts.
func TestFloorInConfigHome(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := func(rel string) string { return filepath.Join(home, rel) }
	for _, rel := range []string{
		".code-foundry/daemon.token", ".code-foundry/db.sqlite", ".code-foundry/projects/app/main.go",
		".code-foundry/worktrees/app/wt/main.go", ".code-foundry/pages/s-1/form.html",
		"cf-1/daemon.token", "cf-1/worktrees/app/main.go",
		".code-foundry/worktrees/app/test-home/daemon.token",
		".ssh/id_ed25519", ".aws/credentials", ".config/gh/hosts.yml", "src/app/main.go",
	} {
		write(t, h(rel), "x")
	}
	for link, target := range map[string]string{
		".code-foundry/projects/app/token": ".code-foundry/daemon.token",
		"src/app/cf":                       ".code-foundry",
	} {
		if err := os.Symlink(h(target), h(link)); err != nil {
			t.Fatal(err)
		}
	}
	// A daemon with its own home knows the default one and finds cf-1 by its token.
	f := NewFloor(home, paths.New(h("cf-2")))

	tests := []struct {
		name string
		p    string
		want bool
	}{
		{"default home", h(".code-foundry"), true},
		{"token", h(".code-foundry/daemon.token"), true},
		{"database", h(".code-foundry/db.sqlite"), true},
		{"a new file", h(".code-foundry/new.txt"), true},
		{"a thread's page", h(".code-foundry/pages/s-1/form.html"), true},
		{"its folder of worktrees", h(".code-foundry/worktrees"), true},
		{"a worktree's file", h(".code-foundry/worktrees/app/wt/main.go"), false},
		{"a project's file", h(".code-foundry/projects/app/main.go"), false},
		{"a new file in a project", h(".code-foundry/projects/app/new.go"), false},
		{"a link out of a project to the token", h(".code-foundry/projects/app/token"), true},
		{"a linked config home", h("src/app/cf/daemon.token"), true},
		{"a linked config home's project", h("src/app/cf/projects/app/main.go"), false},
		{"own home, not on disk", h("cf-2/db.sqlite"), true},
		{"another home's token", h("cf-1/daemon.token"), true},
		{"another home's worktree", h("cf-1/worktrees/app/main.go"), false},
		{"a test home inside a worktree", h(".code-foundry/worktrees/app/test-home/daemon.token"), true},
		{"ssh key", h(".ssh/id_ed25519"), false},
		{"aws credentials", h(".aws/credentials"), false},
		{"gh token", h(".config/gh/hosts.yml"), false},
		{"a project elsewhere", h("src/app/main.go"), false},
		{"a sibling with the same prefix", h(".code-foundry-notes/a.md"), false},
		{"outside home", "/etc/hosts", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := f.InConfigHome(tc.p); got != tc.want {
				t.Errorf("InConfigHome(%s) = %v, want %v", tc.p, got, tc.want)
			}
		})
	}
}

// TestFloorInConfigHomeOpenRoots covers the folders checkouts go in, which do not exist
// until first use: a write may reach below them but never take their names, while a grant
// may still name them.
func TestFloorInConfigHomeOpenRoots(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := func(rel string) string { return filepath.Join(home, rel) }
	write(t, h(".code-foundry/daemon.token"), "x")
	write(t, h("cf-1/daemon.token"), "x")
	write(t, h("cf-3/daemon.token"), "x")
	write(t, h("cf-3/worktrees/app/main.go"), "x")
	f := NewFloor(home, paths.New(h(".code-foundry")))

	tests := []struct {
		name          string
		p             string
		want, guarded bool
	}{
		{"projects, missing", h(".code-foundry/projects"), true, false},
		{"worktrees, missing", h(".code-foundry/worktrees"), true, false},
		{"worktrees, another case", h(".code-foundry/WORKTREES"), true, false},
		{"projects, another case", h(".code-foundry/Projects"), true, false},
		{"pages, missing", h(".code-foundry/pages"), true, false},
		{"below missing projects", h(".code-foundry/projects/app/main.go"), false, false},
		{"below missing worktrees", h(".code-foundry/worktrees/app/main.go"), false, false},
		{"below worktrees, another case", h(".code-foundry/WORKTREES/app/main.go"), false, false},
		{"a found home's projects, missing", h("cf-1/projects"), true, false},
		{"a found home's worktrees, existing", h("cf-3/worktrees"), true, false},
		{"below a found home's worktrees", h("cf-3/worktrees/app/main.go"), false, false},
		{"not an open root", h(".code-foundry/logs"), true, true},
		{"a folder of that name elsewhere", h("src/projects"), false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := f.InConfigHome(tc.p); got != tc.want {
				t.Errorf("InConfigHome(%s) = %v, want %v", tc.p, got, tc.want)
			}
			if got := f.Guarded(tc.p); got != tc.guarded {
				t.Errorf("Guarded(%s) = %v, want %v", tc.p, got, tc.guarded)
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

// tempFloor is a floor with a temp folder as macOS has it: base/tmp, a link, and
// base/private/tmp behind it.
func tempFloor(t *testing.T) (f Floor, at func(string) string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	at = func(p string) string { return filepath.Join(base, p) }
	if err := os.MkdirAll(at("private/tmp"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(at("private/tmp"), at("tmp")); err != nil {
		t.Fatal(err)
	}
	home := at("home")
	return NewFloor(home, paths.New(filepath.Join(home, ".code-foundry"))).WithTemp([]string{at("tmp"), at("private/tmp")}), at
}

// A temp folder is everyone's, so it is never a tree; what is below it may be, unless it
// holds a config home, which a scratch daemon's may do there as anywhere.
func TestFloorTemp(t *testing.T) {
	f, at := tempFloor(t)
	for _, p := range []string{
		"private/tmp/foo/sub/page.html", "private/tmp/page.html", "elsewhere/page.html",
		"private/tmp/cf-drive/daemon.token", "private/tmp/cf-drive/db.sqlite", "private/tmp/cf-drive/page.html",
		"private/tmp/cf-drive/worktrees/app/index.html", "private/tmp/cf-drive/pages/s-1/page.html",
		"private/tmp/holder/cf-1/pages.port", "home/.ssh/id_rsa",
	} {
		write(t, at(p), "x")
	}
	for link, target := range map[string]string{
		"private/tmp/loop":   "private/tmp",
		"private/tmp/up":     "private",
		"private/tmp/to-ssh": "home/.ssh",
		"private/tmp/to-cf":  "private/tmp/cf-drive",
	} {
		if err := os.Symlink(at(target), at(link)); err != nil {
			t.Fatal(err)
		}
	}
	scopes := []struct {
		name, dir string
		want      bool
	}{
		{"the temp folder", "tmp", false},
		{"the temp folder, resolved", "private/tmp", false},
		{"above it", "private", false},
		{"a folder in it", "tmp/foo", true},
		{"a folder in it, resolved", "private/tmp/foo", true},
		{"deeper", "private/tmp/foo/sub", true},
		{"a link back to it", "tmp/loop", false},
		{"a link above it", "tmp/up", false},
		{"a config home", "tmp/cf-drive", false},
		{"a config home, resolved", "private/tmp/cf-drive", false},
		{"a link to a config home", "tmp/to-cf", false},
		{"what holds a config home", "tmp/holder", false},
		{"a config home's worktree", "tmp/cf-drive/worktrees/app", true},
		{"a link to a guarded folder", "tmp/to-ssh", false},
		{"elsewhere", "elsewhere", false},
	}
	for _, tt := range scopes {
		t.Run("scope "+tt.name, func(t *testing.T) {
			if got := f.ScopeOK(at(tt.dir)); got != tt.want {
				t.Errorf("ScopeOK(%s) = %t, want %t", tt.dir, got, tt.want)
			}
		})
	}
	guarded := []struct {
		name, p string
		want    bool
	}{
		{"a page", "tmp/page.html", false},
		{"a token", "tmp/cf-drive/daemon.token", true},
		{"a token, resolved", "private/tmp/cf-drive/daemon.token", true},
		{"a database", "tmp/cf-drive/db.sqlite", true},
		{"a file beside them", "tmp/cf-drive/page.html", true},
		{"a checkout", "tmp/cf-drive/worktrees/app/index.html", false},
		{"pages", "tmp/cf-drive/pages/s-1/page.html", false},
		{"a home below a folder", "tmp/holder/cf-1/pages.port", true},
		{"through a link to ~/.ssh", "tmp/to-ssh/id_rsa", true},
	}
	for _, tt := range guarded {
		t.Run("guarded "+tt.name, func(t *testing.T) {
			if got := f.Guarded(at(tt.p)); got != tt.want {
				t.Errorf("Guarded(%s) = %t, want %t", tt.p, got, tt.want)
			}
		})
	}
	// Without the temp folders the floor is home's alone.
	home := NewFloor(at("home"), paths.New(at("home/.code-foundry")))
	if home.ScopeOK(at("tmp/foo")) {
		t.Error("a floor without temp folders took a tree in one")
	}
}

// A TMPDIR inside a project is no temp folder (fsx.TempRoots), so the project stays a tree.
func TestFloorTempDirInHome(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	proj := filepath.Join(home, "proj")
	write(t, filepath.Join(proj, ".tmp", "x"), "x")
	t.Setenv("TMPDIR", filepath.Join(proj, ".tmp"))
	f := NewFloor(home, paths.New(filepath.Join(home, ".code-foundry"))).WithTemp(fsx.TempRoots(home))
	if !f.ScopeOK(proj) {
		t.Errorf("%s stopped being a tree with its own .tmp as TMPDIR", proj)
	}
}

// A marker anyone can drop in a temp folder itself guards nothing there; one in a folder below
// it still guards that folder.
func TestFloorTempRootMarker(t *testing.T) {
	f, at := tempFloor(t)
	marker := homeMarkers[0]
	write(t, at("private/tmp/foo/page.html"), "<p>page</p>")
	write(t, at("private/tmp/"+marker), "")
	write(t, at("private/tmp/cfg/"+marker), "t")
	write(t, at("private/tmp/cfg/db.sqlite"), "secret")
	for _, p := range []string{"private/tmp/foo/page.html", "tmp/foo/page.html"} {
		if f.Guarded(at(p)) {
			t.Errorf("Guarded(%s) = true, want false", p)
		}
	}
	if !f.ScopeOK(at("private/tmp/foo")) {
		t.Error("ScopeOK(foo) = false: a marker in the temp folder closed its trees")
	}
	if !f.Guarded(at("private/tmp/cfg/db.sqlite")) {
		t.Error("Guarded(cfg/db.sqlite) = false, want true")
	}
}
