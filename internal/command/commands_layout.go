package command

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
)

// The window shell's layout as commands (docs/notes/shell-model.md, docs/notes/shell-plan.md
// section 2.8, docs/notes/shell-4-commands.md): spaces, panes, tabs and a thread's own tab.
// Every verb runs one op of internal/layout through the layout store, which serialises them,
// lays panes out in the viewport the last window reported and publishes the result; the
// window only renders it.
//
// Two rules make the same verbs safe for a model:
//   - From inside a thread (a thread's CLI, a page or a plugin: not Context.FromUser) a verb
//     acts only on the ids it is given. The user's focused space, pane or tab is not a
//     default there: the call is refused, and `layout show` lists the ids.
//   - From inside a thread a verb never moves the user's focus unless --focus is given: the
//     op runs with KeepFocus, so a tab it opens or moves becomes active in its own pane and
//     waits behind the focused tab in the focused pane. A verb whose only effect is to move
//     the focus (space.switch, pane.focus) is refused without --focus.

// layoutCategory is the palette group and the guide topic (`code-foundry guide layout`).
const layoutCategory = "Layout"

// LayoutDeps back the layout commands.
type LayoutDeps struct {
	// Layout is the layout store. Nil registers the commands failing with Unimplemented.
	Layout layoutstore.Store
	// Thread checks the thread a verb names, lists and archives the threads of a space
	// being removed, and names threads in layout.show. Nil: unchecked, nothing archived,
	// threads shown by id.
	Thread ThreadBackend
}

// layout is what every layout command runs against.
type layout struct {
	store  layoutstore.Store
	thread ThreadBackend
}

var errNoLayout = connect.NewError(connect.CodeUnimplemented, errors.New("this daemon keeps no layout"))

// state is the layout now.
func (l layout) state() (*layoutstore.Snapshot, error) {
	if l.store == nil {
		return nil, errNoLayout
	}
	return l.store.Snapshot(), nil
}

// apply runs op. keep runs it without moving the user's focus.
func (l layout) apply(ctx context.Context, op core.Op, keep bool) (layoutstore.Commit, error) {
	if l.store == nil {
		return layoutstore.Commit{}, errNoLayout
	}
	c, err := l.store.Apply(ctx, op, layoutstore.ApplyOptions{KeepFocus: keep})
	if err != nil {
		return c, layoutErr(err)
	}
	return c, nil
}

// layoutErr maps internal/layout's errors to Connect codes, as internal/api does: a refusal
// is the caller's mistake (exit 2), not a failure.
func layoutErr(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, core.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, core.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, core.ErrAlreadyExists):
		code = connect.CodeAlreadyExists
	case errors.Is(err, core.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, layoutstore.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}

// focusArg is the --focus flag of every layout verb that can move the user's focus.
var focusArg = ArgSpec{
	Name: "focus", Type: Bool,
	Description: "Take the user's focus there. Default: yes from the app and from the CLI outside a thread; from inside a thread, " +
		"only with this flag, and only when the user asked to be taken there",
}

// wantsFocus is whether the call moves the user's focus: --focus when given, else only the
// user in person.
func wantsFocus(uctx Context, a Args) bool {
	if a.Given("focus") {
		return a.Bool("focus")
	}
	return uctx.FromUser()
}

// onlyFocus refuses a verb that does nothing but move the focus from inside a thread
// without --focus.
func onlyFocus(uctx Context, a Args, verb string) error {
	if wantsFocus(uctx, a) {
		return nil
	}
	return connect.NewError(connect.CodeFailedPrecondition,
		fmt.Errorf("%s only moves the user's focus; from inside a thread pass --focus, and only when the user asked to be taken there", verb))
}

// implicit refuses a default from the user's focus for a call from inside a thread.
func implicit(uctx Context, arg, noun string) error {
	if uctx.FromUser() {
		return nil
	}
	return InvalidArg(arg, "from inside a thread, name the %s (--%s): the user's focused %s is not yours to act on; "+
		"`code-foundry layout show` lists the ids", noun, arg, noun)
}

// spaceArg is the --space of a verb acting on one space (default: the current one).
func spaceArg(desc string) ArgSpec {
	return ArgSpec{Name: "space", Type: String, ID: SpaceID, Description: desc + " (an id, a unique id suffix, or its name)"}
}

// space is the space a verb acts on: arg's value, else the current space for the user.
func (l layout) space(st *core.State, uctx Context, a Args, arg string) (*core.Space, error) {
	id := a.String(arg)
	if id == "" {
		if err := implicit(uctx, arg, "space"); err != nil {
			return nil, err
		}
		id = st.CurrentSpace
	}
	sp := st.Space(id)
	if sp == nil {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no space %s", id))
	}
	return sp, nil
}

// focused is the current space and its focused pane, the default of a pane or tab arg for
// the user; from inside a thread the arg is refused instead (implicit).
func focused(st *core.State, uctx Context, arg, noun string) (*core.Space, *core.Node, error) {
	if err := implicit(uctx, arg, noun); err != nil {
		return nil, nil, err
	}
	sp := st.Space(st.CurrentSpace)
	if sp == nil || sp.Focus == "" {
		return nil, nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("the current space has no pane"))
	}
	_, p := st.FindPane(sp.Focus)
	return sp, p, nil
}

// pane is the pane a verb acts on: arg's value, else the current space's focused pane for
// the user.
func (l layout) pane(st *core.State, uctx Context, a Args, arg string) (*core.Space, *core.Node, error) {
	id := a.String(arg)
	if id == "" {
		return focused(st, uctx, arg, "pane")
	}
	sp, p := st.FindPane(id)
	if p == nil {
		return nil, nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no pane %s", id))
	}
	return sp, p, nil
}

// tab is the tab a verb acts on: arg's value, else the focused tab for the user.
func (l layout) tab(st *core.State, uctx Context, a Args, arg string) (*core.Space, *core.Node, *core.Tab, error) {
	id := a.String(arg)
	if id == "" {
		sp, p, err := focused(st, uctx, arg, "tab")
		if err != nil {
			return nil, nil, nil, err
		}
		if tb := p.ActiveTab(); tb != nil {
			return sp, p, tb, nil
		}
		return nil, nil, nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("no tab has the focus"))
	}
	sp, p, tb := st.FindTab(id)
	if tb == nil {
		return nil, nil, nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no tab %s", id))
	}
	return sp, p, tb, nil
}

// LayoutResult is the JSON result of a verb that changed the layout: the commit's rev, and
// what the op reports (internal/layout's Result).
type LayoutResult struct {
	Rev     uint64 `json:"rev"`
	Changed bool   `json:"changed"`
	core.Result
}

// layoutResult is a commit's result, with msg for the CLI only (the app shows the change).
func layoutResult(uctx Context, c layoutstore.Commit, msg string) Result {
	res := Result{JSON: LayoutResult{Rev: c.Rev, Changed: c.Changed, Result: c.Result}}
	if uctx.ActiveView == "" {
		if !c.Changed {
			msg += " (nothing changed)"
		}
		res.Message = msg
	}
	return res
}

// layoutIDs lists the ids of one kind of thing in the layout now.
func (l layout) ids(each func(st *core.State, add func(string))) IDLister {
	return func(context.Context) ([]string, error) {
		snap, err := l.state()
		if err != nil {
			return nil, err
		}
		var out []string
		each(snap.State, func(id string) { out = append(out, id) })
		return out, nil
	}
}

func eachNode(st *core.State, f func(*core.Node)) {
	for _, sp := range st.Spaces {
		var walk func(n *core.Node)
		walk = func(n *core.Node) {
			if n == nil {
				return
			}
			f(n)
			for _, k := range n.Kids {
				walk(k)
			}
		}
		walk(sp.Root)
	}
}

// resolveSpace turns a space reference into its id: the id, a unique suffix of one, or a
// name (case does not matter).
func (l layout) resolveSpace(_ context.Context, arg, ref string) (string, error) {
	snap, err := l.state()
	if err != nil {
		return "", err
	}
	var byName, bySuffix []string
	for _, sp := range snap.State.Spaces {
		switch {
		case sp.ID == ref:
			return ref, nil
		case strings.EqualFold(sp.Name, ref):
			byName = append(byName, sp.ID)
		case len(ref) >= MinIDSuffix && strings.HasSuffix(sp.ID, ref):
			bySuffix = append(bySuffix, sp.ID)
		}
	}
	for _, ids := range [][]string{byName, bySuffix} {
		switch len(ids) {
		case 0:
			continue
		case 1:
			return ids[0], nil
		default:
			return "", InvalidArg(arg, "%q names %d spaces (%s); pass an id", ref, len(ids), strings.Join(ids, ", "))
		}
	}
	return "", connect.NewError(connect.CodeNotFound, fmt.Errorf("no space %q (code-foundry space list)", ref))
}

// RegisterLayout registers the layout commands: layout.show, space.*, pane.*, tab.*,
// thread.open, thread.close, thread.space.move, composer.new and composer.draft.*, and the
// tab, pane, split, space and draft id kinds they take.
func RegisterLayout(r *Registry, d LayoutDeps) error {
	l := layout{store: d.Layout, thread: d.Thread}
	r.SetIDLister(TabID, l.ids(func(st *core.State, add func(string)) {
		eachNode(st, func(n *core.Node) {
			for _, tb := range n.Tabs {
				add(tb.ID)
			}
		})
	}))
	r.SetIDLister(PaneID, l.ids(func(st *core.State, add func(string)) {
		eachNode(st, func(n *core.Node) {
			if n.IsPane() {
				add(n.ID)
			}
		})
	}))
	r.SetIDLister(SplitID, l.ids(func(st *core.State, add func(string)) {
		eachNode(st, func(n *core.Node) {
			if !n.IsPane() {
				add(n.ID)
			}
		})
	}))
	r.SetIDLister(DraftID, l.ids(func(st *core.State, add func(string)) {
		for _, sp := range st.Spaces {
			for _, d := range sp.Drafts {
				add(d.ID)
			}
		}
	}))
	r.SetRefResolver(SpaceID, l.resolveSpace)
	var errs []error
	for _, c := range slices.Concat(l.readCommands(), l.spaceCommands(), l.paneCommands(), l.tabCommands(), l.threadCommands(), l.composerCommands()) {
		errs = append(errs, r.Register(c))
	}
	return errors.Join(errs...)
}

// readCommands are layout.show, space.list and tab.list.
func (l layout) readCommands() []Command {
	return []Command{
		{
			Name: "layout.show", Title: "Show Layout", Category: layoutCategory,
			Description: "Print the layout: each space, its pane tree as an indented outline with split, pane and tab ids, " +
				"each tab's kind and thread, the active tab of each pane (*) and the focused pane. --json prints the whole layout.",
			Args:     []ArgSpec{spaceArg("Only this space")},
			ReadOnly: true, NoPalette: true, NoKeybinding: true, Page: PageState,
			Run: l.show,
		},
		{
			Name: "space.list", Title: "List Spaces", Category: layoutCategory,
			Description: "List the spaces in order, with their ids, the current one marked, and how many panes and tabs each has.",
			ReadOnly:    true, NoPalette: true, NoKeybinding: true, Page: PageState,
			Run: func(_ context.Context, _ Context, _ Args) (Result, error) {
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				st := snap.State
				type row struct {
					ID      string `json:"id"`
					Name    string `json:"name"`
					Current bool   `json:"current,omitempty"`
					Panes   int    `json:"panes"`
					Tabs    int    `json:"tabs"`
				}
				var rows []row
				var b strings.Builder
				for i, sp := range st.Spaces {
					r := row{ID: sp.ID, Name: sp.Name, Current: sp.ID == st.CurrentSpace}
					for _, p := range core.Panes(sp.Root) {
						r.Panes++
						r.Tabs += len(p.Tabs)
					}
					rows = append(rows, r)
					mark := " "
					if r.Current {
						mark = "*"
					}
					fmt.Fprintf(&b, "%s %d. %s  %s  %s, %s\n", mark, i+1, sp.ID, sp.Name, plural(r.Panes, "pane"), plural(r.Tabs, "tab"))
				}
				return Result{Message: strings.TrimRight(b.String(), "\n"), JSON: rows}, nil
			},
		},
		{
			Name: "tab.list", Title: "List Tabs", Category: layoutCategory,
			Description: "List the open tabs in layout order with their space, pane, kind and thread.",
			Args: []ArgSpec{
				spaceArg("Only this space"),
				{Name: "thread", Type: String, ID: ThreadID, Description: "Only this thread's tab and its linked tabs" + IDHelp},
			},
			ReadOnly: true, NoPalette: true, NoKeybinding: true, Page: PageState,
			Run: func(_ context.Context, uctx Context, a Args) (Result, error) {
				snap, err := l.state()
				if err != nil {
					return Result{}, err
				}
				st := layoutFor(uctx, snap.State) // command_lines.go
				type row struct {
					Space  string `json:"space"`
					Pane   string `json:"pane"`
					Active bool   `json:"active,omitempty"`
					*core.Tab
				}
				var rows []row
				var b strings.Builder
				for _, sp := range st.Spaces {
					if s := a.String("space"); s != "" && s != sp.ID {
						continue
					}
					for _, p := range core.Panes(sp.Root) {
						for _, tb := range p.Tabs {
							if th := a.String("thread"); th != "" && tb.Thread != th {
								continue
							}
							rows = append(rows, row{Space: sp.ID, Pane: p.ID, Active: p.Active == tb.ID, Tab: tb})
							fmt.Fprintf(&b, "%s  %s  %s  %s\n", tb.ID, sp.ID, p.ID, tabWords(tb, nil))
						}
					}
				}
				if len(rows) == 0 {
					return Result{Message: "no tabs", JSON: []row{}}, nil
				}
				return Result{Message: strings.TrimRight(b.String(), "\n"), JSON: rows}, nil
			},
		},
	}
}

// LayoutView is layout.show's JSON: the layout at a rev and the pane area the daemon lays it
// out in.
type LayoutView struct {
	Rev          uint64                       `json:"rev"`
	Width        float64                      `json:"width"`
	Height       float64                      `json:"height"`
	CurrentSpace string                       `json:"current_space"`
	DefaultSpace string                       `json:"default_space"`
	Spaces       []*core.Space                `json:"spaces"`
	Threads      map[string]*core.ThreadState `json:"threads,omitempty"`
}

func (l layout) show(ctx context.Context, uctx Context, a Args) (Result, error) {
	snap, err := l.state()
	if err != nil {
		return Result{}, err
	}
	st := layoutFor(uctx, snap.State) // command_lines.go
	vp := l.store.Viewport()
	view := LayoutView{Rev: snap.Rev, Width: vp.Width, Height: vp.Height, CurrentSpace: st.CurrentSpace, DefaultSpace: st.DefaultSpace}
	only := a.String("space")
	for _, sp := range st.Spaces {
		if only == "" || sp.ID == only {
			view.Spaces = append(view.Spaces, sp)
		}
	}
	if only == "" {
		view.Threads = st.Threads
	} else {
		view.Threads = maps.Collect(func(yield func(string, *core.ThreadState) bool) {
			for id, ts := range st.Threads {
				if ts.Space == only && !yield(id, ts) {
					return
				}
			}
		})
	}
	names := l.threadNames(ctx)
	var b strings.Builder
	fmt.Fprintf(&b, "rev %d, laid out in %gx%g\n", snap.Rev, vp.Width, vp.Height)
	for _, sp := range view.Spaces {
		fmt.Fprintf(&b, "space %s %q", sp.ID, sp.Name)
		if sp.ID == st.CurrentSpace {
			b.WriteString(" (current)")
		}
		if sp.ID == st.DefaultSpace {
			b.WriteString(" (default: threads with no space live here)")
		}
		b.WriteString("\n")
		if sp.Root == nil {
			b.WriteString("  (no panes)\n")
		}
		writeNode(&b, sp, sp.Root, 1, names)
	}
	writeThreads(&b, view.Threads, st.DefaultSpace, names)
	return Result{Message: strings.TrimRight(b.String(), "\n"), JSON: view}, nil
}

// writeNode writes n and what is under it, indented by depth.
func writeNode(b *strings.Builder, sp *core.Space, n *core.Node, depth int, names map[string]string) {
	if n == nil {
		return
	}
	pad := strings.Repeat("  ", depth)
	if !n.IsPane() {
		sizes := make([]string, len(n.Sizes))
		for i, s := range n.Sizes {
			sizes[i] = fmt.Sprintf("%.2f", s)
		}
		fmt.Fprintf(b, "%s%s %s [%s]\n", pad, n.Dir, n.ID, strings.Join(sizes, " "))
		for _, k := range n.Kids {
			writeNode(b, sp, k, depth+1, names)
		}
		return
	}
	fmt.Fprintf(b, "%spane %s", pad, n.ID)
	if n.ID == sp.Focus {
		b.WriteString(" (focused)")
	}
	b.WriteString("\n")
	for _, tb := range n.Tabs {
		mark := " "
		if tb.ID == n.Active {
			mark = "*"
		}
		fmt.Fprintf(b, "%s  %s %s %s\n", pad, mark, tb.ID, tabWords(tb, names))
	}
}

// tabWords describe a tab: its kind, its thread, and its title or manual name.
func tabWords(tb *core.Tab, names map[string]string) string {
	w := tb.Kind
	if tb.Thread != "" {
		rel := " of "
		if tb.Kind == "thread" {
			rel = " "
		}
		w += rel + tb.Thread
		if n := names[tb.Thread]; n != "" {
			w += fmt.Sprintf(" %q", n)
		}
	}
	if id := tb.Params[core.TerminalParam]; tb.Kind == "terminal" && id != "" {
		w += " terminal " + id
	}
	switch {
	case tb.Name != "":
		w += fmt.Sprintf(" named %q", tb.Name)
	case tb.Title != "":
		w += fmt.Sprintf(" %q", tb.Title)
	}
	return w
}

// threadNames are the names of the threads the daemon knows, by id; empty when it cannot
// list them (the outline then shows ids alone).
func (l layout) threadNames(ctx context.Context) map[string]string {
	if l.thread == nil {
		return nil
	}
	res, err := l.thread.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{All: true}}))
	if err != nil {
		return nil
	}
	out := map[string]string{}
	for _, t := range res.Msg.GetThreads() {
		out[t.GetId()] = t.GetName()
	}
	return out
}
