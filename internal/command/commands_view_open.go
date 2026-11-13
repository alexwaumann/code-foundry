package command

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
)

// view.open.*: a thread's surfaces as tabs of the shell window's layout (docs/notes/shell-model.md,
// "Linked surfaces"; docs/notes/shell-7-view-open.md).
//
// Each verb checks its item as it always has, then opens a tab linked to the thread through the
// layout's open_surface, placed by the rules (or focused where it is, when a tab of the same
// identity is open). The tab is the whole effect: no intent goes to the windows
// (docs/notes/shell-22-retire-verbs.md). The view.panel.<item> names stay registered as unlisted
// aliases of the same command for one stable release.
//
// Focus follows the layout verbs' rule: the user's call (the app, the CLI outside a thread)
// focuses the tab; a thread's never does without --focus.

// Tab kinds of the item verbs (internal/layout/identity.go).
const (
	tabFile    = "file"
	tabDiff    = "diff"
	tabPR      = "pullrequest"
	tabGallery = "gallery"
	tabMcp     = "mcp"
	tabPRs     = "prs"
	tabProjs   = "projects"
)

// tabs opens surfaces as tabs of the layout.
type tabs struct{ store layoutstore.Store }

// open opens tb by the placement rules, or in pane when one is given (a pane's "+" menu),
// taking the user's focus when focus.
func (o tabs) open(ctx context.Context, tb *core.Tab, pane string, focus bool) (*core.Result, error) {
	if o.store == nil {
		return nil, errNoLayout
	}
	c, err := layout{store: o.store}.apply(ctx, &core.OpenSurface{Tab: tb, Pane: pane, Focus: focus}, !focus)
	if err != nil {
		return nil, fmt.Errorf("could not open its tab: %w", err)
	}
	return &c.Result, nil
}

// where says, for the result of an item verb that opened tab id for thread, what the layout
// now holds that its message must not get wrong (docs/notes/shell-24d-spec-differences.md,
// 3 and 4): the thread of an open tab it used (another thread's, or none: a file is one per
// path), and, when thread's own tab is open in no space, where its tab went instead of beside
// it. A closed thread's surface goes to its space's focused pane, behind the tab shown there
// when the call keeps the user's focus; before any window has loaded the layout (the first-load
// import has not run), the import takes it into the thread's remembered set, so it shows when
// the thread is opened.
func (o tabs) where(r *PanelResult, thread string) {
	snap := o.store.Snapshot()
	st := snap.State
	sp, p, tb := st.FindTab(r.Tab)
	if tb == nil {
		return
	}
	r.TabThread = tb.Thread
	if threadTabOpen(st, thread) || r.Existing {
		return
	}
	r.ThreadNotOpen = true
	r.Behind = p.Active != tb.ID
	r.OtherSpace = sp.ID != st.CurrentSpace
	r.JoinsSet = !snap.LegacyImported && tb.Thread != "" && st.SpaceOf(tb.Thread) == sp.ID && !holdsThreadTab(sp)
}

// threadTabOpen reports whether thread's own tab is open in any space.
func threadTabOpen(st *core.State, thread string) bool {
	for _, sp := range st.Spaces {
		if holdsTab(sp, func(tb *core.Tab) bool { return tb.Kind == "thread" && tb.Thread == thread }) {
			return true
		}
	}
	return false
}

// holdsThreadTab reports whether space sp has any thread's tab open (the first-load import
// leaves such a space as it is).
func holdsThreadTab(sp *core.Space) bool {
	return holdsTab(sp, func(tb *core.Tab) bool { return tb.Kind == "thread" })
}

func holdsTab(sp *core.Space, match func(*core.Tab) bool) bool {
	for _, p := range core.Panes(sp.Root) {
		for _, tb := range p.Tabs {
			if match(tb) {
				return true
			}
		}
	}
	return false
}

// openLead is how the item verbs' descriptions say where the tab goes.
const openLead = "beside a thread (from a thread: its own; in the app: the selected one), " +
	"or focus it where it is when the same one is open: "

// openThreadArg is the item verbs' --thread.
var openThreadArg = ArgSpec{
	Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
	Description: "Thread the tab belongs to; it opens beside it without taking the user's focus " +
		"(default: the thread this runs in, $CODE_FOUNDRY_THREAD; in the app: the selected thread)" + IDHelp,
}

// openFocusArg is the item verbs' --focus.
var openFocusArg = ArgSpec{Name: "focus", Type: Bool,
	Description: "Also take the user's focus to the tab; only when the user asked to be taken there"}

// openPaneArg is the --pane of the verbs that open a tab.
var openPaneArg = paneIDArg("pane", "Open the tab in this pane (the pane's + menu); a linked tab that is already open is focused where it is")

// itemTab is the tab of kind an item verb opens for thread, showing params. Its title is what
// `layout show` names it by until the window retitles it.
func itemTab(kind, thread string, params map[string]string) *core.Tab {
	tb := &core.Tab{Kind: kind, Thread: thread, Params: maps.Clone(params)}
	switch kind {
	case tabFile:
		tb.Title = params["title"]
		if tb.Title == "" && params["path"] != "" {
			tb.Title = filepath.Base(params["path"])
		}
	case tabPR:
		tb.Title = "#" + params["number"]
	case tabGallery, tabDiff:
		tb.Title = params["title"]
	}
	return tb
}

// showTab runs an item verb for thread id: the thread (an unknown one fails), the item's own
// check (which gives the tab's params or refuses), then the thread's tab of kind in the
// layout. A refusal opens nothing.
func showTab(ctx context.Context, o tabs, t ThreadGetter, e Emitter, uctx Context, a Args, id, kind string, check panelCheck) (Result, error) {
	th, err := itemThread(ctx, t, id)
	if err != nil {
		return Result{}, err
	}
	var params map[string]string
	if check != nil {
		if params, err = check(ctx, th, a); err != nil {
			return Result{}, err
		}
	}
	focus := wantsFocus(uctx, a)
	c, err := o.open(ctx, itemTab(kind, id, params), a.String("pane"), focus)
	if err != nil {
		return Result{}, err
	}
	out := PanelResult{Windows: windowsOf(e), Thread: id}
	out.placed(c, focus)
	o.where(&out, id)
	res := Result{JSON: out}
	if uctx.ActiveView == "" {
		res.Message = out.message()
	}
	return res, nil
}

// showItem is showTab with the view verbs' dependencies.
func (d ViewDeps) showItem(ctx context.Context, uctx Context, a Args, id, kind string, check panelCheck) (Result, error) {
	return showTab(ctx, tabs{d.Layout}, d.Thread, d.Emitter, uctx, a, id, kind, check)
}

// placed records where the layout put the verb's tab.
func (r *PanelResult) placed(c *core.Result, focus bool) {
	r.Tab, r.Pane, r.Space, r.Rule, r.Existing, r.TabFocused = c.Tab, c.Pane, c.Space, c.Rule, c.Existing, focus
}

// rulePhrases say how placement chose a tab's pane (core.Result.Rule).
var rulePhrases = map[string]string{
	"2": "beside the thread's other tabs", "3": "in a pane next to the thread's", "4": "in a pane of linked tabs",
	"5": "in a new pane right of the thread", "6": "in the thread's own pane", "pane": "in the pane asked for",
	"focused": "in the focused pane",
}

// tabMessage is an item verb's text: where its tab is, and the windows that show the layout.
// A tab already open names the thread it belongs to, which may not be the asker's; a tab for a
// thread whose own tab is not open says where it went instead, so the model does not tell the
// user it is beside the thread.
func (r PanelResult) tabMessage() string {
	msg := fmt.Sprintf("opened tab %s in pane %s for thread %s", r.Tab, r.Pane, r.Thread)
	if p := rulePhrases[r.Rule]; p != "" {
		msg += " (" + p + ")"
	}
	switch {
	case r.Existing && r.TabThread == "":
		msg = fmt.Sprintf("tab %s (of no thread) is already open in pane %s (nothing new opened)", r.Tab, r.Pane)
	case r.Existing:
		msg = fmt.Sprintf("thread %s's tab %s is already open in pane %s (nothing new opened)", r.TabThread, r.Tab, r.Pane)
	case r.JoinsSet:
		msg = fmt.Sprintf("thread %s's tab is not open, and no app window has loaded the layout yet: tab %s joins the thread's set of tabs "+
			"when one does, and shows beside the thread when the thread is opened", r.Thread, r.Tab)
	case r.ThreadNotOpen:
		msg = fmt.Sprintf("thread %s's tab is not open, so tab %s opened in pane %s, the focused pane of its space", r.Thread, r.Tab, r.Pane)
		if r.OtherSpace {
			msg += " (" + r.Space + ", not the space the user is in)"
		}
		if r.Behind {
			msg += ", behind the tab shown there"
		}
	}
	if r.TabFocused {
		msg += "; it has the user's focus"
	}
	if r.Windows == 0 {
		return msg + "; no app window is open"
	}
	return msg + fmt.Sprintf("; windows=%d", r.Windows)
}

// openAlias is the classic name of a view.open verb: the same command, kept for the threads and
// pages that know it, out of the palette and the agents' index.
func openAlias(c Command) Command {
	a := c
	a.Name = "view.panel." + strings.TrimPrefix(c.Name, "view.open.")
	a.NoIndex, a.NoPalette = true, true
	a.Description = "The old name of " + c.Name + ", kept for one stable release. " + c.Description
	return a
}

// withAliases is cmds, each followed by its classic alias.
func withAliases(cmds ...Command) []Command {
	out := make([]Command, 0, 2*len(cmds))
	for _, c := range cmds {
		out = append(out, c, openAlias(c))
	}
	return out
}

// pageTab opens a page's tab (the Pull Requests or Projects page, one per space) in the current
// space, or in --pane's. params nil keeps what an open tab shows; empty replaces it.
func (d ViewDeps) pageTab(ctx context.Context, uctx Context, a Args, kind string, params map[string]string) (*core.Result, error) {
	return tabs{d.Layout}.open(ctx, &core.Tab{Kind: kind, Params: maps.Clone(params)}, a.String("pane"), wantsFocus(uctx, a))
}

// PageTabResult is a page verb's JSON: the app windows connected, and where its tab is.
type PageTabResult struct {
	Windows  int    `json:"windows"`
	Tab      string `json:"tab"`
	Pane     string `json:"pane"`
	Space    string `json:"space"`
	Existing bool   `json:"existing,omitempty"`
}

// showPageTab runs a page verb: the refusal from a thread no window shows, then the page's tab
// of kind, which is the whole effect.
func (d ViewDeps) showPageTab(ctx context.Context, uctx Context, a Args, kind string, params map[string]string) (Result, error) {
	if err := d.refusePage(uctx, a); err != nil {
		return Result{}, err
	}
	placed, err := d.pageTab(ctx, uctx, a, kind, params)
	if err != nil {
		return Result{}, err
	}
	n := windowsOf(d.Emitter)
	res := Result{JSON: PageTabResult{Windows: n, Tab: placed.Tab, Pane: placed.Pane, Space: placed.Space, Existing: placed.Existing}}
	if uctx.ActiveView != "" {
		return res, nil
	}
	res.Message = fmt.Sprintf("opened %s tab %s in pane %s of space %s", kind, placed.Tab, placed.Pane, placed.Space)
	if placed.Existing {
		res.Message = fmt.Sprintf("%s tab %s is already open in pane %s of space %s", kind, placed.Tab, placed.Pane, placed.Space)
	}
	res.Message += "; " + EmitResult{Windows: n}.windows()
	return res, nil
}

// threadDiffCommand is view.thread-diff, the key for "the thread's diff, and back": from a
// thread's tab or any surface linked to it, the thread's diff (its checkout's), focused; from
// that diff, the thread's tab. Its chord is cmd+shift+d (docs/notes/shell-model.md, "Keys").
func (d ViewDeps) threadDiffCommand() Command {
	l := layout{store: d.Layout}
	return Command{
		Name:  "view.thread-diff",
		Page:  PageState,
		Title: "Toggle Thread Diff",
		Description: "Go to the focused thread's diff, opening it beside the thread when it is not open; from that diff, go back " +
			"to the thread. Acts on the focused tab (--tab: that one); it only moves the user's focus.",
		Category:    "View",
		Args:        []ArgSpec{tabIDArg("The tab to start from (default: the focused tab)"), focusArg},
		Keybindings: []string{"cmd+shift+d"},
		NoIndex:     true,
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			if err := onlyFocus(uctx, a, "view.thread-diff"); err != nil {
				return Result{}, err
			}
			snap, err := l.state()
			if err != nil {
				return Result{}, err
			}
			_, _, tb, err := l.tab(snap.State, uctx, a, "tab")
			if err != nil {
				return Result{}, err
			}
			thread := tb.Thread
			switch {
			case thread == "":
				return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("tab %s belongs to no thread", tb.ID))
			case tb.Kind == tabDiff:
				c, err := l.apply(ctx, &core.OpenThread{Thread: thread, Focus: true}, false)
				if err != nil {
					return Result{}, err
				}
				return layoutResult(uctx, c, fmt.Sprintf("back to thread %s (tab %s)", thread, c.Result.Tab)), nil
			}
			params, err := d.ownDiff(ctx, thread)
			if err != nil {
				return Result{}, err
			}
			want := itemTab(tabDiff, thread, params)
			var op core.Op = &core.OpenSurface{Tab: want, Focus: true}
			open := openDiff(snap.State, want)
			if open != "" {
				// Focus it as it is: the user's choices in it (a file, the sides) stay.
				op = &core.FocusTab{Tab: open}
			}
			c, err := l.apply(ctx, op, false)
			if err != nil {
				return Result{}, err
			}
			return layoutResult(uctx, c, fmt.Sprintf("thread %s's diff is tab %s", thread, cmp.Or(open, c.Result.Tab))), nil
		},
	}
}

// ownDiff is the params of a thread's own diff: its checkout, everything the branch changed.
func (d ViewDeps) ownDiff(ctx context.Context, thread string) (map[string]string, error) {
	if d.Thread == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("no threads here"))
	}
	res, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: thread}))
	if err != nil {
		return nil, err
	}
	t := res.Msg.GetThread()
	if t.GetProjectId() == "" || t.GetWorktreePath() == "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("thread %s runs in no project worktree, so it has no diff", thread))
	}
	return map[string]string{"project": t.GetProjectId(), "worktree": t.GetWorktreePath(), "own": "1"}, nil
}

// openDiff is the open tab with want's identity in its thread's space, "" when there is none.
func openDiff(st *core.State, want *core.Tab) string {
	if tb := openLinked(st, want); tb != nil {
		return tb.ID
	}
	return ""
}

// openLinked is the open tab with want's identity in its thread's space, nil when there is none.
func openLinked(st *core.State, want *core.Tab) *core.Tab {
	_, key, err := core.Identify(want)
	if err != nil || st == nil {
		return nil
	}
	sp := st.Space(st.SpaceOf(want.Thread))
	if sp == nil {
		return nil
	}
	for _, p := range core.Panes(sp.Root) {
		for _, tb := range p.Tabs {
			if tb.Key == key {
				return tb
			}
		}
	}
	return nil
}
