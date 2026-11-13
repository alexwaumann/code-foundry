package layout

import (
	"cmp"
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// The first-load import (docs/notes/shell-model.md, "First load for an existing user";
// docs/notes/shell-18-legacy-import.md): the classic window's side panels and bottom
// terminals become each thread's remembered set, so they come back when the thread is opened.
// No thread is opened, and the layout an import leaves for a classic user is one empty space.
// No process is touched: a terminal that ran keeps running, as the thread's quick terminal or
// as a remembered terminal tab.

// LegacyInput is what the import reads: the two classic stores as the window persisted them,
// and what the daemon knows of threads and terminals.
type LegacyInput struct {
	// Panel is localStorage "code-foundry.panel" (any version; empty: none).
	Panel []byte
	// Bottom is localStorage "code-foundry.bottom" (empty: none).
	Bottom []byte
	// Threads is every thread the daemon knows. A thread not listed is gone: what the stores
	// or the layout hold of it is dropped.
	Threads []LegacyThread
	// Terminals is every terminal the daemon runs or keeps.
	Terminals []LegacyTerminal
	// Projects is every registered project's id. A tab of a project that is not registered
	// (a diff's "project") is dropped: the window could only say the project is not found.
	// Nil: not checked.
	Projects map[string]bool
	// Surfaces is every plugin surface an installed plugin offers, as a tab kind
	// ("plugin.<plugin>.<surface>"). A tab of any other plugin surface is dropped: the window
	// could only say the surface is gone. Nil: not checked.
	Surfaces map[string]bool
	// WindowTabs are the thread tabs a window's command opened before the import, which no
	// window drew (TrackWindowTabs, legacy_window.go): they do not make a space arranged.
	WindowTabs []string
}

// gone says why tab tb cannot be shown any more (its project is not registered, its plugin
// surface is not installed), or "" when it can.
func (in LegacyInput) gone(tb *Tab) string {
	if p := tb.Params["project"]; tb.Kind == "diff" && in.Projects != nil && p != "" && !in.Projects[p] {
		return fmt.Sprintf("project %s is not registered", p)
	}
	if strings.HasPrefix(tb.Kind, "plugin.") && in.Surfaces != nil && !in.Surfaces[tb.Kind] {
		return fmt.Sprintf("no installed plugin offers %s", tb.Kind)
	}
	return ""
}

// LegacyThread is a thread the import may give a set to.
type LegacyThread struct {
	ID string
	// Archived threads live in no space and keep nothing.
	Archived bool
}

// LegacyTerminal is a terminal as the import reads it.
type LegacyTerminal struct {
	ID        string
	Labels    map[string]string
	StartedAt time.Time
	// Exited: the process ended (an action run or a setup keeps its output until removed).
	Exited bool
}

// LegacyResult is what an import did besides the new state.
type LegacyResult struct {
	// Threads lists, by thread id, the threads given something, sorted by id.
	Threads []LegacyThreadResult
	// Quick maps a thread to the running shell that becomes its quick terminal. The caller
	// labels it so (termlabel.QuickShell's slot); the layout has no record of which shell it is.
	Quick map[string]string
	// Folded lists the open linked tabs that went into their thread's remembered set.
	Folded []*Tab
	// Removed lists the tabs taken out of the layout and not remembered: unlinked terminal
	// tabs, and thread tabs an old window opened (LegacyInput.WindowTabs). Nothing ends with
	// them: their terminals, and a thread's quick terminal, keep running.
	Removed []*Tab
	// Dropped says, one line each, what could not be carried.
	Dropped []string
}

// LegacyThreadResult is what one thread was given.
type LegacyThreadResult struct {
	Thread string
	// Tabs are the ids of the tabs added to its remembered set, in order.
	Tabs []string
	// Quick is the terminal that became its quick terminal, if any.
	Quick string
}

// legacyKinds maps a classic side panel kind to the layout's (plugin kinds keep theirs).
var legacyKinds = map[string]string{
	"files":       "file",
	"diff":        "diff",
	"pullrequest": "pullrequest",
	"mcp":         "mcp",
	"gallery":     "gallery",
	"ember":       "ember.board",
}

// ImportLegacy is the first-load import on st (docs/notes/shell-18-legacy-import.md). It
// returns the new state, in normal form, or st and an error.
//
// It starts with what the layout already has. A space with a thread tab open was arranged
// with the new verbs and is left as it is. In any other space, the tabs the classic window's
// commands opened there for nobody to see go: a linked tab of a thread that lives in the space
// goes into the thread's remembered set, and an unlinked terminal tab (a project's shell, a
// free shell) is taken out with its terminal left running. Other tabs (a composer, a page)
// stay.
//
// Then, for each thread that is not archived, in id order, its remembered set gains, after
// what it already remembers and skipping what is open in its space or remembered already:
// its side panel's tabs (the first group, then the second), the linked tabs folded above, and
// its terminals (the shells, action runs and setups its bottom panel showed), oldest first.
// Its oldest running shell that no tab shows becomes its quick terminal instead, unless it has
// one; the bottom panel's open state and height become the quick terminal's. A thread whose
// tab is open keeps its set remembered for the next time it opens.
func ImportLegacy(st *State, in LegacyInput, ids IDs) (*State, LegacyResult, error) {
	t := &tx{st: st.Clone(), ids: ids}
	t.used = usedIDs(t.st) // before any tab leaves the tree, so no new id repeats a folded tab's
	res := LegacyResult{Quick: map[string]string{}}
	live := map[string]bool{}
	for _, th := range in.Threads {
		if th.ID != "" && !th.Archived {
			live[th.ID] = true
		}
	}
	terms := slices.Clone(in.Terminals)
	slices.SortStableFunc(terms, func(a, b LegacyTerminal) int {
		return cmp.Or(a.StartedAt.Compare(b.StartedAt), strings.Compare(a.ID, b.ID))
	})
	exists := map[string]bool{}
	for _, tm := range terms {
		exists[tm.ID] = true
	}

	t.closeWindowTabs(in.WindowTabs, &res)
	folded := t.foldAutomatic(live, exists, &res)

	panels := readPanel(in.Panel)
	bottom := readBottom(in.Bottom)
	for _, id := range slices.Sorted(maps.Keys(live)) {
		r := t.importThread(id, panels["thread:"+id], bottom["thread:"+id], folded[id], terms, in.gone, &res)
		if len(r.Tabs) > 0 || r.Quick != "" {
			res.Threads = append(res.Threads, r)
		}
	}
	for key := range panels {
		if id, ok := strings.CutPrefix(key, "thread:"); ok && !live[id] {
			res.Dropped = append(res.Dropped, fmt.Sprintf("thread %s is archived or gone: its side panel is dropped", id))
		}
	}
	slices.Sort(res.Dropped)
	t.finish()
	if err := Check(t.st); err != nil {
		return st, LegacyResult{}, fmt.Errorf("layout import: %w: %w", ErrBroken, err)
	}
	return t.st, res, nil
}

// foldAutomatic takes out of every space without a thread tab the tabs the classic window's
// commands opened there: linked tabs of threads living in the space (returned by thread, in
// layout order) and unlinked terminal tabs (Result.Removed). A tab of a thread that is gone,
// or of a terminal that is gone, is dropped.
func (t *tx) foldAutomatic(live, exists map[string]bool, res *LegacyResult) map[string][]*Tab {
	folded := map[string][]*Tab{}
	for _, sp := range t.st.Spaces {
		if arranged(sp, nil) {
			continue
		}
		for _, p := range Panes(sp.Root) {
			for _, tb := range slices.Clone(p.Tabs) {
				linked := tb.IsLinked() && t.st.SpaceOf(tb.Thread) == sp.ID
				free := tb.Kind == "terminal" && tb.Thread == ""
				if !linked && !free {
					continue
				}
				detach(sp, p, tb.ID)
				forget(sp, tb.ID)
				switch {
				case free:
					res.Removed = append(res.Removed, tb)
				case !live[tb.Thread]:
					res.Dropped = append(res.Dropped, fmt.Sprintf("tab %s: thread %s is archived or gone", tb.ID, tb.Thread))
				case tb.Kind == "terminal" && !exists[tb.Params[TerminalParam]]:
					res.Dropped = append(res.Dropped, fmt.Sprintf("tab %s: terminal %s is gone", tb.ID, tb.Params[TerminalParam]))
				default:
					folded[tb.Thread] = append(folded[tb.Thread], tb)
					res.Folded = append(res.Folded, tb)
				}
			}
		}
	}
	return folded
}

// arranged reports whether sp holds a thread tab other than those of window: someone opened a
// thread there with the new verbs, which the classic window never does (window: the thread
// tabs an old window's chord opened, legacy_window.go).
func arranged(sp *Space, window []string) bool {
	for _, p := range Panes(sp.Root) {
		for _, tb := range p.Tabs {
			if tb.Kind == "thread" && !slices.Contains(window, tb.ID) {
				return true
			}
		}
	}
	return false
}

// importThread gives thread id its remembered set and quick terminal (ImportLegacy).
func (t *tx) importThread(id string, panel *panelEntry, bottom *bottomEntry, folded []*Tab, terms []LegacyTerminal, gone func(*Tab) string, res *LegacyResult) LegacyThreadResult {
	r := LegacyThreadResult{Thread: id}
	sp := t.st.Space(t.st.SpaceOf(id))
	var recs []RememberedTab
	have := map[string]bool{}
	if ts := t.st.Threads[id]; ts != nil && ts.Remembered != nil {
		for _, rt := range ts.Remembered.Tabs {
			if _, key, err := Identify(rt.Tab); err == nil {
				have[key] = true
			}
		}
	}
	// add appends tb unless its surface is open in the thread's space or remembered already;
	// a tab without an id gets one. A tab the window could not show (its project or plugin is
	// gone) is dropped and listed.
	add := func(tb *Tab, active bool, what string) {
		k, key, err := Identify(tb)
		if err != nil {
			res.Dropped = append(res.Dropped, fmt.Sprintf("thread %s: %s: %v", id, what, err))
			return
		}
		if why := gone(tb); why != "" {
			res.Dropped = append(res.Dropped, fmt.Sprintf("thread %s: %s: %s", id, what, why))
			return
		}
		if have[key] || (sp != nil && t.sameTab(sp, k, key, "") != nil) {
			return
		}
		have[key] = true
		tb.Key = key
		if !k.Renameable {
			tb.Name = ""
		}
		if tb.ID == "" {
			tb.ID = t.newID("t-")
		}
		recs = append(recs, RememberedTab{Tab: tb, Active: active})
		r.Tabs = append(r.Tabs, tb.ID)
	}

	if panel != nil {
		for gi, g := range panel.Groups {
			for _, pt := range g.Tabs {
				kind := legacyKinds[pt.Kind]
				if strings.HasPrefix(pt.Kind, "plugin.") {
					kind = pt.Kind
				}
				if kind == "" {
					res.Dropped = append(res.Dropped, fmt.Sprintf("thread %s: side panel tab %s: no %q surface in the shell", id, pt.ID, pt.Kind))
					continue
				}
				params := maps.Clone(pt.Params)
				if len(params) == 0 {
					params = nil
				}
				// The tab the classic window showed: the focused group's active one. The set
				// comes back in one pane, where only one tab can be active.
				active := gi == panel.Focused && g.Active != nil && *g.Active == pt.ID
				add(&Tab{Kind: kind, Thread: id, Params: params, Title: pt.Title}, active, "side panel tab "+pt.ID)
			}
		}
	}
	termTabs := map[string]*Tab{}
	for _, tb := range folded {
		if tb.Kind == "terminal" {
			termTabs[tb.Params[TerminalParam]] = tb
			continue
		}
		add(tb, false, "tab "+tb.ID)
	}

	// The thread's terminals, oldest first: what its bottom panel showed.
	var mine []LegacyTerminal
	hasQuick := false
	for _, tm := range terms {
		if tm.Labels[termlabel.Thread] == id && termlabel.IsPanel(tm.Labels) {
			mine = append(mine, tm)
			hasQuick = hasQuick || (termlabel.IsQuick(tm.Labels) && !tm.Exited)
		}
	}
	shown := func(term string) bool {
		_, _, tb := findTerminalTab(t.st, term)
		return tb != nil || have["term:"+term]
	}
	if !hasQuick {
		for _, tm := range mine {
			if termlabel.IsShell(tm.Labels) && !tm.Exited && !shown(tm.ID) {
				r.Quick, hasQuick = tm.ID, true
				res.Quick[id] = tm.ID
				delete(termTabs, tm.ID)
				break
			}
		}
	}
	for _, tm := range mine {
		if tm.ID == r.Quick || termlabel.IsQuick(tm.Labels) {
			continue
		}
		tb := termTabs[tm.ID]
		delete(termTabs, tm.ID)
		if tb == nil {
			tb = &Tab{Kind: "terminal", Thread: id, Params: map[string]string{TerminalParam: tm.ID}}
		}
		add(tb, false, "terminal "+tm.ID)
	}
	// Linked terminal tabs of terminals the thread does not own (folded with it): kept.
	for _, tb := range folded {
		if tb.Kind == "terminal" && termTabs[tb.Params[TerminalParam]] == tb {
			add(tb, false, "tab "+tb.ID)
		}
	}

	if len(recs) > 0 {
		ts := threadState(t.st, id)
		if ts.Remembered == nil {
			ts.Remembered = &Remembered{}
		}
		ts.Remembered.Tabs = append(ts.Remembered.Tabs, recs...)
	}
	if bottom != nil && (t.st.Threads[id] == nil || t.st.Threads[id].Quick == nil) {
		q := Quick{Open: bottom.Open && hasQuick, Height: bottom.Height}
		if q != (Quick{}) {
			threadState(t.st, id).Quick = &q
		}
	}
	return r
}

// bottomEntry is one key of the classic bottom panel store: whether it was open, and its
// height.
type bottomEntry struct {
	Open   bool
	Height float64
}

// readBottom reads localStorage "code-foundry.bottom" (a zustand persist envelope of version
// 1) as its store's rehydrate does (sanitizeBottomState): another version, or anything that is
// not that shape, is no entry.
func readBottom(raw []byte) map[string]*bottomEntry {
	out := map[string]*bottomEntry{}
	var env struct {
		Version any `json:"version"`
		State   struct {
			ByKey map[string]any `json:"byKey"`
		} `json:"state"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &env) != nil {
		return out
	}
	if v, numeric := env.Version.(float64); numeric && v != 1 {
		return out // zustand keeps nothing of a version it has no migration for
	}
	for key, v := range env.State.ByKey {
		rec, ok := v.(map[string]any)
		if !ok {
			continue
		}
		e := &bottomEntry{Open: rec["open"] == true}
		if h, ok := rec["height"].(float64); ok && h > 0 && h < 1e6 && !math.IsNaN(h) {
			e.Height = h
		}
		out[key] = e
	}
	return out
}
