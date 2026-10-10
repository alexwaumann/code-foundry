package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

func testSnapshot() *Snapshot {
	return &Snapshot{Workspaces: []Workspace{
		{ID: "w-000000000001", Name: "login", Branch: "cf/login", Members: []Member{
			{RepoID: "web", WorktreePath: "/wt/web/cf-login"},
			{RepoID: "api", WorktreePath: "/wt/api/cf-login"},
		}},
		{ID: "w-000000000002", Name: "nested", Branch: "cf/nested", Members: []Member{
			{RepoID: "lib", WorktreePath: "/wt/web/cf-login/vendor/lib"},
		}},
	}}
}

func TestResolveWorkspace(t *testing.T) {
	snap := testSnapshot()
	tests := []struct {
		name    string
		ref     Ref
		want    string
		wantErr error
	}{
		{"by id", Ref{Workspace: "w-000000000002"}, "nested", nil},
		{"by name", Ref{Workspace: "login"}, "login", nil},
		{"name wins over cwd", Ref{Workspace: "login", Cwd: "/wt/web/cf-login/vendor/lib"}, "login", nil},
		{"unknown name", Ref{Workspace: "nope"}, "", ErrNotFound},
		{"cwd at worktree root", Ref{Cwd: "/wt/api/cf-login"}, "login", nil},
		{"cwd below worktree", Ref{Cwd: "/wt/api/cf-login/src/x"}, "login", nil},
		{"deepest worktree wins", Ref{Cwd: "/wt/web/cf-login/vendor/lib/x"}, "nested", nil},
		{"sibling prefix is not inside", Ref{Cwd: "/wt/api/cf-login-2"}, "", ErrNotFound},
		{"cwd outside", Ref{Cwd: "/elsewhere"}, "", ErrNotFound},
		{"relative cwd", Ref{Cwd: "wt/api"}, "", ErrInvalidArgument},
		{"nothing given", Ref{}, "", ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w, err := ResolveWorkspace(snap, tt.ref)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if w.Name != tt.want {
				t.Fatalf("workspace = %q, want %q", w.Name, tt.want)
			}
		})
	}
}

func TestWithinResolvesSymlinks(t *testing.T) {
	real := t.TempDir()
	if err := os.MkdirAll(filepath.Join(real, "wt", "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		path, root string
		want       bool
	}{
		{filepath.Join(link, "wt", "src"), filepath.Join(real, "wt"), true},
		{filepath.Join(real, "wt"), filepath.Join(link, "wt"), true},
		{filepath.Join(real, "other"), filepath.Join(link, "wt"), false},
		{"", "/x", false},
		{"/x", "", false},
	}
	for _, tt := range tests {
		if got := within(tt.path, tt.root); got != tt.want {
			t.Errorf("within(%q, %q) = %v, want %v", tt.path, tt.root, got, tt.want)
		}
	}
}

func repoSnapshot() *repo.Snapshot {
	return &repo.Snapshot{Repos: []repo.Repo{
		{ID: "api", Name: "api", Path: "/src/api", Worktrees: []repo.Worktree{
			{RepoID: "api", Path: "/src/api", Branch: "main", IsMain: true},
			{RepoID: "api", Path: "/wt/api/cf-login", Branch: "cf/login"},
		}},
		{ID: "web", Name: "web", Path: "/src/web", Worktrees: []repo.Worktree{
			{RepoID: "web", Path: "/src/web", Branch: "main", IsMain: true},
			{RepoID: "web", Path: "/wt/web/cf-login", Detached: true},
		}},
		{ID: "dup1", Name: "dup", Path: "/a/dup"},
		{ID: "dup2", Name: "dup", Path: "/b/dup"},
	}}
}

func TestResolveRepo(t *testing.T) {
	snap := repoSnapshot()
	tests := []struct {
		name, ref, want string
		wantErr         error
		errText         string
	}{
		{"id", "web", "web", nil, ""},
		{"name", " api ", "api", nil, ""},
		{"ambiguous name", "dup", "", ErrInvalidArgument, "dup1 (/a/dup)"},
		{"ambiguous name by id", "dup2", "dup2", nil, ""},
		{"path in main worktree", "/src/web/pkg", "web", nil, ""},
		{"path in linked worktree", "/wt/api/cf-login/x", "api", nil, ""},
		{"repo without worktrees yet", "/b/dup", "dup2", nil, ""},
		{"unknown", "nope", "", ErrNotFound, "repo register"},
		{"empty", "", "", ErrInvalidArgument, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, err := resolveRepo(snap, tt.ref)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err != nil && !strings.Contains(err.Error(), tt.errText) {
				t.Fatalf("err = %v, want it to mention %q", err, tt.errText)
			}
			if r.ID != tt.want {
				t.Fatalf("repo = %q, want %q", r.ID, tt.want)
			}
		})
	}
}

func TestMemberFor(t *testing.T) {
	w := testSnapshot().Workspaces[0]
	snap := repoSnapshot()
	tests := []struct {
		name, ref, want string
		wantErr         error
	}{
		{"repo id", "api", "api", nil},
		{"repo name", "web", "web", nil},
		{"member worktree path", "/wt/web/cf-login/src", "web", nil},
		{"path in the repo's main worktree", "/src/api/x", "api", nil},
		{"not a member", "dup1", "", ErrNotFound},
		{"unknown", "nope", "", ErrNotFound},
		{"empty", "", "", ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, err := memberFor(w, snap, tt.ref)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if m.RepoID != tt.want {
				t.Fatalf("member = %q, want %q", m.RepoID, tt.want)
			}
		})
	}
}

func TestJoin(t *testing.T) {
	w := testSnapshot().Workspaces[0]
	w.Members = append(w.Members, Member{RepoID: "gone", WorktreePath: "/wt/gone/cf-login"})
	got := Join(w, repoSnapshot(), "/wt/api/cf-login/src")
	want := []MemberInfo{
		{Member: w.Members[0], RepoName: "web", Branch: "(detached)"},
		{Member: w.Members[1], RepoName: "api", Branch: "cf/login", Current: true},
		{Member: w.Members[2], Branch: "cf/login", Missing: true},
	}
	if len(got.Members) != len(want) {
		t.Fatalf("members = %+v", got.Members)
	}
	for i := range want {
		if got.Members[i] != want[i] {
			t.Errorf("member %d = %+v, want %+v", i, got.Members[i], want[i])
		}
	}
	if none := Join(w, nil, ""); none.Members[0].Current || !none.Members[0].Missing {
		t.Errorf("without repos: %+v", none.Members[0])
	}
}

func TestBranchFor(t *testing.T) {
	tests := []struct {
		name, wsName, branch, want string
		wantErr                    error
	}{
		{"derived", "Login fix: web + API", "", "cf/login-fix-web-api", nil},
		{"explicit", "x", " feat/login ", "feat/login", nil},
		{"long name is cut", strings.Repeat("ab-", 40), "", "cf/" + strings.TrimSuffix(strings.Repeat("ab-", 20), "-"), nil},
		{"nothing to slug", "!!!", "", "", ErrInvalidArgument},
		{"option-looking branch", "x", "-D", "", ErrInvalidArgument},
		{"branch with space", "x", "a b", "", ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := branchFor(tt.wsName, tt.branch)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err == nil && got != tt.want {
				t.Fatalf("branch = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCleanName(t *testing.T) {
	tests := []struct {
		in, want string
		wantErr  error
	}{
		{"  login  ", "login", nil},
		{"", "", ErrInvalidArgument},
		{"a\nb", "", ErrInvalidArgument},
		{strings.Repeat("x", 101), "", ErrInvalidArgument},
	}
	for _, tt := range tests {
		got, err := cleanName(tt.in)
		if !errors.Is(err, tt.wantErr) || got != tt.want {
			t.Errorf("cleanName(%q) = %q, %v; want %q, %v", tt.in, got, err, tt.want, tt.wantErr)
		}
	}
}

func TestThreadsIn(t *testing.T) {
	threads := []Thread{
		{ID: "s-1", Name: "fix-login", Cwd: "/wt/web/cf-login"},
		{ID: "s-2", Cwd: "/wt/web/cf-login/sub"},
		{ID: "s-3", Cwd: "/wt/web/cf-login-2"},
	}
	got := threadsIn(threads, "/wt/web/cf-login")
	if d := describeThreads(got); d != "thread fix-login (s-1), thread s-2" {
		t.Fatalf("threads = %q", d)
	}
	if got := threadsIn(threads, "/wt/api"); len(got) != 0 {
		t.Fatalf("threads in api = %+v", got)
	}
}
