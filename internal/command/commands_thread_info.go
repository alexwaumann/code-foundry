package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// threadInfoSetting is settings.KeyThreadInfo (internal/store/settings imports this package).
const threadInfoSetting = "layout.thread_info"

// ThreadInfoResult is thread.info's JSON.
type ThreadInfoResult struct {
	// Rev is the layout commit's (the window waits for it).
	Rev      uint64 `json:"rev"`
	ThreadID string `json:"thread_id"`
	Open     bool   `json:"open"`
}

// threadInfoCommand is thread.info: shows or hides one thread's info card, kept with the thread
// in the layout (docs/notes/shell-model.md, "Thread info is per thread"). view.thread-info (the
// key and the header's button) reaches the window, which knows whether the pane has room for the
// card, and runs this with --open or --close when it does.
func (l layout) threadInfoCommand() Command {
	return Command{
		Name: "thread.info", Title: "Show or Hide Thread Info", Category: layoutCategory, Page: PageState,
		Description: "Show or hide a thread's info card (its checkout, branch and pull requests, git state, shells, related threads, " +
			"MCP servers, context and usage) beside its conversation. The choice is kept with the thread across panes, spaces and " +
			"restarts; a thread never toggled follows the setting layout.thread_info. Default: toggle. In the app, cmd+shift+i " +
			"(view.thread-info) toggles the focused thread's.",
		Args: []ArgSpec{
			layoutThreadArg(false),
			{Name: "open", Type: Bool, Description: "Show it (default: toggle)"},
			{Name: "close", Type: Bool, Description: "Hide it (default: toggle)"},
		},
		NoPalette: true, NoKeybinding: true,
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			if a.Bool("open") && a.Bool("close") {
				return Result{}, InvalidArg("open", "--open and --close together")
			}
			snap, err := l.state()
			if err != nil {
				return Result{}, err
			}
			thread := a.String("id")
			if thread == "" {
				_, p, err := focused(snap.State, uctx, "id", "thread")
				if err != nil {
					return Result{}, err
				}
				if p.ActiveTab() == nil || p.ActiveTab().Thread == "" {
					return Result{}, InvalidArg("id", "the focused tab belongs to no thread: name one")
				}
				thread = p.ActiveTab().Thread
			} else if thread, err = l.threadID(ctx, uctx, a); err != nil {
				return Result{}, err
			}
			var open bool
			switch {
			case a.Bool("open"):
				open = true
			case a.Bool("close"):
				open = false
			default:
				open = !l.infoShown(ctx, snap.State, thread)
			}
			c, err := l.apply(ctx, &core.SetInfo{Thread: thread, Open: open}, true)
			if err != nil {
				return Result{}, err
			}
			word := "hidden"
			if open {
				word = "shown"
			}
			out := layoutResult(uctx, c, fmt.Sprintf("thread %s's info card is %s", thread, word))
			out.JSON = ThreadInfoResult{Rev: c.Rev, ThreadID: thread, Open: open}
			return out, nil
		},
	}
}

// infoShown is whether thread shows its info card now: its own choice, else the setting
// layout.thread_info (shown when it cannot be read).
func (l layout) infoShown(ctx context.Context, st *core.State, thread string) bool {
	if ts := st.Threads[thread]; ts != nil && ts.Info != nil {
		return *ts.Info
	}
	if l.settings == nil {
		return true
	}
	res, err := l.settings.Get(ctx, connect.NewRequest(&v1.GetSettingsRequest{}))
	if err != nil {
		return true
	}
	v, ok := res.Msg.GetSettings().GetValues()[threadInfoSetting]
	return !ok || v != "false"
}
