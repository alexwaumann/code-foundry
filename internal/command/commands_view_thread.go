package command

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The item verbs act on one thread's tabs (docs/notes/control-1-thread-scoped-views.md,
// shell-22-retire-verbs.md): --thread, which defaults to the thread the CLI runs in
// ($CODE_FOUNDRY_THREAD) or the app's selected thread, names the thread whose tab opens. The
// tab is the whole effect: the layout's open_surface places it beside the thread
// (commands_view_open.go), and no intent goes to the windows. A model in a thread can show
// the user something without taking over what the user looks at; --focus takes them there.

// ThreadGetter reads one thread (ThreadService.Get). The item verbs check that the thread
// exists, and the surfaces that it has something to show.
type ThreadGetter interface {
	Get(context.Context, *connect.Request[v1.GetThreadRequest]) (*connect.Response[v1.GetThreadResponse], error)
}

// cliThread is a CLI call that names a thread (--thread, --context-thread or
// $CODE_FOUNDRY_THREAD). It cannot name the thread's workspace or worktree, which When
// would need; Run reads them from the thread instead (panelCheck).
func cliThread(c Context) bool { return c.ActiveView == "" && hasThread(c) }

// panelCheck checks that a thread can show a surface, and returns the tab's params (what
// the surface shows; nil for a surface that follows the thread). A refusal is an error:
// refuse for "the thread has nothing to show there". nil: any thread can.
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

// inWorktree is the first step of view.open.diff's check: the thread runs in a project worktree.
var inWorktree = placed(func(t *v1.Thread) bool { return t.GetProjectId() != "" && t.GetWorktreePath() != "" }, "runs in no project worktree")

// PanelResult is the JSON result of an item verb: where the layout has its tab.
type PanelResult struct {
	// Windows is the number of app windows connected (0: the layout keeps the tab for the
	// next window that opens).
	Windows int    `json:"windows"`
	Thread  string `json:"thread"`
	// Tab, Pane and Space are where the layout has the verb's tab (commands_view_open.go):
	// Rule says how placement chose the pane, Existing that a tab of the same identity was
	// open and is used, TabFocused that it took the user's focus. TabThread is the thread the
	// tab belongs to: another thread's when an open tab of the same identity was used (a file
	// is one per path), "" for none.
	//
	// ThreadNotOpen: Thread's own tab is open in no space, so the tab went to its space's
	// focused pane (Rule "focused"), not beside it: Behind when it waits behind the tab shown
	// there, OtherSpace when that space is not the one the user is in. JoinsSet: no window has
	// loaded the layout yet, and the first load takes the tab into the thread's remembered set
	// (it shows when the thread is opened).
	Tab           string `json:"tab,omitempty"`
	Pane          string `json:"pane,omitempty"`
	Space         string `json:"space,omitempty"`
	Rule          string `json:"rule,omitempty"`
	Existing      bool   `json:"existing,omitempty"`
	TabThread     string `json:"tab_thread,omitempty"`
	ThreadNotOpen bool   `json:"thread_not_open,omitempty"`
	Behind        bool   `json:"behind,omitempty"`
	OtherSpace    bool   `json:"other_space,omitempty"`
	JoinsSet      bool   `json:"joins_set,omitempty"`
	TabFocused    bool   `json:"tab_focused,omitempty"`
}

// showViewIntent is a ShowView of name with params.
func showViewIntent(name string, params map[string]string) *v1.UiIntent {
	return &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: name, Params: params}}}
}

// itemThread reads thread id through t (an unknown thread fails); without t, a thread of
// that id and nothing else.
func itemThread(ctx context.Context, t ThreadGetter, id string) (*v1.Thread, error) {
	if t == nil {
		return &v1.Thread{Id: id}, nil
	}
	res, err := t.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
	if err != nil {
		return nil, err
	}
	if th := res.Msg.GetThread(); th != nil {
		return th, nil
	}
	return &v1.Thread{Id: id}, nil
}

// windowsOf is how many app windows e reaches, 0 without e.
func windowsOf(e Emitter) int {
	if e == nil {
		return 0
	}
	return e.Windows()
}

// message is an item verb's text: where its tab is, and how many windows show the layout.
func (r PanelResult) message() string { return r.tabMessage() }

// errNotViewed is a page verb's refusal from a thread no window shows.
var errNotViewed = errors.New("the user is looking at something else; pass --focus to take them there anyway")
