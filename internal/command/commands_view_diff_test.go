package command_test

import (
	"context"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func twoCheckouts() *v1.Thread {
	t := richThread()
	t.CheckoutPaths = []*v1.ThreadCheckoutPath{{ProjectId: "r1", Path: "/wt"}, {ProjectId: "r2", Path: "/api"}, {ProjectId: "r3", Path: "/wt/vendor/lib"}}
	return t
}

// unmatched is res answering that none of paths matched.
func unmatched(res *commandtest.FileDiffs, paths ...string) *commandtest.FileDiffs {
	res.Res.UnmatchedPaths = paths
	return res
}

func noFiles() *commandtest.FileDiffs {
	return &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{
		BaseRef: "origin/main", MergeBase: "abc",
		Base: &v1.ResolvedDiffSource{Label: "origin/main"},
		Head: &v1.ResolvedDiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE, Label: "Working tree"},
	}}
}

// oneFile is a comparison that lists one file, whatever was asked for.
func oneFile(path string) *commandtest.FileDiffs {
	res := noFiles().Res
	res.Files = []*v1.CompareFile{{Path: path, Status: "M"}}
	return &commandtest.FileDiffs{Res: res}
}

// view.panel.diff: the thread must run in a worktree holding its paths, and the sides must
// differ. What it shows goes to the tab as params; what it asked of the daemon, as sources.
func TestPanelDiff(t *testing.T) {
	const (
		mergeBase = v1.DiffSourceKind_DIFF_SOURCE_KIND_MERGE_BASE
		working   = v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE
		staged    = v1.DiffSourceKind_DIFF_SOURCE_KIND_STAGED
		ref       = v1.DiffSourceKind_DIFF_SOURCE_KIND_REF
	)
	own := func(m map[string]string) map[string]string {
		m["project"], m["worktree"], m["own"] = "r1", "/wt", "1"
		return m
	}
	// A tab of the thread's own: the checkout's stays the user's.
	apart := func(m map[string]string) map[string]string {
		m["thread"] = "s-aaaaaaaaaaa1"
		return own(m)
	}
	tests := []struct {
		name       string
		thread     *v1.Thread
		args       map[string]string
		diffs      *commandtest.FileDiffs
		wantParams map[string]string
		wantBase   *v1.DiffSource
		wantHead   *v1.DiffSource
		wantProj   string
		wantRoot   string
		wantPaths  []string
		wantWarn   []string
		code       connect.Code
		argErr     string
		msg        string
	}{
		// Calls that worked before keep working.
		{name: "a changed file", args: map[string]string{"path": "/wt/internal/a.go"},
			wantParams: own(map[string]string{"path": "internal/a.go"}), wantPaths: []string{"internal/a.go"}},
		{name: "branch scope gets a tab of its own", args: map[string]string{"path": "/wt/a.go", "scope": "branch"},
			wantParams: apart(map[string]string{"path": "a.go", "head": "ref:HEAD"}), wantHead: &v1.DiffSource{Kind: ref, Ref: "HEAD"}, wantPaths: []string{"a.go"}},
		{name: "working scope said aloud gets one too", args: map[string]string{"path": "/wt/a.go", "scope": "working"},
			wantParams: apart(map[string]string{"path": "a.go"}), wantPaths: []string{"a.go"}},

		// What is new.
		{name: "no path: the whole checkout", args: map[string]string{}, wantParams: own(map[string]string{})},
		{name: "two paths narrow a tab of its own", args: map[string]string{"path": "/wt/a.go\n/wt/b.go"},
			wantParams: apart(map[string]string{"paths": "a.go\nb.go"}), wantPaths: []string{"a.go", "b.go"}},
		{name: "a directory narrows a tab of its own", args: map[string]string{"path": "/wt/src"},
			diffs:      &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Files: []*v1.CompareFile{{Path: "src/a.go"}}}},
			wantParams: apart(map[string]string{"paths": "src"}), wantPaths: []string{"src"}},
		{name: "a note gets a tab of its own", args: map[string]string{"note": "Look here"},
			wantParams: apart(map[string]string{"note": "Look here"})},
		{name: "hide gets a tab of its own", args: map[string]string{"hide": "compare"},
			wantParams: apart(map[string]string{"hide": "compare"})},
		{name: "a file with a note selects it there", args: map[string]string{"path": "/wt/a.go", "note": "Look here"},
			wantParams: apart(map[string]string{"path": "a.go", "note": "Look here"}), wantPaths: []string{"a.go"}},
		{name: "the checkout's root is every file", args: map[string]string{"path": "/wt"}, wantParams: own(map[string]string{})},
		{name: "the root among paths is still every file", args: map[string]string{"path": "/wt/a.go\n/wt"}, wantParams: own(map[string]string{})},
		{name: "a sibling's root is its every file", thread: twoCheckouts(), args: map[string]string{"path": "/api"},
			wantParams: map[string]string{"project": "r2", "worktree": "/api"}, wantProj: "r2", wantRoot: "/api"},
		{name: "a path with nothing to show is named", args: map[string]string{"path": "/wt/a.go\n/wt/missing.go", "title": "X"},
			diffs:      unmatched(oneFile("a.go"), "missing.go"),
			wantParams: apart(map[string]string{"paths": "a.go", "title": "X"}), wantPaths: []string{"a.go", "missing.go"},
			wantWarn: []string{"missing.go has no changes here (origin/main against Working tree), so it is not listed"}},
		{name: "a path past the cap still counts", args: map[string]string{"path": "/wt/a.go\n/wt/z.go"},
			diffs:      &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Truncated: true, Files: []*v1.CompareFile{{Path: "a.go"}}}},
			wantParams: apart(map[string]string{"paths": "a.go\nz.go"}), wantPaths: []string{"a.go", "z.go"}},
		{name: "a capped list still names what matched nothing", args: map[string]string{"path": "/wt/a.go\n/wt/missing.go"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Truncated: true, Files: []*v1.CompareFile{{Path: "a.go"}}, UnmatchedPaths: []string{"missing.go"},
				Base: &v1.ResolvedDiffSource{Label: "origin/main"}, Head: &v1.ResolvedDiffSource{Label: "Working tree"}}},
			wantParams: apart(map[string]string{"paths": "a.go"}), wantPaths: []string{"a.go", "missing.go"},
			wantWarn: []string{"missing.go has no changes here (origin/main against Working tree), so it is not listed"}},
		{name: "a rename keeps its source", args: map[string]string{"path": "/wt/new.go"},
			diffs:      &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Files: []*v1.CompareFile{{Path: "new.go", OldPath: "old.go", Status: "R"}}}},
			wantParams: own(map[string]string{"path": "new.go", "oldPath": "old.go"}), wantPaths: []string{"new.go"}},
		{name: "a ref as base gets a tab of its own", args: map[string]string{"base": "v1.2"},
			wantParams: apart(map[string]string{"base": "ref:v1.2"}), wantBase: &v1.DiffSource{Kind: ref, Ref: "v1.2"}},
		{name: "a head alone gets a tab of its own", args: map[string]string{"head": "staged"},
			wantParams: apart(map[string]string{"head": "staged"}), wantHead: &v1.DiffSource{Kind: staged}},
		{name: "staged against a sha", args: map[string]string{"base": "4c1e02aa", "head": "staged"},
			wantParams: apart(map[string]string{"base": "ref:4c1e02aa", "head": "staged"}), wantBase: &v1.DiffSource{Kind: ref, Ref: "4c1e02aa"}, wantHead: &v1.DiffSource{Kind: staged}},
		{name: "the defaults said aloud are given all the same", args: map[string]string{"base": "merge-base", "head": "working"}, wantParams: apart(map[string]string{})},
		{name: "one default said aloud is too", args: map[string]string{"head": "working"}, wantParams: apart(map[string]string{})},
		{name: "a side left blank is no side", args: map[string]string{"base": "", "path": "/wt/a.go"}, wantParams: own(map[string]string{"path": "a.go"}), wantPaths: []string{"a.go"}},
		{name: "the working tree as base", args: map[string]string{"base": "working", "head": "HEAD"},
			wantParams: apart(map[string]string{"base": "working", "head": "ref:HEAD"}), wantBase: &v1.DiffSource{Kind: working}, wantHead: &v1.DiffSource{Kind: ref, Ref: "HEAD"}},
		{name: "title, note and hide", args: map[string]string{"title": "The two files", "note": "Row height now comes from one place.", "hide": "compare\nfiles"},
			wantParams: apart(map[string]string{"title": "The two files", "note": "Row height now comes from one place.", "hide": "compare,files"})},
		{name: "a title and note are plain text", args: map[string]string{"title": "two\n  lines\x07", "note": "a\tb"},
			wantParams: apart(map[string]string{"title": "two lines", "note": "a b"})},

		// Several checkouts: one tab shows one.
		{name: "a sibling checkout's file", thread: twoCheckouts(), args: map[string]string{"path": "/api/h.go"},
			wantParams: map[string]string{"project": "r2", "worktree": "/api", "path": "h.go"}, wantProj: "r2", wantRoot: "/api", wantPaths: []string{"h.go"}},
		{name: "the deepest checkout wins", thread: twoCheckouts(), args: map[string]string{"path": "/wt/vendor/lib/x.go"},
			wantParams: map[string]string{"project": "r3", "worktree": "/wt/vendor/lib", "path": "x.go"}, wantProj: "r3", wantRoot: "/wt/vendor/lib", wantPaths: []string{"x.go"}},
		{name: "paths in two checkouts", thread: twoCheckouts(), args: map[string]string{"path": "/wt/a.go\n/api/h.go"}, argErr: "path"},

		// Refusals.
		{name: "scope with base", args: map[string]string{"scope": "branch", "base": "main"}, argErr: "scope"},
		{name: "scope with head", args: map[string]string{"scope": "working", "head": "main"}, argErr: "scope"},
		{name: "a part that cannot be hidden", args: map[string]string{"hide": "everything"}, argErr: "hide"},
		{name: "a title of nothing but spaces", args: map[string]string{"title": "  \t "}, argErr: "title"},
		{name: "a title of nothing printable", args: map[string]string{"title": "\u200b\x07"}, argErr: "title"},
		{name: "an empty title", args: map[string]string{"title": ""}, argErr: "title"},
		{name: "a title too long", args: map[string]string{"title": strings.Repeat("x", 101)}, argErr: "title"},
		{name: "a note too long", args: map[string]string{"note": strings.Repeat("x", 501)}, argErr: "note"},
		{name: "unchanged", args: map[string]string{"path": "/wt/a.go"}, diffs: noFiles(),
			code: connect.CodeFailedPrecondition, msg: "a.go has no changes in thread s-aaaaaaaaaaa1's worktree (origin/main against the file on disk)"},
		{name: "unchanged on the branch", args: map[string]string{"path": "/wt/a.go", "scope": "branch"}, diffs: noFiles(),
			code: connect.CodeFailedPrecondition, msg: "a.go has no changes in thread s-aaaaaaaaaaa1's worktree (origin/main against the last commit)"},
		{name: "none of several has changes", args: map[string]string{"path": "/wt/a.go\n/wt/b.go"}, diffs: noFiles(),
			code: connect.CodeFailedPrecondition, msg: "none of a.go, b.go has changes in thread s-aaaaaaaaaaa1's worktree (origin/main against Working tree)"},
		{name: "nothing differs at all", args: map[string]string{}, diffs: noFiles(),
			code: connect.CodeFailedPrecondition, msg: "nothing differs between origin/main and Working tree"},
		{name: "no base to compare", args: map[string]string{"path": "/wt/a.go", "scope": "branch"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Files: []*v1.CompareFile{{Path: "a.go"}}}},
			code:  connect.CodeFailedPrecondition, msg: "the worktree has no base branch to compare with"},
		{name: "no base to compare, and no path", args: map[string]string{"scope": "branch"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Files: []*v1.CompareFile{{Path: "a.go"}}}},
			code:  connect.CodeFailedPrecondition, msg: "cannot diff this checkout (branch): the worktree has no base branch"},
		{name: "no merge base, and no path", args: map[string]string{"scope": "branch"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{BaseRef: "origin/main", Files: []*v1.CompareFile{{Path: "a.go"}}}},
			code:  connect.CodeFailedPrecondition, msg: "cannot diff this checkout (branch): HEAD has no merge base"},
		{name: "no merge base", args: map[string]string{"path": "/wt/a.go", "scope": "branch"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{BaseRef: "origin/main", Files: []*v1.CompareFile{{Path: "a.go"}}}},
			code:  connect.CodeFailedPrecondition, msg: "HEAD has no merge base with origin/main"},
		{name: "a ref that names nothing", args: map[string]string{"base": "gone"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Error: "gone does not name a commit in this checkout"}},
			code:  connect.CodeFailedPrecondition, msg: "gone does not name a commit"},
		{name: "a ref the daemon refuses", args: map[string]string{"base": "--output=x"},
			diffs: &commandtest.FileDiffs{Err: connect.NewError(connect.CodeInvalidArgument, nil)}, code: connect.CodeInvalidArgument},
		{name: "outside the worktree", args: map[string]string{"path": "/elsewhere/a.go"}, argErr: "path"},
		{name: "a thread in no worktree", thread: &v1.Thread{WorktreePath: "/home"}, args: map[string]string{"path": "/home/a.go"},
			code: connect.CodeFailedPrecondition, msg: "runs in no project worktree"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.thread == nil {
				tt.thread = richThread()
			}
			if tt.diffs == nil {
				tt.diffs = &commandtest.FileDiffs{}
			}
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: tt.thread}, panelDeps{windows: 1, diffs: tt.diffs})
			inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
			res, err := reg.Invoke(context.Background(), inThread, "view.panel.diff", tt.args)
			if !slices.Equal(res.Warnings, tt.wantWarn) {
				t.Errorf("warnings = %q, want %q", res.Warnings, tt.wantWarn)
			}
			if checkItemErr(t, err, tt.code, tt.argErr) {
				if tt.msg != "" && !strings.Contains(err.Error(), tt.msg) {
					t.Errorf("err = %v, want %q", err, tt.msg)
				}
				openedNothing(t, reg, emit)
				return
			}
			openedTab(t, reg, emit, res, "s-aaaaaaaaaaa1", tt.wantParams)
			reqs := tt.diffs.Requests()
			req, ok := reqs[len(reqs)-1].(*v1.CompareWorktreeRequest)
			if !ok {
				t.Fatalf("request = %v", reqs)
			}
			base, head := tt.wantBase, tt.wantHead
			if base == nil {
				base = &v1.DiffSource{Kind: mergeBase}
			}
			if head == nil {
				head = &v1.DiffSource{Kind: working}
			}
			if req.GetBase().GetKind() != base.GetKind() || req.GetBase().GetRef() != base.GetRef() || req.GetHead().GetKind() != head.GetKind() || req.GetHead().GetRef() != head.GetRef() {
				t.Errorf("sources = %v %v, want %v %v", req.GetBase(), req.GetHead(), base, head)
			}
			proj, root := tt.wantProj, tt.wantRoot
			if proj == "" {
				proj, root = "r1", "/wt"
			}
			if req.GetProjectId() != proj || req.GetPath() != root || strings.Join(req.GetPaths(), ",") != strings.Join(tt.wantPaths, ",") {
				t.Errorf("request = %v, want %s %s %v", req, proj, root, tt.wantPaths)
			}
		})
	}
}

// A tab of its own names the thread that asked, which may not be the one whose panel opens.
func TestPanelDiffAsker(t *testing.T) {
	tests := []struct {
		name string
		uctx command.Context
		want string
	}{
		{name: "the thread itself", uctx: command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}, want: "s-aaaaaaaaaaa1"},
		{name: "another thread's call", uctx: command.Context{ActiveThreadID: "s-bbbbbbbbbbb2"}, want: "s-bbbbbbbbbbb2"},
		{name: "the window, which is not asking", uctx: command.Context{ActiveThreadID: "s-bbbbbbbbbbb2", ActiveView: "thread", ActiveProjectID: "r1", ActiveWorktreePath: "/wt"}, want: "s-aaaaaaaaaaa1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, diffs: &commandtest.FileDiffs{}})
			args := map[string]string{"note": "Look here", "thread": "s-aaaaaaaaaaa1"}
			res, err := reg.Invoke(context.Background(), tt.uctx, "view.panel.diff", args)
			if err != nil {
				t.Fatal(err)
			}
			openedTab(t, reg, emit, res, "s-aaaaaaaaaaa1", map[string]string{
				"project": "r1", "worktree": "/wt", "own": "1", "note": "Look here", "thread": tt.want,
			})
		})
	}
}

// The verb's flags are what the design says: there is no way to lock the user out.
func TestPanelDiffFlags(t *testing.T) {
	reg, _ := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, diffs: &commandtest.FileDiffs{}})
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	if _, err := reg.Invoke(context.Background(), inThread, "view.panel.diff", map[string]string{"lock": "1"}); err == nil {
		t.Error("--lock was accepted")
	}
	cmd, ok := reg.Get("view.panel.diff")
	if !ok {
		t.Fatal("view.panel.diff is not registered")
	}
	path := false
	for _, a := range cmd.Args {
		if a.Name == "path" {
			path = true
			if !a.Repeatable || !a.Positional || a.Required {
				t.Errorf("path = %+v, want repeatable, positional and optional", a)
			}
		}
	}
	if !path {
		t.Error("no path arg")
	}
}
