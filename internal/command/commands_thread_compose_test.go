package command_test

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// thread.new --compose: the new thread's tab takes the place of the composer tab it was
// sent from, in that composer's space; a draft sent ends. A tab that is no composer is
// refused before any thread is made.
func TestThreadNewFromAComposer(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	store := layouttest.New(nil)
	store.Put(seeded())
	ctx := context.Background()
	// A draft in space Two: the user typed in a composer there.
	c, err := store.Apply(ctx, &core.NewThread{Space: "sp-two", Pane: "p-two"}, layoutstore.ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	compose := c.Result.Tab
	if _, err := store.Apply(ctx, &core.StartDraft{Tab: compose, Draft: "d-mine"}, layoutstore.ApplyOptions{}); err != nil {
		t.Fatal(err)
	}
	fromComposer := command.Context{ActiveView: "compose"}
	reg := command.NewRegistry()
	b := &commandtest.Thread{}
	if err := command.RegisterThreadLifecycle(reg, b, &commandtest.Emitter{}, command.WithLayout(store)); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Invoke(ctx, fromComposer, "thread.new", map[string]string{"no-project": "true", "compose": "t-prs"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Fatalf("a tab that is no composer: %v", err)
	}
	if n := len(b.Requests()); n != 0 {
		t.Fatalf("a thread was made anyway: %d calls", n)
	}
	res, err := reg.Invoke(ctx, fromComposer, "thread.new", map[string]string{"no-project": "true", "compose": compose})
	if err != nil {
		t.Fatal(err)
	}
	id := res.JSON.(*v1.Thread).GetId()
	st := store.Snapshot().State
	_, p, tb := st.FindTab(compose)
	if tb != nil {
		t.Errorf("the composer tab is still open in %s", p.ID)
	}
	if st.SpaceOf(id) != "sp-two" {
		t.Errorf("the thread lives in %s, want sp-two", st.SpaceOf(id))
	}
	sp := st.Space("sp-two")
	if _, p := st.FindPane("p-two"); p.ActiveTab() == nil || p.ActiveTab().Thread != id || st.CurrentSpace != "sp-two" || sp.Focus != "p-two" {
		t.Errorf("the thread's tab is not the focused one in the composer's place: %+v", p)
	}
	if len(sp.Drafts) != 0 {
		t.Errorf("the draft sent is still listed: %+v", sp.Drafts)
	}
}

// draftIn makes a draft composer tab in space Two (the user typed in a composer there) and
// returns its tab.
func draftIn(t *testing.T, store *layouttest.Fake, draft string) string {
	t.Helper()
	ctx := context.Background()
	c, err := store.Apply(ctx, &core.NewThread{Space: "sp-two", Pane: "p-two"}, layoutstore.ApplyOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, &core.StartDraft{Tab: c.Result.Tab, Draft: draft}, layoutstore.ApplyOptions{}); err != nil {
		t.Fatal(err)
	}
	return c.Result.Tab
}

// thread.new-like --compose ("New thread on this branch" sent from its composer tab): as
// thread.new's, the thread's tab takes the composer's place and the draft sent ends.
func TestThreadNewLikeFromAComposer(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	store := layouttest.New(nil)
	store.Put(seeded())
	ctx := context.Background()
	compose := draftIn(t, store, "d-like")
	reg := command.NewRegistry()
	b := &commandtest.Thread{}
	if err := command.RegisterThreadLifecycle(reg, b, &commandtest.Emitter{}, command.WithLayout(store)); err != nil {
		t.Fatal(err)
	}
	fromComposer := command.Context{ActiveView: "compose", ActiveThreadID: "s-aaaa00000001", ActiveProjectID: "pj-1"}
	if _, err := reg.Invoke(ctx, fromComposer, "thread.new-like", map[string]string{"compose": "t-prs"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Fatalf("a tab that is no composer: %v", err)
	}
	if n := len(b.Requests()); n != 0 {
		t.Fatalf("a thread was made anyway: %d calls", n)
	}
	res, err := reg.Invoke(ctx, fromComposer, "thread.new-like", map[string]string{"compose": compose})
	if err != nil {
		t.Fatal(err)
	}
	id := res.JSON.(*v1.Thread).GetId()
	st := store.Snapshot().State
	if _, p, tb := st.FindTab(compose); tb != nil {
		t.Errorf("the composer tab is still open in %s", p.ID)
	}
	if _, p := st.FindPane("p-two"); p.ActiveTab() == nil || p.ActiveTab().Thread != id {
		t.Errorf("the thread's tab is not in the composer's place: %+v", p)
	}
	if d := st.Space("sp-two").Drafts; len(d) != 0 {
		t.Errorf("the draft sent is still listed: %+v", d)
	}
}

// closingCompose is a thread backend whose Create closes a composer tab first: the user closed
// it while the thread was being made.
type closingCompose struct {
	*commandtest.Thread
	store *layouttest.Fake
	tab   string
}

func (c closingCompose) Create(ctx context.Context, r *connect.Request[v1.CreateThreadRequest]) (*connect.Response[v1.CreateThreadResponse], error) {
	if _, err := c.store.Apply(ctx, &core.CloseTab{Tab: c.tab}, layoutstore.ApplyOptions{}); err != nil {
		return nil, err
	}
	return c.Thread.Create(ctx, r)
}

// A composer tab closed while its thread was made: the send still succeeds (an error would have
// the GUI keep the draft, and sending it again would make a second thread), the thread's tab
// opens as a new thread's does, and nothing else is said.
func TestThreadNewWhoseComposerClosedMeanwhile(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	store := layouttest.New(nil)
	store.Put(seeded())
	ctx := context.Background()
	compose := draftIn(t, store, "d-gone")
	reg := command.NewRegistry()
	b := closingCompose{Thread: &commandtest.Thread{}, store: store, tab: compose}
	if err := command.RegisterThreadLifecycle(reg, b, &commandtest.Emitter{}, command.WithLayout(store)); err != nil {
		t.Fatal(err)
	}
	res, err := reg.Invoke(ctx, command.Context{ActiveView: "compose"}, "thread.new", map[string]string{"no-project": "true", "compose": compose})
	if err != nil {
		t.Fatalf("the send failed after its thread was made: %v", err)
	}
	if len(res.Warnings) != 0 {
		t.Errorf("warnings: %v", res.Warnings)
	}
	id := res.JSON.(*v1.Thread).GetId()
	if n := len(b.Requests()); n != 1 {
		t.Fatalf("threads made: %d", n)
	}
	found := false
	for _, sp := range store.Snapshot().State.Spaces {
		for _, p := range core.Panes(sp.Root) {
			for _, tb := range p.Tabs {
				found = found || (tb.Kind == "thread" && tb.Thread == id)
			}
		}
	}
	if !found {
		t.Errorf("the thread has no tab")
	}
}
