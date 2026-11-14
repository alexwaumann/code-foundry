package layout

import (
	"slices"
)

// Thread tabs an old window opened (docs/notes/shell-24a-import-moves.md, item 3).
//
// A window from before the shell, still open against a daemon that has the shell, takes its
// chords from the daemon's command list: its cmd+j runs terminal.quick, which opens the
// thread's own tab in a layout that window does not draw. Without telling such a tab apart,
// the import would take its space for one someone arranged with the new verbs, and the first
// load would not be one empty space.
//
// Until the import runs, no window draws the layout: the shell window imports before its first
// draw. So a thread tab that a window's command opens before the import was opened by a window
// that does not show it. The store keeps those tab ids (TrackWindowTabs) and gives them to the
// import (LegacyInput.WindowTabs), which closes them where nothing else was arranged
// (closeWindowTabs). A thread tab opened by the CLI or a thread's model (thread.open, its
// --focus) is never in the list, and a tab in the list leaves it as soon as such a caller acts
// on it (moves it, focuses it, opens its thread): it is then arranged on purpose.

// TrackWindowTabs is the list of thread tabs opened by a window before the import, after an op
// took prev to next: marked, plus the thread tabs the op opened when a window asked (window),
// less those the op acted on or moved when anyone else asked, and those no longer open. It is
// sorted, and nil when empty.
func TrackWindowTabs(marked []string, prev, next *State, res Result, window bool) []string {
	where := func(st *State) map[string]string {
		out := map[string]string{}
		for _, sp := range st.Spaces {
			for _, p := range Panes(sp.Root) {
				for _, tb := range p.Tabs {
					if tb.Kind == "thread" {
						out[tb.ID] = sp.ID + "/" + p.ID
					}
				}
			}
		}
		return out
	}
	before, after := where(prev), where(next)
	out := slices.DeleteFunc(slices.Clone(marked), func(id string) bool {
		at, open := after[id]
		if !open {
			return true
		}
		return !window && (res.Tab == id || before[id] != at)
	})
	if window {
		for id := range after {
			if _, was := before[id]; !was && !slices.Contains(out, id) {
				out = append(out, id)
			}
		}
	}
	slices.Sort(out)
	if len(out) == 0 {
		return nil
	}
	return out
}

// closeWindowTabs takes out of the layout the thread tabs of window (opened by a window that
// does not draw the layout) in each space where every thread tab is one of them; a space that
// also holds a thread tab someone opened on purpose is left as it is. The tabs go to
// res.Removed: nothing ends with them (a thread's quick terminal keeps running).
func (t *tx) closeWindowTabs(window []string, res *LegacyResult) {
	if len(window) == 0 {
		return
	}
	for _, sp := range t.st.Spaces {
		if arranged(sp, window) {
			continue
		}
		wasFocused := false
		for _, p := range Panes(sp.Root) {
			for _, tb := range slices.Clone(p.Tabs) {
				if tb.Kind != "thread" {
					continue
				}
				wasFocused = wasFocused || focusedTab(sp) == tb.ID
				detach(sp, p, tb.ID)
				forget(sp, tb.ID)
				res.Removed = append(res.Removed, tb)
			}
		}
		if wasFocused {
			refocus(sp)
		}
	}
}
