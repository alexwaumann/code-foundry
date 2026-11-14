package command

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// tab.reopen (docs/notes/shell-model.md, "Reopening closed tabs"; docs/notes/shell-25c-keys-drafts.md):
// the newest tab or pane the user closed in a space comes back. The layout keeps the history
// and puts the entry back (internal/layout reopen.go); this verb tells it which tabs can no
// longer come back for reasons only the daemon knows: a thread archived or removed, a file
// gone from disk. A terminal's tab comes back as a fresh shell, which the daemon's layout glue
// starts (Result.Fresh).

func (l layout) reopenCommand() Command {
	return Command{
		Name: "tab.reopen", Title: "Reopen Closed Tab", Category: layoutCategory, Page: PageState,
		Description: "Reopen the most recently closed tab or pane of a space (default: the current one), as the user closed it " +
			"(the app's closes and the CLI's outside a thread are recorded, at most 20 per space). A tab goes back into its " +
			"pane at its place, a pane beside the panes it sat beside; a thread's tab opens the thread with its remembered " +
			"tabs; a terminal's starts a fresh shell where the old one started. What can no longer come back (a thread " +
			"archived, a file gone) is skipped and dropped; what is open again is focused.",
		Args:        []ArgSpec{spaceArg("The space (default: the current one; from inside a thread, required)"), focusArg},
		Keybindings: []string{"cmd+shift+t"},
		NoIndex:     true,
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			snap, err := l.state()
			if err != nil {
				return Result{}, err
			}
			sp, err := l.space(snap.State, uctx, a, "space")
			if err != nil {
				return Result{}, err
			}
			gone, err := l.goneTabs(ctx, sp)
			if err != nil {
				return Result{}, err
			}
			c, err := l.apply(ctx, &core.ReopenClosed{Space: sp.ID, Gone: gone}, !wantsFocus(uctx, a))
			if err != nil {
				return Result{}, err
			}
			r := c.Result
			switch {
			case r.Tab == "":
				return cliOnly(uctx, fmt.Sprintf("nothing to reopen in space %s %q", sp.ID, sp.Name)), nil
			case r.Existing:
				return layoutResult(uctx, c, fmt.Sprintf("tab %s is open again already: focused it in pane %s", r.Tab, r.Pane)), nil
			}
			return layoutResult(uctx, c, fmt.Sprintf("reopened tab %s in pane %s", r.Tab, r.Pane)), nil
		},
	}
}

// goneTabs lists the tabs of sp's reopen history that can no longer come back: a thread's
// tab or linked tab whose thread is archived or removed, and a file tab whose file is gone.
// What the layout can tell for itself (a thread now in another space, a draft no longer
// listed, an identity no longer valid) it skips on its own.
func (l layout) goneTabs(ctx context.Context, sp *core.Space) ([]string, error) {
	var gone []string
	var live func(string) bool
	for _, e := range sp.Closed {
		for _, tb := range e.Tabs {
			if tb.Thread != "" {
				if live == nil {
					var err error
					if live, err = l.liveThreads(ctx); err != nil {
						return nil, err
					}
				}
				if !live(tb.Thread) {
					gone = append(gone, tb.ID)
					continue
				}
			}
			if tb.Kind == "file" && !fileExists(tb.Params["path"], tb.Params["base"]) {
				gone = append(gone, tb.ID)
			}
		}
	}
	return gone, nil
}

// liveThreads reports which threads exist and are not archived. Without a thread backend
// every thread counts as live.
func (l layout) liveThreads(ctx context.Context) (func(string) bool, error) {
	if l.thread == nil {
		return func(string) bool { return true }, nil
	}
	res, err := l.thread.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{All: true}}))
	if err != nil {
		return nil, fmt.Errorf("tab.reopen: list threads: %w", err)
	}
	live := map[string]bool{}
	for _, t := range res.Msg.GetThreads() {
		if t.GetArchivedAt() == nil {
			live[t.GetId()] = true
		}
	}
	return func(id string) bool { return live[id] }, nil
}

// fileExists reports whether a file tab's path is still there; a relative path is read from
// base. A path that cannot be checked for another reason (permissions) counts as there: the
// tab says what it finds.
func fileExists(path, base string) bool {
	if path == "" {
		return false
	}
	if !filepath.IsAbs(path) && base != "" {
		path = filepath.Join(base, path)
	}
	_, err := os.Stat(path)
	return !errors.Is(err, fs.ErrNotExist)
}
