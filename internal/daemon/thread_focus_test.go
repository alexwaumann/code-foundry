package daemon

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

type gainedFocus chan string

func (g gainedFocus) FocusGained(id string) { g <- id }

// The glue tells the thread store each time a thread becomes the one the user looks
// at, and only then: a commit that leaves the focus where it was, or moves it to a tab
// that is not a thread's own, tells nothing.
func TestThreadFocus(t *testing.T) {
	b := bus.New()
	l := layouttest.New(b)
	got := make(gainedFocus, 16)
	stop := startThreadFocus(context.Background(), got, l, b)
	defer stop()

	// Two panes, s-1 in p-a and s-2 (with a diff of s-1 behind it) in p-b, a second space.
	state := func(focus, activeB, current string) *core.State {
		a := &core.Node{T: core.NodePane, ID: "p-a", Tabs: []*core.Tab{{ID: "t-1", Kind: "thread", Thread: "s-1"}}, Active: "t-1"}
		pb := &core.Node{T: core.NodePane, ID: "p-b", Tabs: []*core.Tab{{ID: "t-2", Kind: "thread", Thread: "s-2"}, {ID: "t-d", Kind: "diff", Thread: "s-1"}, {ID: "t-3", Kind: "thread", Thread: "s-3"}}, Active: activeB}
		root := &core.Node{T: core.NodeSplit, ID: "n-r", Dir: core.Row, Kids: []*core.Node{a, pb}, Sizes: []float64{0.5, 0.5}}
		return &core.State{V: core.Version, CurrentSpace: current, DefaultSpace: "sp-main", Spaces: []*core.Space{
			{ID: "sp-main", Name: "Main", Root: root, Focus: focus},
			{ID: "sp-two", Name: "Two", Root: &core.Node{T: core.NodePane, ID: "p-c"}, Focus: "p-c"},
		}}
	}
	for _, st := range []*core.State{
		state("p-a", "t-2", "sp-main"), // s-1 gains the focus
		state("p-a", "t-2", "sp-main"), // a commit that leaves it there
		state("p-b", "t-2", "sp-main"), // its pane: s-2
		state("p-b", "t-d", "sp-main"), // a diff in front: no thread
		state("p-b", "t-2", "sp-main"), // s-2's tab again: it gains it again
		state("p-b", "t-2", "sp-two"),  // another space
		state("p-b", "t-2", "sp-main"), // back: s-2
		state("p-b", "t-3", "sp-main"), // the end marker
	} {
		l.Put(st)
	}
	var calls []string
	for {
		select {
		case id := <-got:
			calls = append(calls, id)
		case <-time.After(5 * time.Second):
			t.Fatalf("no end marker; calls %v", calls)
		}
		if calls[len(calls)-1] == "s-3" {
			break
		}
	}
	if want := []string{"s-1", "s-2", "s-2", "s-2", "s-3"}; !slices.Equal(calls, want) {
		t.Errorf("FocusGained calls %v, want %v", calls, want)
	}
}
