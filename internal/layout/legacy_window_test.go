package layout

import (
	"slices"
	"testing"
)

// TrackWindowTabs keeps the thread tabs a window opened before the import: a window's new
// thread tab joins, anyone else's act on one (the op's tab, or moving it) takes it out, and a
// tab that closed leaves.
func TestTrackWindowTabs(t *testing.T) {
	base := `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[{"id":"sp-a","name":"A","focus":"p-1",
		"root":{"t":"split","id":"s-1","dir":"row","sizes":[0.5,0.5],"kids":[
			{"t":"pane","id":"p-1","active":"t-a","tabs":[{"id":"t-a","kind":"thread","thread":"th-a"}]},
			{"t":"pane","id":"p-2","active":"t-g","tabs":[{"id":"t-g","kind":"projects"}]}]}}]}`
	prev := stateWith(t, base)
	opened, _, err := Apply(prev, &OpenThread{Thread: "th-b"}, &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	newTab := threadTabID(opened, "th-b")
	moved, _, err := Apply(prev, &MoveTab{Tab: "t-a", Pane: "p-2"}, &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	closed, _, err := Apply(prev, &CloseThread{Thread: "th-a"}, &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		marked     []string
		prev, next *State
		res        Result
		window     bool
		want       []string
	}{
		{"a window opens a thread tab: marked", nil, prev, opened, Result{Tab: newTab}, true, []string{newTab}},
		{"the CLI opens a thread tab: not marked", nil, prev, opened, Result{Tab: newTab}, false, nil},
		{"a window acts on a marked tab: still marked", []string{"t-a"}, prev, moved, Result{Tab: "t-a"}, true, []string{"t-a"}},
		{"the CLI moves a marked tab: arranged now", []string{"t-a"}, prev, moved, Result{Tab: "t-a"}, false, nil},
		{"the CLI focuses a marked tab (no change): arranged now", []string{"t-a"}, prev, prev, Result{Tab: "t-a"}, false, nil},
		{"the CLI acts elsewhere: still marked", []string{"t-a"}, prev, opened, Result{Tab: newTab}, false, []string{"t-a"}},
		{"a marked tab closed: gone", []string{"t-a"}, prev, closed, Result{Tab: "t-a"}, true, nil},
		{"a mark of a tab that is not a thread's: gone", []string{"t-g"}, prev, prev, Result{}, true, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := TrackWindowTabs(tc.marked, tc.prev, tc.next, tc.res, tc.window); !slices.Equal(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

// The import closes the thread tabs an old window opened in each space where every thread tab
// is one of them, and then folds that space's automatic tabs as it always did; a space that
// also holds a thread tab opened on purpose is left as it is.
func TestImportLegacyClosesAnOldWindowsThreadTabs(t *testing.T) {
	doc := `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[
		{"id":"sp-a","name":"Main","focus":"p-1","root":{"t":"split","id":"s-1","dir":"row","sizes":[0.6,0.4],"kids":[
			{"t":"pane","id":"p-1","active":"t-w","tabs":[{"id":"t-w","kind":"thread","thread":"s-0"}]},
			{"t":"pane","id":"p-2","active":"t-d","tabs":[{"id":"t-d","kind":"diff","thread":"s-0","params":{"project":"web","worktree":"/wt/web"}}]}]}},
		{"id":"sp-b","name":"Review","focus":"p-3","root":{"t":"pane","id":"p-3","active":"t-v","tabs":[
			{"id":"t-v","kind":"thread","thread":"s-1"},{"id":"t-u","kind":"thread","thread":"s-2"}]}}],
		"threads":{"s-1":{"space":"sp-b"},"s-2":{"space":"sp-b"}}}`
	threads := []LegacyThread{{ID: "s-0"}, {ID: "s-1"}, {ID: "s-2"}}
	tests := []struct {
		name   string
		window []string
		mainSp string // the shape of sp-a after the import
		review string // of sp-b
		gone   []string
	}{
		{"no window tabs: both spaces arranged", nil,
			"row(p-1[thread:s-0]*thread:s-0:0.600000000, p-2[t-d]*t-d:0.400000000)", "p-3[thread:s-1 thread:s-2]*thread:s-1", nil},
		{"the window's tab in Main: Main empty, its diff remembered", []string{"t-w"},
			"-", "p-3[thread:s-1 thread:s-2]*thread:s-1", []string{"t-w"}},
		{"one of Review's two is the window's: Review left as it is", []string{"t-w", "t-u"},
			"-", "p-3[thread:s-1 thread:s-2]*thread:s-1", []string{"t-w"}},
		{"both of Review's are the window's: Review empty", []string{"t-v", "t-u"},
			"row(p-1[thread:s-0]*thread:s-0:0.600000000, p-2[t-d]*t-d:0.400000000)", "-", []string{"t-v", "t-u"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st, res, err := ImportLegacy(stateWith(t, doc), LegacyInput{Threads: threads, WindowTabs: tc.window}, &SeqIDs{})
			if err != nil {
				t.Fatal(err)
			}
			if got := layoutShape(st.Space("sp-a").Root); got != tc.mainSp {
				t.Errorf("Main: %s, want %s", got, tc.mainSp)
			}
			if got := layoutShape(st.Space("sp-b").Root); got != tc.review {
				t.Errorf("Review: %s, want %s", got, tc.review)
			}
			var removed []string
			for _, tb := range res.Removed {
				removed = append(removed, tb.ID)
			}
			if !slices.Equal(removed, tc.gone) {
				t.Errorf("removed %v, want %v", removed, tc.gone)
			}
			if slices.Contains(tc.window, "t-w") && remembered(st, "s-0") != "diff" {
				t.Errorf("s-0: %s, want its diff remembered", remembered(st, "s-0"))
			}
		})
	}
}
