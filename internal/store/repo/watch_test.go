package repo

import (
	"reflect"
	"testing"

	"github.com/fsnotify/fsnotify"
)

func TestClassify(t *testing.T) {
	const (
		c = fsnotify.Create
		w = fsnotify.Write
		r = fsnotify.Remove
		n = fsnotify.Rename
		a = fsnotify.Chmod
	)
	tests := []struct {
		kind watchKind
		name string
		op   fsnotify.Op
		want action
	}{
		// lock files never trigger, whatever the directory
		{wkCommon, "index.lock", c, actNone},
		{wkCommon, "HEAD.lock", r, actNone},
		{wkRoot, "foo.lock", w, actNone},
		{wkRemoteRefs, "main.lock", c, actNone},

		// attribute-only events never trigger (git reading the index fires one)
		{wkCommon, "index", a, actNone},
		{wkLinkedAdmin, "index", a, actNone},
		{wkCommonLogs, "HEAD", a, actNone},
		{wkRemoteRefs, "main", a, actNone},
		{wkWorktreesDir, "x", a, actNone},

		{wkCommon, "HEAD", c, actStatus},
		{wkCommon, "index", c, actStatus},
		{wkCommon, "index", r, actStatus},
		{wkCommon, "FETCH_HEAD", w, actReconcile},
		{wkCommon, "packed-refs", c, actReconcile},
		{wkCommon, "config", w, actReconcile},
		{wkCommon, "worktrees", c, actReconcile},
		{wkCommon, "ORIG_HEAD", c, actNone},
		{wkCommon, "COMMIT_EDITMSG", w, actNone},
		{wkCommon, "objects", c, actNone},

		{wkCommonLogs, "HEAD", w, actStatus},
		{wkCommonLogs, "refs", c, actNone},
		{wkLinkedLogs, "HEAD", w, actStatus},

		{wkLinkedAdmin, "HEAD", c, actStatus},
		{wkLinkedAdmin, "index", c, actStatus},
		{wkLinkedAdmin, "gitdir", w, actNone},
		{wkLinkedAdmin, "locked", c, actNone},

		{wkRemoteRefs, "main", c, actStatusAll},
		{wkRemoteRefs, "feature", w, actStatusAll},

		{wkWorktreesDir, "feat-a", c, actReconcile},
		{wkWorktreesDir, "feat-a", r, actReconcile},
		{wkWorktreesDir, "feat-a", n, actReconcile},
		{wkWorktreesDir, "feat-a", w, actNone},

		{wkRoot, "main.go", w, actStatus},
		{wkRoot, "new.txt", c, actStatus},
		{wkRoot, "old.txt", r, actStatus},
		{wkRoot, "old.txt", n, actStatus},
		{wkRoot, "main.go", a, actNone},
		{wkRoot, "main.go", w | a, actStatus},
		{wkRoot, ".git", w, actNone},
	}
	for _, tt := range tests {
		if got := classify(tt.kind, tt.name, tt.op); got != tt.want {
			t.Errorf("classify(%v, %q, %v) = %v, want %v", tt.kind, tt.name, tt.op, got, tt.want)
		}
	}
}

func TestDesiredWatches(t *testing.T) {
	got := desiredWatches("r1", "/c/repo", "/c/repo/.git", []watchWorktree{
		{path: "/c/repo", isMain: true},
		{path: "/c/repo.worktrees/feat", admin: "/c/repo/.git/worktrees/feat"},
		{path: "/c/elsewhere", admin: ""}, // .git file unreadable: root only
	})
	want := map[string]watchTarget{
		"/c/repo/.git":                     {kind: wkCommon, repoID: "r1", wtPath: "/c/repo"},
		"/c/repo/.git/logs":                {kind: wkCommonLogs, repoID: "r1", wtPath: "/c/repo"},
		"/c/repo/.git/refs/remotes/origin": {kind: wkRemoteRefs, repoID: "r1"},
		"/c/repo/.git/worktrees":           {kind: wkWorktreesDir, repoID: "r1"},
		"/c/repo":                          {kind: wkRoot, repoID: "r1", wtPath: "/c/repo"},
		"/c/repo.worktrees/feat":           {kind: wkRoot, repoID: "r1", wtPath: "/c/repo.worktrees/feat"},
		"/c/repo/.git/worktrees/feat":      {kind: wkLinkedAdmin, repoID: "r1", wtPath: "/c/repo.worktrees/feat"},
		"/c/repo/.git/worktrees/feat/logs": {kind: wkLinkedLogs, repoID: "r1", wtPath: "/c/repo.worktrees/feat"},
		"/c/elsewhere":                     {kind: wkRoot, repoID: "r1", wtPath: "/c/elsewhere"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
}

func TestParseGitFile(t *testing.T) {
	tests := []struct {
		wt, content, want string
		wantErr           bool
	}{
		{"/w", "gitdir: /r/.git/worktrees/w\n", "/r/.git/worktrees/w", false},
		{"/a/w", "gitdir: ../r/.git/worktrees/w", "/a/r/.git/worktrees/w", false},
		{"/w", "nonsense", "", true},
	}
	for _, tt := range tests {
		got, err := parseGitFile(tt.wt, tt.content)
		if (err != nil) != tt.wantErr || got != tt.want {
			t.Errorf("parseGitFile(%q, %q) = %q, %v", tt.wt, tt.content, got, err)
		}
	}
}
