package project

import (
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/fsnotify/fsevents"
)

func TestClassify(t *testing.T) {
	const (
		c = opCreate
		w = opWrite
		r = opRemove
		n = opRename
		a = opChmod
	)
	tests := []struct {
		kind watchKind
		name string
		op   op
		want action
	}{
		// git's lock files never trigger, except <common>/config.lock appearing (config
		// is about to be rewritten)
		{wkCommon, "index.lock", c, actNone},
		{wkCommon, "HEAD.lock", r, actNone},
		{wkRemoteRefs, "main.lock", c, actNone},
		{wkLinkedAdmin, "HEAD.lock", c | w | n, actNone},
		{wkCommon, "config.lock", c, actReconcile},
		{wkCommon, "config.lock", c | r | w, actReconcile}, // FSEvents flags accumulate
		{wkCommon, "config.lock", r, actNone},
		{wkCommon, "config.lock", w, actNone},
		// ...but in a worktree a .lock file is the user's (Cargo.lock, yarn.lock)
		{wkRoot, "Cargo.lock", w, actStatus},

		// attribute-only events never trigger
		{wkCommon, "index", a, actNone},
		{wkLinkedAdmin, "index", a, actNone},
		{wkCommonLogs, "HEAD", a, actNone},
		{wkRemoteRefs, "main", a, actNone},
		{wkWorktreesDir, "x", a, actNone},

		{wkCommon, "HEAD", c, actStatus},
		{wkCommon, "index", c, actStatus},
		{wkCommon, "index", n, actStatus}, // index.lock renamed onto index
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

		// operation markers (operation.go) in either admin dir
		{wkCommon, "rebase-merge", c, actStatus},
		{wkCommon, "rebase-merge", r, actStatus},
		{wkCommon, "rebase-apply", c, actStatus},
		{wkCommon, "MERGE_HEAD", c, actStatus},
		{wkCommon, "MERGE_HEAD", r, actStatus},
		{wkCommon, "CHERRY_PICK_HEAD", c, actStatus},
		{wkCommon, "REVERT_HEAD", r, actStatus},
		{wkCommon, "BISECT_LOG", c, actStatus},
		{wkCommon, "MERGE_HEAD", a, actNone},
		{wkCommon, "MERGE_HEAD.lock", c, actNone},
		{wkLinkedAdmin, "rebase-merge", c, actStatus},
		{wkLinkedAdmin, "MERGE_HEAD", r, actStatus},
		{wkRoot, "MERGE_HEAD", c, actStatus}, // a plain file in the worktree, as before
		{wkCommonLogs, "MERGE_HEAD", c, actNone},

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

		{wkPlainRoot, ".git", c, actReconcile},
		{wkPlainRoot, ".git", n, actReconcile},
		{wkPlainRoot, ".git", w, actNone},
		{wkPlainRoot, "notes.txt", c | w, actNone},
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
		"/c/repo/.git":                     {kind: wkCommon, projectID: "r1", wtPath: "/c/repo"},
		"/c/repo/.git/logs":                {kind: wkCommonLogs, projectID: "r1", wtPath: "/c/repo"},
		"/c/repo/.git/refs/remotes/origin": {kind: wkRemoteRefs, projectID: "r1"},
		"/c/repo/.git/worktrees":           {kind: wkWorktreesDir, projectID: "r1"},
		"/c/repo":                          {kind: wkRoot, projectID: "r1", wtPath: "/c/repo"},
		"/c/repo.worktrees/feat":           {kind: wkRoot, projectID: "r1", wtPath: "/c/repo.worktrees/feat"},
		"/c/repo/.git/worktrees/feat":      {kind: wkLinkedAdmin, projectID: "r1", wtPath: "/c/repo.worktrees/feat"},
		"/c/repo/.git/worktrees/feat/logs": {kind: wkLinkedLogs, projectID: "r1", wtPath: "/c/repo.worktrees/feat"},
		"/c/elsewhere":                     {kind: wkRoot, projectID: "r1", wtPath: "/c/elsewhere"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
}

// fakeRoutes is a routing table for two projects with fake roots: "p" at /h/p with a
// managed worktree, a hand-made one outside every root, and one nested inside the
// main checkout; "q" without git at /h/q.
func fakeRoutes() map[string]watchTarget {
	dirs := desiredWatches("p", "/h/p", "/h/p/.git", []watchWorktree{
		{path: "/h/p", isMain: true},
		{path: "/w/o/p/feat", admin: "/h/p/.git/worktrees/feat"},
		{path: "/x/hand", admin: "/h/p/.git/worktrees/hand"},
		{path: "/h/p/.claude/worktrees/agent", admin: "/h/p/.git/worktrees/agent"},
	})
	dirs["/h/q"] = watchTarget{kind: wkPlainRoot, projectID: "q", wtPath: "/h/q"}
	return dirs
}

func TestEventKeys(t *testing.T) {
	const (
		created  = fsevents.ItemCreated | fsevents.ItemIsFile
		modified = fsevents.ItemCreated | fsevents.ItemModified | fsevents.ItemXattrMod | fsevents.ItemIsFile
		renamed  = fsevents.ItemRenamed | fsevents.ItemIsFile
		removed  = fsevents.ItemRemoved | fsevents.ItemIsFile
		dirGone  = fsevents.ItemCreated | fsevents.ItemRemoved | fsevents.ItemIsDir
		dirNew   = fsevents.ItemCreated | fsevents.ItemXattrMod | fsevents.ItemIsDir
		attrs    = fsevents.ItemInodeMetaMod | fsevents.ItemXattrMod | fsevents.ItemIsFile
	)
	status := func(p string) jobKey { return jobKey{kind: jobStatus, projectID: "p", path: p} }
	base := jobKey{kind: jobBase, projectID: "p"}
	recP := jobKey{kind: jobReconcile, projectID: "p"}
	recQ := jobKey{kind: jobReconcile, projectID: "q"}
	tests := []struct {
		path  string
		flags fsevents.EventFlags
		want  []jobKey
	}{
		// worktree files, at any depth: the deepest worktree root wins
		{"/h/p/README.md", modified, []jobKey{status("/h/p")}},
		{"/h/p/internal/a/b/c.go", modified, []jobKey{status("/h/p")}},
		{"/h/p/Cargo.lock", modified, []jobKey{status("/h/p")}},
		{"/w/o/p/feat/src/x.ts", created, []jobKey{status("/w/o/p/feat")}},
		{"/w/o/p/feat/node_modules/a/b/c.js", removed, []jobKey{status("/w/o/p/feat")}},
		{"/x/hand/sub/new.txt", created, []jobKey{status("/x/hand")}},
		{"/h/p/.claude/worktrees/agent/main.go", modified, []jobKey{status("/h/p/.claude/worktrees/agent")}},
		{"/h/p/.claude/worktrees/agent/a/b.go", modified, []jobKey{status("/h/p/.claude/worktrees/agent")}},
		{"/h/p/.claude/settings.json", modified, []jobKey{status("/h/p")}},
		{"/h/p/main.go", attrs, nil},
		{"/h/p/clone.md", itemCloned | fsevents.ItemIsFile, []jobKey{status("/h/p")}},
		{"/h/p/sub", 0, []jobKey{status("/h/p")}}, // a change with no flag counts as a write
		{"/w/o/p/feat/.git", modified, nil},

		// the common dir, through classify
		{"/h/p/.git/index", renamed, []jobKey{status("/h/p")}},
		{"/h/p/.git/index.lock", modified | fsevents.ItemRenamed, nil},
		{"/h/p/.git/HEAD", renamed, []jobKey{status("/h/p")}},
		{"/h/p/.git/logs/HEAD", modified, []jobKey{status("/h/p")}},
		{"/h/p/.git/FETCH_HEAD", modified, []jobKey{recP}},
		{"/h/p/.git/packed-refs", renamed, []jobKey{recP}},
		{"/h/p/.git/config.lock", modified, []jobKey{recP}},
		{"/h/p/.git/MERGE_HEAD", removed, []jobKey{status("/h/p")}},
		{"/h/p/.git/worktrees", dirNew, []jobKey{recP}},
		{"/h/p/.git/worktrees/new", dirNew, []jobKey{recP}},
		{"/h/p/.git/worktrees/feat", dirGone, []jobKey{recP}},
		{"/h/p/.git/worktrees/feat/HEAD", renamed, []jobKey{status("/w/o/p/feat")}},
		{"/h/p/.git/worktrees/feat/index", renamed, []jobKey{status("/w/o/p/feat")}},
		{"/h/p/.git/worktrees/feat/logs/HEAD", modified, []jobKey{status("/w/o/p/feat")}},
		{"/h/p/.git/worktrees/hand/rebase-merge", dirNew, []jobKey{status("/x/hand")}},
		{"/h/p/.git/worktrees/agent/HEAD", renamed, []jobKey{status("/h/p/.claude/worktrees/agent")}},
		{"/h/p/.git/refs/remotes/origin/main", renamed, []jobKey{base}},
		{"/h/p/.git/refs/remotes/origin/alex/foo", renamed, []jobKey{base}}, // nested ref name
		{"/h/p/.git/refs/remotes/origin/main.lock", modified, nil},

		// below the admin dirs: nothing (objects, local refs, ref logs, rebase steps)
		{"/h/p/.git/objects/ab/cdef", created, nil},
		{"/h/p/.git/objects/ab", dirNew, nil},
		{"/h/p/.git/refs/heads/main", renamed, nil},
		{"/h/p/.git/logs/refs/heads/main", modified, nil},
		{"/h/p/.git/worktrees/feat/logs/refs/x", modified, nil},
		{"/h/p/.git/worktrees/feat/rebase-merge/msgnum", modified, nil},
		{"/h/p/.git/worktrees/unknown/HEAD", renamed, nil}, // not reconciled yet: worktrees/ event covers it

		// a known directory itself going away
		{"/w/o/p/feat", dirGone, []jobKey{recP}},
		{"/h/p", fsevents.ItemRenamed | fsevents.ItemIsDir, []jobKey{recP}},
		{"/x/hand", dirGone, []jobKey{recP}},

		// a project without git: only .git appearing counts
		{"/h/q/.git", dirNew, []jobKey{recQ}},
		{"/h/q/notes.txt", modified, nil},
		{"/h/q/a/.git", dirNew, nil},

		// outside every known directory (the managed root's owner/repo levels)
		{"/w/o/p", dirNew, nil},
		{"/w/o/p/feat2/x.go", created, nil},
		{"/elsewhere/x", created, nil},

		// rescans reconcile what the path covers, or its owner
		{"/h/p/src", fsevents.MustScanSubDirs | fsevents.UserDropped, []jobKey{recP}},
		{"/w", fsevents.MustScanSubDirs | fsevents.KernelDropped, []jobKey{recP}},
		{"/h", fsevents.MustScanSubDirs, []jobKey{recP, recQ}},
		{"/h/q", fsevents.RootChanged, []jobKey{recQ}},
		{"/nowhere", fsevents.MustScanSubDirs, []jobKey{}},
	}
	dirs := fakeRoutes()
	for _, tt := range tests {
		got := eventKeys(dirs, tt.path, tt.flags)
		slices.SortFunc(got, func(a, b jobKey) int { return strings.Compare(a.projectID, b.projectID) })
		if !(len(got) == 0 && len(tt.want) == 0) && !reflect.DeepEqual(got, tt.want) {
			t.Errorf("eventKeys(%q, %#x) = %v, want %v", tt.path, uint32(tt.flags), got, tt.want)
		}
	}
}

func TestStreamRoots(t *testing.T) {
	dirs := fakeRoutes()
	got := streamRoots(dirs, "/w")
	// /h/p/.claude/worktrees/agent is inside /h/p, /w/o/p/feat inside /w; the git dirs
	// are not stream paths.
	want := []string{"/h/p", "/h/q", "/w", "/x/hand"}
	if !slices.Equal(got, want) {
		t.Fatalf("streamRoots = %v, want %v", got, want)
	}
	// /a/b-c sorts between /a/b and /a/b/c; nesting is still found.
	dirs = map[string]watchTarget{
		"/a/b":   {kind: wkRoot},
		"/a/b-c": {kind: wkRoot},
		"/a/b/c": {kind: wkRoot},
		"/a/b/d": {kind: wkCommon},
	}
	if got := streamRoots(dirs, "", "/a/b"); !slices.Equal(got, []string{"/a/b", "/a/b-c"}) {
		t.Fatalf("streamRoots = %v", got)
	}
	if got := streamRoots(nil, "/w"); !slices.Equal(got, []string{"/w"}) {
		t.Fatalf("streamRoots(nil) = %v", got)
	}
}

func TestOpsOf(t *testing.T) {
	tests := []struct {
		flags fsevents.EventFlags
		want  op
	}{
		{fsevents.ItemCreated | fsevents.ItemModified | fsevents.ItemXattrMod, opCreate | opWrite | opChmod},
		{fsevents.ItemRenamed | fsevents.ItemIsFile, opRename},
		{fsevents.ItemRemoved | fsevents.ItemIsDir, opRemove},
		{fsevents.ItemInodeMetaMod | fsevents.ItemChangeOwner | fsevents.ItemFinderInfoMod, opChmod},
		{itemCloned | fsevents.ItemIsFile, opCreate},
		{fsevents.ItemIsFile, opWrite},
	}
	for _, tt := range tests {
		if got := opsOf(tt.flags); got != tt.want {
			t.Errorf("opsOf(%#x) = %v, want %v", uint32(tt.flags), got, tt.want)
		}
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
