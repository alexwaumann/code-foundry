package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Thread-scoped panel verbs (docs/notes/control-1-thread-scoped-views.md). The
// view.panel.* verbs act on a side panel. From the GUI (palette, keybinding, header
// button) they act on what each window has selected, as before. From the CLI inside a
// thread (--context-thread defaults to $CODE_FOUNDRY_THREAD, and --thread to that) or
// with --thread, the ShowView carries the thread's id, and windows apply it to that
// thread's panel without changing their selection: the model in a thread can show the
// user something in its own thread without taking over what the user looks at. --focus
// selects the thread in every window first.

// ThreadGetter reads one thread (ThreadService.Get). The thread-scoped panel verbs check
// that the thread exists, and the workspace and worktree surfaces that it is placed
// where they can show.
type ThreadGetter interface {
	Get(context.Context, *connect.Request[v1.GetThreadRequest]) (*connect.Response[v1.GetThreadResponse], error)
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
// would need; Run reads them from the thread instead (panelPlace).
func cliThread(c Context) bool { return c.ActiveView == "" && hasThread(c) }

// panelPlace says why a thread cannot show a surface ("is in no workspace"), or "" when
// it can. nil: any thread can.
type panelPlace func(*v1.Thread) string

// inWorkspace is view.panel.workspace's panelPlace.
func inWorkspace(t *v1.Thread) string {
	if t.GetWorkspaceId() == "" {
		return "is in no workspace"
	}
	return ""
}

// inWorktree is view.panel.worktree's panelPlace.
func inWorktree(t *v1.Thread) string {
	if t.GetProjectId() == "" || t.GetWorktreePath() == "" {
		return "runs in no project worktree"
	}
	return ""
}

// PanelResult is the JSON result of a thread-scoped panel verb; an unscoped one answers
// EmitResult like every ui.* command.
type PanelResult struct {
	Delivered int    `json:"delivered"`
	Thread    string `json:"thread"`
	// Focused: --focus selected the thread in every window first.
	Focused bool `json:"focused,omitempty"`
}

// showViewIntent is a ShowView of name, scoped to thread when it is not "".
func showViewIntent(name, thread string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name, ThreadId: thread}}}
}

// showPanel runs a panel verb: ShowView name, scoped to panelThread. A scoped call reads
// the thread through t first (an unknown thread fails; place, when set, may refuse it)
// and, with --focus, emits FocusThread for it before the ShowView. --focus on the CLI
// without a thread is an error. An unscoped call answers like before: no message (the GUI toasts
// non-empty ones; the view change is feedback enough), delivery in the JSON. A scoped
// one from the CLI also says which thread's panel it went to.
func showPanel(ctx context.Context, t ThreadGetter, e Emitter, uctx Context, a Args, name string, place panelPlace) (Result, error) {
	id := panelThread(uctx, a)
	if id == "" {
		// In the app the selection is the target already: --focus has nothing to add.
		if a.Bool("focus") && uctx.ActiveView == "" {
			return Result{}, InvalidArg("focus", "needs a thread to select (--thread, or run it inside a thread)")
		}
		return Result{JSON: EmitResult{Delivered: e.Emit(showViewIntent(name, ""))}}, nil
	}
	if t != nil {
		res, err := t.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
		if err != nil {
			return Result{}, err
		}
		if place != nil {
			if why := place(res.Msg.GetThread()); why != "" {
				return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("thread %s %s", id, why))
			}
		}
	}
	if a.Bool("focus") {
		e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: id}}})
	}
	n := e.Emit(showViewIntent(name, id))
	res := Result{JSON: PanelResult{Delivered: n, Thread: id, Focused: a.Bool("focus")}}
	if uctx.ActiveView == "" {
		res.Message = fmt.Sprintf("delivered=%d thread=%s", n, id)
	}
	return res, nil
}
