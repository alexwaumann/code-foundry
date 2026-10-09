package repo

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// newLocalRepo creates a repository with one commit on main and no remote.
func newLocalRepo(t *testing.T) string {
	t.Helper()
	isolateGit(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "momentum")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q", "-b", "main")
	writeFile(t, filepath.Join(dir, "README.md"), "local\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")
	return dir
}

func TestRegisterReportsRemotes(t *testing.T) {
	tests := []struct {
		name string
		// setup returns the repository to register.
		setup       func(t *testing.T) string
		wantRemotes []string
		wantSlug    string
	}{
		{
			name:        "origin",
			setup:       func(t *testing.T) string { return newFixture(t).repo },
			wantRemotes: []string{"origin"},
		},
		{
			name:  "local-only",
			setup: newLocalRepo,
		},
		{
			name: "two remotes, sorted, no origin",
			setup: func(t *testing.T) string {
				dir := newLocalRepo(t)
				git(t, dir, "remote", "add", "upstream", "https://github.com/acme/momentum.git")
				git(t, dir, "remote", "add", "backup", "/nowhere/backup.git")
				return dir
			},
			// The slug comes from origin only.
			wantRemotes: []string{"backup", "upstream"},
		},
		{
			name: "origin on GitHub plus a fork",
			setup: func(t *testing.T) string {
				f := newFixture(t)
				git(t, f.repo, "remote", "set-url", "origin", "git@github.com:acme/proj.git")
				git(t, f.repo, "remote", "add", "fork", "git@github.com:me/proj.git")
				return f.repo
			},
			wantRemotes: []string{"fork", "origin"},
			wantSlug:    "acme/proj",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := tt.setup(t)
			h := startHarness(t, "", Options{})
			r, err := h.store.Register(context.Background(), dir)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(r.Remotes, tt.wantRemotes) || r.GitHubSlug != tt.wantSlug || r.Error != "" {
				t.Fatalf("remotes = %q, slug = %q, error = %q; want %q, %q", r.Remotes, r.GitHubSlug, r.Error, tt.wantRemotes, tt.wantSlug)
			}
			if r.DefaultBranch != "main" {
				t.Errorf("default branch = %q, want main", r.DefaultBranch)
			}
		})
	}
}

// Adding or removing a remote rewrites .git/config, which the watcher sees.
func TestRemoteChangesAreDetected(t *testing.T) {
	dir := newLocalRepo(t)
	h := startHarness(t, "", Options{})
	r, err := h.store.Register(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	remotesAre := func(want ...string) func(Event) bool {
		return func(ev Event) bool {
			u, ok := ev.(RepoUpdated)
			return ok && u.Repo.ID == r.ID && slices.Equal(u.Repo.Remotes, want)
		}
	}
	git(t, dir, "remote", "add", "origin", "https://github.com/acme/momentum.git")
	ev := h.waitFor("origin added", remotesAre("origin")).(RepoUpdated)
	if ev.Repo.GitHubSlug != "acme/momentum" {
		t.Errorf("slug = %q, want acme/momentum", ev.Repo.GitHubSlug)
	}
	git(t, dir, "remote", "remove", "origin")
	ev = h.waitFor("origin removed", remotesAre()).(RepoUpdated)
	if ev.Repo.GitHubSlug != "" {
		t.Errorf("slug = %q after removing origin", ev.Repo.GitHubSlug)
	}
}

// A new worktree in a local-only repo branches from the local default branch, and
// Fetch is a no-op: there is nothing to fetch from.
func TestCreateWorktreeFetchInLocalOnlyRepo(t *testing.T) {
	dir := newLocalRepo(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(filepath.Dir(dir), "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	refs, err := h.store.ListRefs(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if refs.DefaultRef != "main" || len(refs.Remote) != 0 {
		t.Fatalf("refs = %+v, want default main and no remote refs", refs)
	}
	w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "cf/try", Fetch: true})
	if err != nil {
		t.Fatal(err)
	}
	if n := cr.count("fetch"); n != 0 {
		t.Errorf("fetches = %d, want 0", n)
	}
	if want := git(t, dir, "rev-parse", "main"); w.Head != want || w.Branch != "cf/try" {
		t.Errorf("worktree = %+v, want cf/try at %s", w, want)
	}
}
