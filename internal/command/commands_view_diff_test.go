package command_test

import (
	"context"
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

func noFiles() *commandtest.FileDiffs {
	return &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{
		BaseRef: "origin/main", MergeBase: "abc",
		Base: &v1.ResolvedDiffSource{Label: "origin/main"},
		Head: &v1.ResolvedDiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE, Label: "Working tree"},
	}}
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
		code       connect.Code
		argErr     string
		msg        string
	}{
		// Calls that worked before keep working.
		{name: "a changed file", args: map[string]string{"path": "/wt/internal/a.go"},
			wantParams: own(map[string]string{"path": "internal/a.go"}), wantPaths: []string{"internal/a.go"}},
		{name: "branch scope", args: map[string]string{"path": "/wt/a.go", "scope": "branch"},
			wantParams: own(map[string]string{"path": "a.go", "head": "ref:HEAD"}), wantHead: &v1.DiffSource{Kind: ref, Ref: "HEAD"}, wantPaths: []string{"a.go"}},
		{name: "working scope said aloud", args: map[string]string{"path": "/wt/a.go", "scope": "working"},
			wantParams: own(map[string]string{"path": "a.go"}), wantPaths: []string{"a.go"}},

		// What is new.
		{name: "no path: the whole checkout", args: map[string]string{}, wantParams: own(map[string]string{})},
		{name: "two paths narrow the list", args: map[string]string{"path": "/wt/a.go\n/wt/b.go"},
			wantParams: own(map[string]string{"paths": "a.go\nb.go"}), wantPaths: []string{"a.go", "b.go"}},
		{name: "a directory narrows the list", args: map[string]string{"path": "/wt/src"},
			diffs:      &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Files: []*v1.CompareFile{{Path: "src/a.go"}}}},
			wantParams: own(map[string]string{"paths": "src"}), wantPaths: []string{"src"}},
		{name: "a rename keeps its source", args: map[string]string{"path": "/wt/new.go"},
			diffs:      &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Files: []*v1.CompareFile{{Path: "new.go", OldPath: "old.go", Status: "R"}}}},
			wantParams: own(map[string]string{"path": "new.go", "oldPath": "old.go"}), wantPaths: []string{"new.go"}},
		{name: "a ref as base", args: map[string]string{"base": "v1.2"},
			wantParams: own(map[string]string{"base": "ref:v1.2"}), wantBase: &v1.DiffSource{Kind: ref, Ref: "v1.2"}},
		{name: "staged against a sha", args: map[string]string{"base": "4c1e02aa", "head": "staged"},
			wantParams: own(map[string]string{"base": "ref:4c1e02aa", "head": "staged"}), wantBase: &v1.DiffSource{Kind: ref, Ref: "4c1e02aa"}, wantHead: &v1.DiffSource{Kind: staged}},
		{name: "the defaults said aloud stay out of the params", args: map[string]string{"base": "merge-base", "head": "working"}, wantParams: own(map[string]string{})},
		{name: "the working tree as base", args: map[string]string{"base": "working", "head": "HEAD"},
			wantParams: own(map[string]string{"base": "working", "head": "ref:HEAD"}), wantBase: &v1.DiffSource{Kind: working}, wantHead: &v1.DiffSource{Kind: ref, Ref: "HEAD"}},
		{name: "title, note and hide", args: map[string]string{"title": "The two files", "note": "Row height now comes from one place.", "hide": "compare\nfiles"},
			wantParams: own(map[string]string{"title": "The two files", "note": "Row height now comes from one place.", "hide": "compare,files"})},
		{name: "a title and note are plain text", args: map[string]string{"title": "two\n  lines\x07", "note": "a\tb"},
			wantParams: own(map[string]string{"title": "two lines", "note": "a b"})},

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
		{name: "a title too long", args: map[string]string{"title": strings.Repeat("x", 101)}, argErr: "title"},
		{name: "a note too long", args: map[string]string{"note": strings.Repeat("x", 501)}, argErr: "note"},
		{name: "unchanged", args: map[string]string{"path": "/wt/a.go"}, diffs: noFiles(),
			code: connect.CodeFailedPrecondition, msg: "a.go has no changes in thread s-aaaaaaaaaaa1's worktree (origin/main against the file on disk)"},
		{name: "unchanged on the branch", args: map[string]string{"path": "/wt/a.go", "scope": "branch"}, diffs: noFiles(),
			code: connect.CodeFailedPrecondition, msg: "a.go has no changes in thread s-aaaaaaaaaaa1's worktree (origin/main against the last commit)"},
		{name: "nothing differs at all", args: map[string]string{}, diffs: noFiles(),
			code: connect.CodeFailedPrecondition, msg: "nothing differs between origin/main and Working tree"},
		{name: "no base to compare", args: map[string]string{"path": "/wt/a.go", "scope": "branch"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Files: []*v1.CompareFile{{Path: "a.go"}}}},
			code:  connect.CodeFailedPrecondition, msg: "the worktree has no base branch to compare with"},
		{name: "no merge base", args: map[string]string{"path": "/wt/a.go", "scope": "branch"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{BaseRef: "origin/main", Files: []*v1.CompareFile{{Path: "a.go"}}}},
			code:  connect.CodeFailedPrecondition, msg: "HEAD has no merge base with origin/main"},
		{name: "a ref that names nothing", args: map[string]string{"base": "gone"},
			diffs: &commandtest.FileDiffs{Res: &v1.CompareWorktreeResponse{Error: "gone does not name a commit in this checkout"}},
			code:  connect.CodeFailedPrecondition, msg: "gone does not name a commit"},
		{name: "a ref the daemon refuses", args: map[string]string{"base": "--output=x"},
			diffs: &commandtest.FileDiffs{Err: connect.NewError(connect.CodeInvalidArgument, nil)}, code: connect.CodeInvalidArgument},
		{name: "outside the worktree", args: map[string]string{"path": "/elsewhere/a.go"}, argErr: "path"},
		{name: "the worktree itself", args: map[string]string{"path": "/wt"}, argErr: "path"},
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
			_, err := reg.Invoke(context.Background(), inThread, "view.panel.diff", tt.args)
			if checkItemErr(t, err, tt.code, tt.argErr) {
				if tt.msg != "" && !strings.Contains(err.Error(), tt.msg) {
					t.Errorf("err = %v, want %q", err, tt.msg)
				}
				sameIntents(t, emit.Intents(), nil)
				return
			}
			sameIntents(t, emit.Intents(), []*v1.UiIntent{showViewWith(command.ViewPanelDiff, "s-aaaaaaaaaaa1", tt.wantParams)})
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
