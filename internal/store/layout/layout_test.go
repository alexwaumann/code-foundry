package layout

import (
	"encoding/json"
	"reflect"
	"testing"

	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// state decodes a whole state in the JSON form of internal/layout's test cases.
func state(t *testing.T, js string) *core.State {
	t.Helper()
	st, _, err := core.Decode([]byte(js), &core.SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	return st
}

const twoSpaces = `{"v":1,"current_space":"sp-a","default_space":"sp-a",
	"spaces":[
		{"id":"sp-a","name":"A","root":{"t":"split","id":"s-1","dir":"row","sizes":[0.5,0.5],"kids":[
			{"t":"pane","id":"p-1","tabs":[{"id":"t-1","kind":"prs"},{"id":"t-2","kind":"projects"}],"active":"t-1"},
			{"t":"pane","id":"p-2","tabs":[{"id":"t-3","kind":"file","params":{"path":"/a"}}],"active":"t-3"}]},
		 "focus":"p-1","mru":["t-1","t-3"]},
		{"id":"sp-b","name":"B","root":null}],
	"threads":{"s-1":{"space":"sp-b"},"s-2":{"space":"sp-a","quick":{"open":true}}}}`

func TestDiffFocusOnlyUnchanged(t *testing.T) {
	tests := []struct {
		name   string
		change func(st *core.State)
		// want: the delta's spaces and threads by id, the removed ones, focus only
		spaces, removedSpaces, threads, removedThreads []string
		focusOnly, unchanged                           bool
	}{
		{name: "nothing", unchanged: true, focusOnly: true},
		{name: "active tab", change: func(st *core.State) { core.Panes(st.Spaces[0].Root)[0].Active = "t-2" },
			spaces: []string{"sp-a"}, focusOnly: true},
		{name: "focus and mru", change: func(st *core.State) { st.Spaces[0].Focus, st.Spaces[0].MRU = "p-2", []string{"t-3", "t-1"} },
			spaces: []string{"sp-a"}, focusOnly: true},
		{name: "current space", change: func(st *core.State) { st.CurrentSpace = "sp-b" }, focusOnly: true},
		{name: "sizes", change: func(st *core.State) { st.Spaces[0].Root.Sizes = []float64{0.3, 0.7} }, spaces: []string{"sp-a"}},
		{name: "tab title", change: func(st *core.State) { core.Panes(st.Spaces[0].Root)[1].Tabs[0].Title = "a" }, spaces: []string{"sp-a"}},
		{name: "space name", change: func(st *core.State) { st.Spaces[1].Name = "Bee" }, spaces: []string{"sp-b"}},
		{name: "order", change: func(st *core.State) { st.Spaces[0], st.Spaces[1] = st.Spaces[1], st.Spaces[0] }},
		{name: "space removed", change: func(st *core.State) { st.Spaces = st.Spaces[:1] }, removedSpaces: []string{"sp-b"}},
		{name: "default space", change: func(st *core.State) { st.DefaultSpace = "sp-b" }},
		{name: "thread changed and added", change: func(st *core.State) {
			st.Threads["s-1"].Space = "sp-a"
			st.Threads["s-3"] = &core.ThreadState{Space: "sp-b"}
		}, threads: []string{"s-1", "s-3"}},
		{name: "thread removed", change: func(st *core.State) { delete(st.Threads, "s-2") }, removedThreads: []string{"s-2"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			prev := state(t, twoSpaces)
			next := prev.Clone()
			if tt.change != nil {
				tt.change(next)
			}
			d := Diff(prev, next)
			var spaces, threads []string
			for _, sp := range d.Spaces {
				spaces = append(spaces, sp.ID)
			}
			for _, e := range d.Threads {
				threads = append(threads, e.ID)
			}
			order := []string{}
			for _, sp := range next.Spaces {
				order = append(order, sp.ID)
			}
			for _, c := range []struct {
				what      string
				got, want []string
			}{
				{"spaces", spaces, tt.spaces}, {"removed spaces", d.RemovedSpaces, tt.removedSpaces},
				{"threads", threads, tt.threads}, {"removed threads", d.RemovedThreads, tt.removedThreads},
				{"order", d.Order, order},
			} {
				if len(c.got) != 0 || len(c.want) != 0 {
					if !reflect.DeepEqual(c.got, c.want) {
						t.Errorf("%s %v; want %v", c.what, c.got, c.want)
					}
				}
			}
			if d.CurrentSpace != next.CurrentSpace || d.DefaultSpace != next.DefaultSpace {
				t.Errorf("delta current %q default %q", d.CurrentSpace, d.DefaultSpace)
			}
			if got := FocusOnly(prev, next); got != tt.focusOnly {
				t.Errorf("FocusOnly %v; want %v", got, tt.focusOnly)
			}
			if got := Unchanged(prev, next); got != tt.unchanged {
				t.Errorf("Unchanged %v; want %v", got, tt.unchanged)
			}
		})
	}
}

// A nil and an empty thread map are the same layout.
func TestUnchangedThreadsNilOrEmpty(t *testing.T) {
	a := core.NewState("sp-a", "A")
	b := a.Clone()
	b.Threads = map[string]*core.ThreadState{}
	if !Unchanged(a, b) {
		t.Error("nil and empty thread maps differ")
	}
	if js, _ := json.Marshal(Diff(a, b)); len(Diff(a, b).Threads) != 0 {
		t.Errorf("delta %s", js)
	}
}
