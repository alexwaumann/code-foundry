package plugin_test

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// A show command given --pane (a pane's "+" menu) opens the surface's tab in that pane: a
// thread's surface linked to the thread, a global one unlinked (the space's one tab of it),
// and sends no intent. A second call finds the open tab where it is.
func TestShowCommandOpensInThePaneGiven(t *testing.T) {
	store := layouttest.New(nil)
	store.Put(stateOf(t, `{"v":1,"current_space":"sp-a","default_space":"sp-a","spaces":[{"id":"sp-a","name":"Main","focus":"p-1",
		"root":{"t":"split","id":"s-r","dir":"row","sizes":[0.5,0.5],"kids":[
			{"t":"pane","id":"p-1","active":"t-1","tabs":[{"id":"t-1","kind":"thread","thread":"s-1"}]},
			{"t":"pane","id":"p-2","active":"t-g","tabs":[{"id":"t-g","kind":"projects"}]}]}}]}`))
	e := newSurfEnv(t, func(o *plugin.Options) { o.Tabs = tabsOver{store} })
	user := command.Context{ActiveView: "thread", ActiveThreadID: "s-1"}
	tests := []struct {
		name     string
		verb     string
		thread   string
		existing bool
	}{
		{name: "a thread's surface: linked, in the pane", verb: "plugin.surf.show.panel", thread: "s-1"},
		{name: "a global surface: unlinked, in the pane", verb: "plugin.surf.show.silent"},
		{name: "again: found where it is", verb: "plugin.surf.show.silent", existing: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			before := len(e.emit.Intents())
			res, err := e.invoke(tc.verb, map[string]string{"pane": "p-2"}, user)
			if err != nil {
				t.Fatal(err)
			}
			out := res.JSON.(plugin.ShowResult)
			_, p, tb := store.Snapshot().State.FindTab(out.Tab)
			if tb == nil || p.ID != "p-2" || tb.Thread != tc.thread || out.Existing != tc.existing {
				t.Fatalf("tab %+v in %v, result %+v", tb, p, out)
			}
			if len(e.emit.Intents()) != before {
				t.Errorf("an intent was sent: %v", e.emit.Intents()[before:])
			}
		})
	}
}
