package plugin_test

import (
	"context"
	"errors"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// tabsOver is plugin.TabOpener over a layout store, as the daemon's (plugin_tabs.go).
type tabsOver struct{ store layoutstore.Store }

func (o tabsOver) OpenTab(ctx context.Context, tb *core.Tab, focus bool) (core.Result, error) {
	c, err := o.store.Apply(ctx, &core.OpenSurface{Tab: tb, Focus: focus}, layoutstore.ApplyOptions{KeepFocus: !focus})
	return c.Result, err
}

// A thread or pull request surface's show command, with a layout, opens the surface as a tab
// linked to the thread, placed by the rules beside it like the view.open verbs, and sends no
// intent. One tab per surface and thread: a second call finds it, another thread gets its own.
// The user's own call takes the focus; a thread's model, a page or a plugin never does
// without --focus. A surface of another scope still goes to the windows as an intent
// (docs/notes/shell-24a-import-moves.md, item 5).
func TestShowCommandOpensALinkedTab(t *testing.T) {
	store := layouttest.New(nil)
	// Thread s-1's tab is open beside the Projects page; s-2's is open too.
	store.Put(stateOf(t, `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[{"id":"sp-a","name":"Main","focus":"p-1",
		"root":{"t":"split","id":"s-r","dir":"row","sizes":[0.5,0.5],"kids":[
			{"t":"pane","id":"p-1","active":"t-1","tabs":[{"id":"t-1","kind":"thread","thread":"s-1"},{"id":"t-2","kind":"thread","thread":"s-2"}]},
			{"t":"pane","id":"p-2","active":"t-g","tabs":[{"id":"t-g","kind":"projects"}]}]}}]}`))
	e := newSurfEnv(t, func(o *plugin.Options) { o.Tabs = tabsOver{store} })
	focused := func() string {
		st := store.Snapshot().State
		for _, p := range core.Panes(st.Spaces[0].Root) {
			if p.ID == st.Spaces[0].Focus {
				return p.Active
			}
		}
		return ""
	}
	fromThread := command.Context{Origin: command.OriginCLI, ActiveThreadID: "s-1"}
	tests := []struct {
		name     string
		verb     string
		args     map[string]string
		uctx     command.Context
		thread   string // the tab's thread
		existing bool
		focus    bool
		asks     bool // the user is asked first, and nothing opens until they answer
	}{
		{name: "a thread's model: beside it, the user's focus stays", verb: "plugin.surf.show.panel", uctx: fromThread, thread: "s-1"},
		{name: "again: the same tab", verb: "plugin.surf.show.panel", uctx: fromThread, thread: "s-1", existing: true},
		{name: "a plugin, for another thread: its own tab", verb: "plugin.surf.show.panel", uctx: command.Context{Origin: command.OriginPlugin, ActiveThreadID: "s-2"}, thread: "s-2"},
		{name: "a page: asked first (a plugin's verb)", verb: "plugin.surf.show.panel", uctx: command.Context{Origin: command.OriginPage, ActiveThreadID: "s-1"}, asks: true},
		{name: "the model with --focus", verb: "plugin.surf.show.panel", args: map[string]string{"focus": "true"}, uctx: fromThread, thread: "s-1", existing: true, focus: true},
		{name: "the app: focused", verb: "plugin.surf.show.panel", uctx: command.Context{ActiveView: "thread", ActiveThreadID: "s-2"}, thread: "s-2", existing: true, focus: true},
		{name: "a pull request surface is the thread's too", verb: "plugin.surf.show.checks", uctx: fromThread, thread: "s-1"},
	}
	// s-1's pull request has a GitHub Actions check, which the checks surface asks for.
	e.facts.mu.Lock()
	e.facts.checks = []plugin.CheckRun{{Name: "test", App: "github-actions"}}
	close(e.facts.release)
	e.facts.mu.Unlock()
	e.waitAvailable("plugin.surf.show.checks", fromThread, true)
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			before := len(e.emit.Intents())
			focusBefore := focused()
			rev := store.Snapshot().Rev
			res, err := e.invoke(tc.verb, tc.args, tc.uctx)
			if tc.asks {
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || store.Snapshot().Rev != rev {
					t.Fatalf("%v, rev %d -> %d: want a question and nothing opened", err, rev, store.Snapshot().Rev)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			out := res.JSON.(plugin.ShowResult)
			_, _, tb := store.Snapshot().State.FindTab(out.Tab)
			if tb == nil || tb.Thread != tc.thread || tb.Kind == "" || len(tb.Params) != 0 || out.Existing != tc.existing {
				t.Fatalf("tab %+v, result %+v", tb, out)
			}
			if tb.Key != "plugin:surf/"+tb.Kind[len("plugin.surf."):]+"/thread:"+tc.thread {
				t.Errorf("key %s", tb.Key)
			}
			if got := focused() == out.Tab; got != tc.focus {
				t.Errorf("focused %v (before %s, now %s), want %v", got, focusBefore, focused(), tc.focus)
			}
			if !tc.focus && focused() != focusBefore {
				t.Errorf("the user's focus moved from %s to %s", focusBefore, focused())
			}
			if len(e.emit.Intents()) != before {
				t.Errorf("an intent was sent: %v", e.emit.Intents()[before:])
			}
		})
	}
	// Two threads, one surface: two tabs in the space.
	n := 0
	for _, p := range core.Panes(store.Snapshot().State.Spaces[0].Root) {
		for _, tb := range p.Tabs {
			if tb.Kind == "plugin.surf.panel" {
				n++
			}
		}
	}
	if n != 2 {
		t.Errorf("%d panel tabs, want one per thread", n)
	}
	// A global surface is no thread's: its show still asks the windows.
	before := len(e.emit.Intents())
	if _, err := e.invoke("plugin.surf.show.silent", nil, fromThread); err != nil {
		t.Fatal(err)
	}
	if in := e.emit.Intents(); len(in) != before+1 || in[len(in)-1].GetShowView().GetName() != "panel.plugin.surf.silent" {
		t.Errorf("intents %v", in[before:])
	}
}

func stateOf(t *testing.T, doc string) *core.State {
	t.Helper()
	st, _, err := core.Decode([]byte(doc), &core.SeqIDs{})
	if err != nil {
		t.Fatal(err)
	}
	return st
}
