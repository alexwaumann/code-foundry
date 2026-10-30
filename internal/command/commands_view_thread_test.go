package command_test

import (
	"context"
	"errors"
	"maps"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// panelVerbs are every verb that acts on a side panel and follows the thread, with the
// ShowView name each emits.
var panelVerbs = map[string]string{
	"view.panel.toggle":  command.ViewPanelToggle,
	"view.panel.expand":  command.ViewPanelExpand,
	"view.panel.new-tab": command.ViewPanelNewTab,
	"view.panel.split":   command.ViewPanelSplit,
	"view.panel.mcp":     command.ViewPanelMcp,
}

// richThread can show every surface: placed in a workspace and a worktree, with a
// linked pull request, a subagent run and a creator.
func richThread() *v1.Thread {
	return &v1.Thread{
		ProjectId: "r1", WorktreePath: "/wt", WorkspaceId: "w1", CreatedBy: "s-ccccccccccc3",
		LinkedPullRequests: []*v1.LinkedPullRequest{{Slug: "o/r", Number: 7}},
		AgentRuns:          []*v1.AgentRun{{Id: "a1"}},
	}
}

// panelDeps are the deps of panelRegistry beyond the thread.
type panelDeps struct {
	windows  int
	viewed   map[string]bool
	files    *commandtest.Files
	diffs    *commandtest.FileDiffs
	projects *commandtest.Project
	prs      *commandtest.PullRequestChecks
}

// panelRegistry registers every command, with threads read from th and one window open.
func panelRegistry(t *testing.T, th *commandtest.Thread) (*command.Registry, *commandtest.Emitter) {
	t.Helper()
	return panelRegistryWith(t, th, panelDeps{windows: 1})
}

func panelRegistryWith(t *testing.T, th *commandtest.Thread, d panelDeps) (*command.Registry, *commandtest.Emitter) {
	t.Helper()
	reg := command.NewRegistry()
	emit := &commandtest.Emitter{Delivered: 1, OpenWindows: d.windows}
	deps := all.Deps{Emitter: emit, Thread: th}
	if d.viewed != nil {
		deps.Presence.Viewed = func(id string) bool { return d.viewed[id] }
	}
	if d.files != nil {
		deps.Files = d.files
	}
	if d.diffs != nil {
		deps.FileDiffs = d.diffs
	}
	if d.projects != nil {
		deps.Project = d.projects
	}
	if d.prs != nil {
		deps.PullRequestChecks.Gh = d.prs
	}
	if err := all.Register(reg, deps); err != nil {
		t.Fatal(err)
	}
	return reg, emit
}

func showView(name, thread string) *v1.UiIntent {
	return showViewWith(name, thread, nil)
}

func showViewWith(name, thread string, params map[string]string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name, ThreadId: thread, Params: params}}}
}

func focusThread(id string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: id, Explicit: true}}}
}

func sameIntents(t *testing.T, got, want []*v1.UiIntent) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("intents = %v, want %v", got, want)
	}
	for i := range got {
		if got[i].String() != want[i].String() {
			t.Errorf("intent %d = %v, want %v", i, got[i], want[i])
		}
	}
}

// Every panel verb, from the GUI and the CLI: scoped to a thread only from the CLI with
// one (or with an explicit --thread), unscoped otherwise, and --focus selects first,
// explicitly.
func TestPanelVerbsThreadScope(t *testing.T) {
	gui := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1", ActiveWorkspaceID: "w1", ActiveProjectID: "r1", ActiveWorktreePath: "/wt", ActiveView: "thread"}
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	tests := []struct {
		name       string
		ctx        command.Context
		args       map[string]string
		wantThread string
		wantFocus  bool
		wantMsg    string
	}{
		{name: "the app's palette acts on each window's selection", ctx: gui},
		{name: "the app's palette with --focus changes nothing", ctx: gui, args: map[string]string{"focus": "true"}},
		{name: "the app with an explicit --thread", ctx: gui, args: map[string]string{"thread": "s-bbbbbbbbbbb2"}, wantThread: "s-bbbbbbbbbbb2"},
		{name: "the CLI in a thread acts on that thread", ctx: inThread, wantThread: "s-aaaaaaaaaaa1", wantMsg: "windows=1 thread=s-aaaaaaaaaaa1"},
		{name: "the CLI in a thread with --thread", ctx: inThread, args: map[string]string{"thread": "s-bbbbbbbbbbb2"}, wantThread: "s-bbbbbbbbbbb2", wantMsg: "windows=1 thread=s-bbbbbbbbbbb2"},
		{name: "the CLI in a thread with --focus", ctx: inThread, args: map[string]string{"focus": "true"}, wantThread: "s-aaaaaaaaaaa1", wantFocus: true, wantMsg: "windows=1 thread=s-aaaaaaaaaaa1 focused"},
		{name: "the CLI outside a thread with --thread", ctx: command.Context{}, args: map[string]string{"thread": "s-bbbbbbbbbbb2"}, wantThread: "s-bbbbbbbbbbb2", wantMsg: "windows=1 thread=s-bbbbbbbbbbb2"},
	}
	th := &commandtest.Thread{Current: richThread()}
	for verb, view := range panelVerbs {
		for _, tt := range tests {
			t.Run(verb+"/"+tt.name, func(t *testing.T) {
				reg, emit := panelRegistry(t, th)
				res, err := reg.Invoke(context.Background(), tt.ctx, verb, tt.args)
				if err != nil {
					t.Fatal(err)
				}
				var want []*v1.UiIntent
				if tt.wantFocus {
					want = append(want, focusThread(tt.wantThread))
				}
				sameIntents(t, emit.Intents(), append(want, showView(view, tt.wantThread)))
				var wantJSON any = command.EmitResult{Windows: 1, Receivers: 1}
				if tt.wantThread != "" {
					wantJSON = command.PanelResult{Windows: 1, Receivers: 1, Thread: tt.wantThread, Focused: tt.wantFocus}
				}
				if res.JSON != wantJSON {
					t.Errorf("JSON = %+v, want %+v", res.JSON, wantJSON)
				}
				if res.Message != tt.wantMsg {
					t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
				}
			})
		}
	}
}

// The panel actions that need no thread run from the CLI outside one as before: every
// window's selection, saying how many windows. --focus there has no thread to select.
func TestPanelVerbsOutsideAThread(t *testing.T) {
	for _, verb := range []string{"view.panel.toggle", "view.panel.expand", "view.panel.new-tab", "view.panel.split"} {
		t.Run(verb, func(t *testing.T) {
			reg, emit := panelRegistry(t, &commandtest.Thread{})
			res, err := reg.Invoke(context.Background(), command.Context{}, verb, nil)
			if err != nil {
				t.Fatal(err)
			}
			sameIntents(t, emit.Intents(), []*v1.UiIntent{showView(panelVerbs[verb], "")})
			if res.Message != "windows=1" || res.JSON != (command.EmitResult{Windows: 1, Receivers: 1}) {
				t.Errorf("result = %+v, want windows=1", res)
			}
			_, err = reg.Invoke(context.Background(), command.Context{}, verb, map[string]string{"focus": "true"})
			var argErr *command.ArgError
			if !errors.As(err, &argErr) || argErr.Arg != "focus" {
				t.Errorf("--focus outside a thread: err = %v, want an ArgError for focus", err)
			}
		})
	}
}

// With no app window open a verb still succeeds (exit 0, JSON out) but says nothing
// was shown, and --focus focused nothing. A CLI events stream receiving the intent
// (receivers) does not count as a window.
func TestPanelVerbsWithoutAWindow(t *testing.T) {
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		wantJSON any
	}{
		{name: "scoped with --focus", ctx: command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}, args: map[string]string{"focus": "true"},
			wantJSON: command.PanelResult{Windows: 0, Receivers: 1, Thread: "s-aaaaaaaaaaa1"}},
		{name: "unscoped", ctx: command.Context{}, wantJSON: command.EmitResult{Windows: 0, Receivers: 1}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, _ := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 0})
			res, err := reg.Invoke(context.Background(), tt.ctx, "view.panel.toggle", tt.args)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != command.NoWindowMessage || res.JSON != tt.wantJSON {
				t.Errorf("result = %+v, want %q and %+v", res, command.NoWindowMessage, tt.wantJSON)
			}
		})
	}
}

// A scoped call reads its thread: an unknown one fails, and nothing is emitted then (the
// item verbs' refusals are TestPanelFile's and TestPanelDiff's).
func TestPanelVerbsCheckTheThread(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	notFound := &commandtest.Thread{Err: connect.NewError(connect.CodeNotFound, errors.New("no thread"))}
	tests := []struct {
		name   string
		verb   string
		thread *commandtest.Thread
		code   connect.Code
		msg    string
	}{
		{name: "unknown thread", verb: "view.panel.mcp", thread: notFound, code: connect.CodeNotFound},
		{name: "unknown thread with --focus", verb: "view.panel.toggle", thread: notFound, code: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistry(t, tt.thread)
			_, err := reg.Invoke(context.Background(), inThread, tt.verb, map[string]string{"focus": "true"})
			if connect.CodeOf(err) != tt.code || !strings.Contains(err.Error(), tt.msg) {
				t.Errorf("err = %v, want code %v with %q", err, tt.code, tt.msg)
			}
			if got := emit.Intents(); len(got) != 0 {
				t.Errorf("intents = %v, want none", got)
			}
		})
	}
}

// The page verbs move every window: from a thread's CLI they refuse while no window
// shows that thread, unless --focus says the user asked. The app, the CLI outside a
// thread and a viewed thread are unchanged; with no window open nothing is taken over.
func TestPageVerbs(t *testing.T) {
	const self = "s-aaaaaaaaaaa1"
	gui := command.Context{ActiveThreadID: self, CallerThreadID: self, ActiveView: "thread"}
	inThread := command.Context{ActiveThreadID: self, CallerThreadID: self}
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		deps    panelDeps
		wantMsg string
		refused bool
	}{
		{name: "the app", ctx: gui, deps: panelDeps{windows: 1, viewed: map[string]bool{}}},
		{name: "the CLI outside a thread", ctx: command.Context{}, deps: panelDeps{windows: 1, viewed: map[string]bool{}}, wantMsg: "windows=1"},
		{name: "a viewed thread", ctx: inThread, deps: panelDeps{windows: 1, viewed: map[string]bool{self: true}}, wantMsg: "windows=1"},
		{name: "a thread nobody looks at", ctx: inThread, deps: panelDeps{windows: 1, viewed: map[string]bool{}}, refused: true},
		{name: "a thread nobody looks at, with --focus", ctx: inThread, args: map[string]string{"focus": "true"}, deps: panelDeps{windows: 1, viewed: map[string]bool{}}, wantMsg: "windows=1"},
		{name: "no window open", ctx: inThread, deps: panelDeps{windows: 0, viewed: map[string]bool{}}, wantMsg: command.NoWindowMessage},
		{name: "no presence", ctx: inThread, deps: panelDeps{windows: 1}, wantMsg: "windows=1"},
	}
	pages := map[string]string{
		"view.usage": command.ViewUsage, "view.pullrequests": command.ViewPullRequests,
		"view.projects": command.ViewProjects, "view.settings": command.ViewSettings, "view.help": command.ViewHelp,
	}
	for verb, view := range pages {
		for _, tt := range tests {
			t.Run(verb+"/"+tt.name, func(t *testing.T) {
				reg, emit := panelRegistryWith(t, &commandtest.Thread{}, tt.deps)
				res, err := reg.Invoke(context.Background(), tt.ctx, verb, tt.args)
				if tt.refused {
					if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "pass --focus to take them there anyway") {
						t.Errorf("err = %v, want the refusal", err)
					}
					sameIntents(t, emit.Intents(), nil)
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				sameIntents(t, emit.Intents(), []*v1.UiIntent{showView(view, "")})
				if res.Message != tt.wantMsg {
					t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
				}
			})
		}
	}
}

// The window actions that are no page answer from the CLI too (they printed nothing).
func TestWindowActionsSayWhereTheyWent(t *testing.T) {
	for _, verb := range []string{"view.back", "view.forward", "view.bottom.toggle", "thread.previous", "thread.next"} {
		for _, windows := range []int{0, 2} {
			reg, _ := panelRegistryWith(t, &commandtest.Thread{}, panelDeps{windows: windows})
			res, err := reg.Invoke(context.Background(), command.Context{}, verb, nil)
			if err != nil {
				t.Fatal(err)
			}
			want := command.NoWindowMessage
			if windows > 0 {
				want = "windows=2"
			}
			if res.Message != want {
				t.Errorf("%s with %d windows: message = %q, want %q", verb, windows, res.Message, want)
			}
		}
	}
}

// view.panel.file: the file must exist under home (ReadFile decides); the ShowView names
// it absolute with the thread's checkout and project.
func TestPanelFile(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	tests := []struct {
		name       string
		args       map[string]string
		files      *commandtest.Files
		wantParams map[string]string
		code       connect.Code
		argErr     string
	}{
		{name: "a file in the worktree", args: map[string]string{"path": "/wt/main.go"}, files: &commandtest.Files{Files: []string{"/wt/main.go"}},
			wantParams: map[string]string{"path": "/wt/main.go", "project": "r1", "base": "/wt"}},
		{name: "with a line", args: map[string]string{"path": "/wt/main.go", "line": "12"}, files: &commandtest.Files{Files: []string{"/wt/main.go"}},
			wantParams: map[string]string{"path": "/wt/main.go", "project": "r1", "base": "/wt", "line": "12"}},
		{name: "missing", args: map[string]string{"path": "/wt/nope.go"}, files: &commandtest.Files{}, code: connect.CodeNotFound},
		{name: "a directory", args: map[string]string{"path": "/wt/docs"}, files: &commandtest.Files{Dirs: []string{"/wt/docs"}}, argErr: "path"},
		{name: "line 0", args: map[string]string{"path": "/wt/main.go", "line": "0"}, files: &commandtest.Files{Files: []string{"/wt/main.go"}}, argErr: "line"},
		{name: "outside home", args: map[string]string{"path": "/etc/hosts"},
			files: &commandtest.Files{Err: connect.NewError(connect.CodeInvalidArgument, errors.New("outside the home directory"))}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, files: tt.files})
			_, err := reg.Invoke(context.Background(), inThread, "view.panel.file", tt.args)
			if checkItemErr(t, err, tt.code, tt.argErr) {
				sameIntents(t, emit.Intents(), nil)
				return
			}
			sameIntents(t, emit.Intents(), []*v1.UiIntent{showViewWith(command.ViewPanelFile, "s-aaaaaaaaaaa1", tt.wantParams)})
		})
	}
}

// view.panel.diff: the thread must run in a worktree holding the path, and the file must
// have changes in the scope.
func TestPanelDiff(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	tests := []struct {
		name       string
		thread     *v1.Thread
		args       map[string]string
		diffs      *commandtest.FileDiffs
		wantParams map[string]string
		wantScope  v1.DiffScope
		code       connect.Code
		argErr     string
		msg        string
	}{
		{name: "a changed file", thread: richThread(), args: map[string]string{"path": "/wt/internal/a.go"}, diffs: &commandtest.FileDiffs{},
			wantParams: map[string]string{"project": "r1", "worktree": "/wt", "path": "internal/a.go", "scope": "working"}, wantScope: v1.DiffScope_DIFF_SCOPE_WORKING},
		{name: "branch scope", thread: richThread(), args: map[string]string{"path": "/wt/a.go", "scope": "branch"}, diffs: &commandtest.FileDiffs{},
			wantParams: map[string]string{"project": "r1", "worktree": "/wt", "path": "a.go", "scope": "branch"}, wantScope: v1.DiffScope_DIFF_SCOPE_BRANCH},
		{name: "unchanged", thread: richThread(), args: map[string]string{"path": "/wt/a.go"}, diffs: &commandtest.FileDiffs{Res: &v1.GetWorktreeFileDiffResponse{BaseRef: "origin/main"}},
			code: connect.CodeFailedPrecondition, msg: "a.go has no changes in thread s-aaaaaaaaaaa1's worktree (origin/main against the file on disk)"},
		{name: "no base to compare", thread: richThread(), args: map[string]string{"path": "/wt/a.go", "scope": "branch"},
			diffs: &commandtest.FileDiffs{Res: &v1.GetWorktreeFileDiffResponse{Error: "no base branch"}}, code: connect.CodeFailedPrecondition, msg: "no base branch"},
		{name: "outside the worktree", thread: richThread(), args: map[string]string{"path": "/elsewhere/a.go"}, diffs: &commandtest.FileDiffs{}, argErr: "path"},
		{name: "the worktree itself", thread: richThread(), args: map[string]string{"path": "/wt"}, diffs: &commandtest.FileDiffs{}, argErr: "path"},
		{name: "a thread in no worktree", thread: &v1.Thread{WorktreePath: "/home"}, args: map[string]string{"path": "/home/a.go"}, diffs: &commandtest.FileDiffs{},
			code: connect.CodeFailedPrecondition, msg: "runs in no project worktree"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: tt.thread}, panelDeps{windows: 1, diffs: tt.diffs})
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
			if req, ok := reqs[len(reqs)-1].(*v1.GetWorktreeFileDiffRequest); !ok || req.GetScope() != tt.wantScope || req.GetFile() != tt.wantParams["path"] {
				t.Errorf("diff request = %v", reqs)
			}
		})
	}
}

// view.panel.pr: a number the thread links names that link's repository; otherwise the
// thread's project's. The gh store must know it.
func TestPanelPR(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1"}
	projects := &commandtest.Project{Projects: []*v1.Project{{Id: "r1", GithubSlug: "Owner/Repo"}, {Id: "r2"}}}
	ok := func() *commandtest.PullRequestChecks {
		return &commandtest.PullRequestChecks{Res: &v1.GetPullRequestResponse{PullRequest: &v1.PullRequest{}}}
	}
	tests := []struct {
		name     string
		thread   *v1.Thread
		number   string
		prs      *commandtest.PullRequestChecks
		wantSlug string
		code     connect.Code
		argErr   string
	}{
		{name: "a linked pull request", thread: richThread(), number: "7", prs: ok(), wantSlug: "o/r"},
		{name: "one in the project's repository", thread: richThread(), number: "12", prs: ok(), wantSlug: "owner/repo"},
		{name: "the store's slug wins", thread: richThread(), number: "12", wantSlug: "owner/repo-renamed",
			prs: &commandtest.PullRequestChecks{Res: &v1.GetPullRequestResponse{PullRequest: &v1.PullRequest{RepoSlug: "owner/repo-renamed"}}}},
		{name: "linked in two repositories", number: "7", prs: ok(), argErr: "number",
			thread: &v1.Thread{ProjectId: "r1", LinkedPullRequests: []*v1.LinkedPullRequest{{Slug: "o/r", Number: 7}, {Slug: "o/other", Number: 7}}}},
		{name: "a project without GitHub", thread: &v1.Thread{ProjectId: "r2"}, number: "3", prs: ok(), code: connect.CodeFailedPrecondition},
		{name: "no project", thread: &v1.Thread{}, number: "3", prs: ok(), code: connect.CodeFailedPrecondition},
		{name: "unknown to GitHub", thread: richThread(), number: "99999", code: connect.CodeNotFound,
			prs: &commandtest.PullRequestChecks{Err: connect.NewError(connect.CodeNotFound, errors.New("not found"))}},
		{name: "GitHub unreachable keeps its code", thread: richThread(), number: "12", code: connect.CodeUnavailable,
			prs: &commandtest.PullRequestChecks{Err: connect.NewError(connect.CodeUnavailable, errors.New("offline"))}},
		{name: "zero", thread: richThread(), number: "0", prs: ok(), argErr: "number"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: tt.thread}, panelDeps{windows: 1, projects: projects, prs: tt.prs})
			_, err := reg.Invoke(context.Background(), inThread, "view.panel.pr", map[string]string{"number": tt.number})
			if checkItemErr(t, err, tt.code, tt.argErr) {
				sameIntents(t, emit.Intents(), nil)
				return
			}
			sameIntents(t, emit.Intents(), []*v1.UiIntent{showViewWith(command.ViewPanelPR, "s-aaaaaaaaaaa1", map[string]string{"slug": tt.wantSlug, "number": tt.number})})
		})
	}
}

// The item verbs always need a thread: from the CLI outside one they fail; in the app
// the selection is the thread (its context names it), and the change on screen is the
// feedback (no message).
func TestPanelItemVerbsScope(t *testing.T) {
	files := &commandtest.Files{Files: []string{"/wt/a.go"}}
	reg, emit := panelRegistryWith(t, &commandtest.Thread{Current: richThread()}, panelDeps{windows: 1, files: files})
	_, err := reg.Invoke(context.Background(), command.Context{}, "view.panel.file", map[string]string{"path": "/wt/a.go"})
	if !errors.Is(err, command.ErrUnavailable) {
		t.Errorf("outside a thread: err = %v, want ErrUnavailable", err)
	}
	gui := command.Context{ActiveThreadID: "s-aaaaaaaaaaa1", ActiveView: "thread"}
	res, err := reg.Invoke(context.Background(), gui, "view.panel.file", map[string]string{"path": "/wt/a.go"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message != "" {
		t.Errorf("message in the app = %q, want none", res.Message)
	}
	want := map[string]string{"path": "/wt/a.go", "project": "r1", "base": "/wt"}
	got := emit.Intents()
	if len(got) != 1 || !maps.Equal(got[0].GetShowView().GetParams(), want) || got[0].GetShowView().GetThreadId() != "s-aaaaaaaaaaa1" {
		t.Errorf("intents = %v", got)
	}
}

// checkItemErr checks err against a wanted connect code or ArgError, and reports
// whether one was wanted (the call failed, as it should).
func checkItemErr(t *testing.T, err error, code connect.Code, arg string) bool {
	t.Helper()
	switch {
	case arg != "":
		var argErr *command.ArgError
		if !errors.As(err, &argErr) || argErr.Arg != arg {
			t.Errorf("err = %v, want an ArgError for %s", err, arg)
		}
		return true
	case code != 0:
		if connect.CodeOf(err) != code {
			t.Errorf("err = %v, want code %v", err, code)
		}
		return true
	case err != nil:
		t.Fatal(err)
	}
	return false
}
