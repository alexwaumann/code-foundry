package layout

import "testing"

// A remembered set placed fresh (the thread opens in another pane than the one it was in, or
// the set has no pane, as an imported one) shows, in each pane it lands in, the tab that was
// active when the set was remembered; with none, the first tab that landed there. Placing one
// tab at a time used to leave the last one active in a pane that already existed and the
// first in a new pane (docs/notes/shell-24a-import-moves.md, item 2).
func TestRestoreShowsTheRememberedActiveTab(t *testing.T) {
	// rec is a remembered file tab of th-a with no pane (placed fresh).
	rec := func(id string, active bool) string {
		a := ""
		if active {
			a = `,"active":true`
		}
		return `{"tab":{"id":"` + id + `","kind":"file","thread":"th-a","params":{"path":"/r/` + id + `"}},"pane":"","index":0` + a + `}`
	}
	// emptySpace: the thread opens alone and its set gets a new pane (rule 5).
	emptySpace := func(recs string) string {
		return `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[{"id":"sp-a","name":"A"}],
			"threads":{"th-a":{"space":"sp-a","remembered":{"pane":"","tabs":[` + recs + `]}}}}`
	}
	// besideOther: the space already has another thread's tab and a pane of its linked tabs,
	// so the set joins that pane (rule 4), which already exists.
	besideOther := func(recs string) string {
		return `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[{"id":"sp-a","name":"A","focus":"p-1",
			"root":{"t":"split","id":"s-1","dir":"row","sizes":[0.6,0.4],"kids":[
				{"t":"pane","id":"p-1","active":"t-b","tabs":[{"id":"t-b","kind":"thread","thread":"th-b"}]},
				{"t":"pane","id":"p-2","active":"t-o","tabs":[{"id":"t-o","kind":"file","thread":"th-b","params":{"path":"/r/o"}}]}]}}],
			"threads":{"th-a":{"space":"sp-a","remembered":{"pane":"","tabs":[` + recs + `]}}}}`
	}
	tests := []struct {
		name  string
		state string
		pane  string // the pane the set lands in
		want  string // its active tab
	}{
		{"new pane, the middle tab was active", emptySpace(rec("t-1", false) + "," + rec("t-2", true) + "," + rec("t-3", false)), "", "t-2"},
		{"new pane, none was active: the first", emptySpace(rec("t-1", false) + "," + rec("t-2", false)), "", "t-1"},
		{"new pane, the last was active", emptySpace(rec("t-1", false) + "," + rec("t-2", false) + "," + rec("t-3", true)), "", "t-3"},
		{"existing pane, the first was active", besideOther(rec("t-1", true) + "," + rec("t-2", false) + "," + rec("t-3", false)), "p-2", "t-1"},
		{"existing pane, the middle was active", besideOther(rec("t-1", false) + "," + rec("t-2", true) + "," + rec("t-3", false)), "p-2", "t-2"},
		{"existing pane, none was active: the first restored", besideOther(rec("t-1", false) + "," + rec("t-2", false)), "p-2", "t-1"},
		{"two were active (two old panes): the first of them", besideOther(rec("t-1", false) + "," + rec("t-2", true) + "," + rec("t-3", true)), "p-2", "t-2"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st := stateWith(t, tc.state)
			for _, focus := range []bool{true, false} {
				got, res, err := Apply(st, &OpenThread{Thread: "th-a", Focus: focus}, &SeqIDs{})
				if err != nil {
					t.Fatal(err)
				}
				pane := tc.pane
				if pane == "" {
					_, p, _ := got.FindTab(res.Placed[0])
					pane = p.ID
				}
				_, p := got.FindPane(pane)
				if p == nil || p.Active != tc.want {
					t.Errorf("focus %v: %s", focus, layoutShape(got.Spaces[0].Root))
				}
			}
		})
	}
}

// The pane the user is in keeps its tab: a restored tab that lands there (rule 6, no room
// beside the thread) waits behind it, even when it was the active one.
func TestRestoreKeepsTheUsersPane(t *testing.T) {
	st := stateWith(t, `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[{"id":"sp-a","name":"A","focus":"p-1",
		"root":{"t":"pane","id":"p-1","active":"t-g","tabs":[{"id":"t-g","kind":"projects"}]}}],
		"threads":{"th-a":{"space":"sp-a","remembered":{"pane":"","tabs":[
			{"tab":{"id":"t-1","kind":"file","thread":"th-a","params":{"path":"/r/1"}},"pane":"","index":0,"active":true}]}}}}`)
	// 700 px wide: no room for a pane beside the thread, so the file joins the thread's pane.
	got, _, err := Apply(st, &OpenThread{Thread: "th-a", W: 700, H: 600}, &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	if s := layoutShape(got.Spaces[0].Root); s != "p-1[t-g thread:th-a t-1]*t-g" {
		t.Errorf("%s: want the user's tab still shown", s)
	}
}
