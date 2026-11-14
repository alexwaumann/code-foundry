package layout

import (
	"errors"
	"slices"
	"testing"
)

// ringState is a thread th-a with its tab in p-a, a diff and two terminals in p-b, a third
// terminal in p-c (layout order: x, y, z), a free shell, and in another space th-a's
// terminal w (not in the ring: the ring is the thread's space).
const ringState = `{"v":1,"spaces":[
  {"id":"sp-a","name":"A","focus":"p-a","root":{"t":"split","id":"s-r","dir":"row","sizes":[0.4,0.3,0.3],"kids":[
    {"t":"pane","id":"p-a","active":"t-a","tabs":[{"id":"t-a","kind":"thread","thread":"th-a"},{"id":"t-f","kind":"terminal","params":{"terminal":"free"}}]},
    {"t":"pane","id":"p-b","active":"t-d","tabs":[
      {"id":"t-d","kind":"diff","thread":"th-a","params":{"project":"pj","worktree":"w"}},
      {"id":"t-x","kind":"terminal","thread":"th-a","params":{"terminal":"tx"}},
      {"id":"t-y","kind":"terminal","thread":"th-a","params":{"terminal":"ty"}}]},
    {"t":"pane","id":"p-c","active":"t-z","tabs":[{"id":"t-z","kind":"terminal","thread":"th-a","params":{"terminal":"tz"}}]}]}},
  {"id":"sp-b","name":"B","focus":"p-w","root":{"t":"pane","id":"p-w","active":"t-w","tabs":[
    {"id":"t-w","kind":"terminal","thread":"th-a","params":{"terminal":"tw"}},
    {"id":"t-q","kind":"terminal","thread":"th-q","params":{"terminal":"tq"}}]}}],
 "current_space":"sp-a","default_space":"sp-a"}`

func TestNextInRing(t *testing.T) {
	st, _, err := Decode([]byte(ringState), &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		from, want, thread string
		err                error
	}{
		{from: "t-a", want: "t-x", thread: "th-a"}, // the thread: the first terminal
		{from: "t-x", want: "t-y", thread: "th-a"},
		{from: "t-y", want: "t-z", thread: "th-a"}, // across panes, in layout order
		{from: "t-z", want: "t-a", thread: "th-a"}, // the last: back to the thread
		{from: "t-d", want: "t-x", thread: "th-a"}, // a view starts at the first terminal
		{from: "t-w", want: "t-x", thread: "th-a"}, // its terminal in another space joins at the start
		{from: "t-q", want: "", thread: "th-q"},    // no terminal in its space, its thread not open
		{from: "t-f", err: ErrFailedPrecondition},  // a free shell has no ring
		{from: "t-gone", err: ErrNotFound},
	} {
		got, err := NextInRing(st, tc.from)
		if tc.err != nil {
			if !errors.Is(err, tc.err) {
				t.Errorf("%s: err %v, want %v", tc.from, err, tc.err)
			}
			continue
		}
		if err != nil || got.Tab != tc.want || got.Thread != tc.thread {
			t.Errorf("%s: got %+v %v, want %s of %s", tc.from, got, err, tc.want, tc.thread)
		}
	}
}

// A thread with no terminal tab: the ring is the thread alone.
func TestNextInRingAlone(t *testing.T) {
	st := NewState("sp-a", "A")
	st.Spaces[0].Root = &Node{T: NodePane, ID: "p-a", Active: "t-a", Tabs: []*Tab{{ID: "t-a", Kind: "thread", Thread: "th-a", Key: "thread:th-a"}}}
	st.Spaces[0].Focus = "p-a"
	got, err := NextInRing(st, "t-a")
	if err != nil || got.Tab != "t-a" {
		t.Errorf("got %+v %v", got, err)
	}
}

func TestHeldTerminals(t *testing.T) {
	st, _, err := Decode([]byte(ringState), &SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	st.Threads = map[string]*ThreadState{"th-r": {Space: "sp-a", Remembered: &Remembered{Tabs: []RememberedTab{
		{Tab: &Tab{ID: "t-r", Kind: "terminal", Thread: "th-r", Params: map[string]string{"terminal": "tr"}}},
		{Tab: &Tab{ID: "t-s", Kind: "terminal", Thread: "th-r", Params: map[string]string{"terminal": "ts"}}, Fresh: &Fresh{}},
	}}}}
	want := []string{"free", "tq", "tr", "tw", "tx", "ty", "tz"}
	if got := HeldTerminals(st); !slices.Equal(got, want) {
		t.Errorf("held %v, want %v", got, want)
	}
	if !Holds(st, "tr") || Holds(st, "ts") || Holds(st, "nope") {
		t.Error("Holds: a running remembered terminal is held, a fresh one and an unknown one are not")
	}
}
