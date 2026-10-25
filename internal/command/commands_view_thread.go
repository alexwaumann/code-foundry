package command

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Thread-scoped panel verbs (docs/notes/control-1-thread-scoped-views.md,
// control-5-fixes.md). The view.panel.* verbs act on a side panel. From the GUI
// (palette, keybinding, header button) they act on what each window has selected, as
// before. From the CLI inside a thread (--context-thread defaults to
// $CODE_FOUNDRY_THREAD, and --thread to that) or with --thread, the ShowView carries the
// thread's id, and windows apply it to that thread's panel without changing their
// selection: the model in a thread can show the user something in its own thread
// without taking over what the user looks at. --focus selects the thread in every
// window first.

// ThreadGetter reads one thread (ThreadService.Get). The thread-scoped panel verbs check
// that the thread exists, and the surfaces that it has something to show.
type ThreadGetter interface {
	Get(context.Context, *connect.Request[v1.GetThreadRequest]) (*connect.Response[v1.GetThreadResponse], error)
}

// PanelThreads reads threads for the panel verbs: one (Get), and the threads one
// created (List), which view.panel.threads needs to know the thread has lineage.
type PanelThreads interface {
	ThreadGetter
	List(context.Context, *connect.Request[v1.ListThreadsRequest]) (*connect.Response[v1.ListThreadsResponse], error)
}

// panelThreadArgs are the --thread and --focus args of every verb that acts on a side
// panel (view.panel.*).
func panelThreadArgs() []ArgSpec {
	return []ArgSpec{
		{
			Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
			Description: "Thread whose side panel it acts on, without changing what any window shows " +
				"(default: the thread this runs in, $CODE_FOUNDRY_THREAD; in the app and outside a thread: each window's selection)" + IDHelp,
		},
		{Name: "focus", Type: Bool, Description: "Also select the thread in every window first; only when the user asked to be taken there"},
	}
}

// panelThread is the thread a panel verb's ShowView is scoped to: --thread when the CLI
// sent the call (ActiveView is empty only there, and the arg defaults to the CLI's
// --context-thread, $CODE_FOUNDRY_THREAD) or the caller passed it explicitly; "" for the
// GUI's own palette and keybindings, whose context default is the window's selection,
// so they act on each window's selection as before.
func panelThread(uctx Context, a Args) string {
	if uctx.ActiveView != "" && !a.Given("thread") {
		return ""
	}
	return a.String("thread")
}

// cliThread is a CLI call that names a thread (--thread, --context-thread or
// $CODE_FOUNDRY_THREAD). It cannot name the thread's workspace or worktree, which When
// would need; Run reads them from the thread instead (panelCheck).
func cliThread(c Context) bool { return c.ActiveView == "" && hasThread(c) }

// panelCheck checks that a thread can show a surface, and returns the ShowView's params
// (what the surface shows; nil for a surface that follows the thread). A refusal is an
// error: refuse for "the thread has nothing to show there". nil: any thread can.
type panelCheck func(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error)

// refuse is a panel check's FailedPrecondition: "thread s-… <why>".
func refuse(t *v1.Thread, why string) error {
	return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("thread %s %s", t.GetId(), why))
}

// placed is a panelCheck that refuses with why when ok says no.
func placed(ok func(*v1.Thread) bool, why string) panelCheck {
	return func(_ context.Context, t *v1.Thread, _ Args) (map[string]string, error) {
		if !ok(t) {
			return nil, refuse(t, why)
		}
		return nil, nil
	}
}

// inWorktree is view.panel.worktree's check (view.panel.diff's starts with it).
var inWorktree = placed(func(t *v1.Thread) bool { return t.GetProjectId() != "" && t.GetWorktreePath() != "" }, "runs in no project worktree")

// withLinkedPRs is view.panel.linked-prs's check: the GUI lists the surface only for a
// thread with links, and opening it for one without is a no-op there.
var withLinkedPRs = placed(func(t *v1.Thread) bool { return len(t.GetLinkedPullRequests()) > 0 }, "has no linked pull requests yet")

// withAgentRuns is view.panel.agents's check, like withLinkedPRs.
var withAgentRuns = placed(func(t *v1.Thread) bool { return len(t.GetAgentRuns()) > 0 }, "has no subagent runs yet")

// withLineage is view.panel.threads's check, like withLinkedPRs: a thread has lineage
// when another thread created it (its siblings come with that) or it created one
// (gui/frontend/src/lib/lineage.ts hasLineage).
func withLineage(threads PanelThreads) panelCheck {
	return func(ctx context.Context, t *v1.Thread, _ Args) (map[string]string, error) {
		if t.GetCreatedBy() != "" {
			return nil, nil
		}
		res, err := threads.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{All: true, CreatedBy: t.GetId()}}))
		if err != nil {
			return nil, err
		}
		if slices.ContainsFunc(res.Msg.GetThreads(), func(c *v1.Thread) bool { return c.GetCreatedBy() == t.GetId() && c.GetId() != t.GetId() }) {
			return nil, nil
		}
		return nil, refuse(t, "has no related threads: no thread created it and it created none")
	}
}

// PanelResult is the JSON result of a thread-scoped panel verb; an unscoped one answers
// EmitResult like every ui.* command.
type PanelResult struct {
	// Windows and Receivers are EmitResult's: the app windows connected (0: nothing was
	// shown) and every stream that received the intent.
	Windows   int    `json:"windows"`
	Receivers int    `json:"receivers"`
	Thread    string `json:"thread"`
	// Focused: --focus selected the thread in the windows (only with a window open).
	Focused bool `json:"focused,omitempty"`
}

// showViewIntent is a ShowView of name, scoped to thread when it is not "", with params.
func showViewIntent(name, thread string, params map[string]string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name, ThreadId: thread, Params: params}}}
}

// showPanel runs a panel verb: ShowView name, scoped to panelThread. An unscoped call
// answers EmitResult, with its message only from the CLI (the GUI toasts non-empty
// ones; the view change is feedback enough). --focus on the CLI without a thread is an
// error; in the app the selection is the target already, so it is ignored there.
func showPanel(ctx context.Context, t ThreadGetter, e Emitter, uctx Context, a Args, name string, check panelCheck) (Result, error) {
	id := panelThread(uctx, a)
	if id == "" {
		if a.Bool("focus") && uctx.ActiveView == "" {
			return Result{}, InvalidArg("focus", "needs a thread to select (--thread, or run it inside a thread)")
		}
		return EmitTo(e, showViewIntent(name, "", nil)).CLIResult(uctx), nil
	}
	return showScoped(ctx, t, e, uctx, a, id, name, check)
}

// showScoped runs a panel verb scoped to thread id: it reads the thread through t (an
// unknown thread fails; check, when set, may refuse it and gives the params) and, with
// --focus, emits an explicit FocusThread for it before the ShowView. From the CLI it
// says which thread's panel it went to, or that no window is open.
func showScoped(ctx context.Context, t ThreadGetter, e Emitter, uctx Context, a Args, id, name string, check panelCheck) (Result, error) {
	var params map[string]string
	if t != nil {
		res, err := t.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
		if err != nil {
			return Result{}, err
		}
		th := res.Msg.GetThread()
		if th == nil {
			th = &v1.Thread{Id: id}
		}
		if check != nil {
			if params, err = check(ctx, th, a); err != nil {
				return Result{}, err
			}
		}
	}
	focus := a.Bool("focus")
	if focus {
		// Explicit: the user asked, so the window selects even a hidden thread just
		// created (which a FocusThread from thread.new leaves alone).
		e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: id, Explicit: true}}})
	}
	sent := EmitTo(e, showViewIntent(name, id, params))
	out := PanelResult{Windows: sent.Windows, Receivers: sent.Receivers, Thread: id, Focused: focus && sent.Windows > 0}
	res := Result{JSON: out}
	if uctx.ActiveView == "" {
		res.Message = out.message()
	}
	return res, nil
}

// message is a scoped panel verb's text: "windows=1 thread=s-…" (plus "focused"), or
// NoWindowMessage.
func (r PanelResult) message() string {
	if r.Windows == 0 {
		return NoWindowMessage
	}
	msg := fmt.Sprintf("windows=%d thread=%s", r.Windows, r.Thread)
	if r.Focused {
		msg += " focused"
	}
	return msg
}

// errNotViewed is a page verb's refusal from a thread no window shows.
var errNotViewed = errors.New("the user is looking at something else; pass --focus to take them there anyway")
