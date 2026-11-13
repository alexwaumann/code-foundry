package command_test

import (
	"context"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// A window from before the shell, open against the new daemon, runs terminal.quick on cmd+j:
// the thread's tab opens in a layout that window does not draw. The registry marks a window's
// calls, so the layout store keeps that tab apart and the first-load import closes it: the first
// load is one empty space. The same verbs from the CLI or a thread's model, or the CLI acting
// on the window's tab, arrange the space on purpose, and the import leaves it as it is
// (docs/notes/shell-24a-import-moves.md, item 3).
func TestImportAfterAnOldWindowsChord(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name  string
		uctx  command.Context
		focus bool                                    // --focus
		after func(t *testing.T, f termLayoutFixture) // what else ran before the import
		empty bool                                    // the space the import leaves is empty
	}{
		{name: "an old window's cmd+j", uctx: fromApp, empty: true},
		{name: "the CLI's terminal quick", uctx: fromCLI, empty: false},
		{name: "a thread's model, with --focus", uctx: fromThread, focus: true, empty: false},
		{name: "an old window's cmd+j, then the CLI focuses that tab", uctx: fromApp, empty: false,
			after: func(t *testing.T, f termLayoutFixture) {
				tab := core.Panes(f.state().Spaces[0].Root)[0].Tabs[0].ID
				if _, err := f.run(t, fromCLI, "tab.focus", map[string]string{"tab": tab}); err != nil {
					t.Fatal(err)
				}
			}},
		{name: "an old window's cmd+j, then the CLI opens another thread there", uctx: fromApp, empty: false,
			after: func(t *testing.T, f termLayoutFixture) {
				if _, err := f.store.Apply(ctx, &core.OpenThread{Thread: "s-bbbb00000002", Focus: true}, layoutApply()); err != nil {
					t.Fatal(err)
				}
			}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newTermLayoutFixture(t)
			if err := command.RegisterLayout(f.reg, command.LayoutDeps{Layout: f.store}); err != nil {
				t.Fatal(err)
			}
			f.store.Put(core.NewState("sp-a", "Main"))
			args := map[string]string{"id": threadA, "open": "true"}
			if tc.focus {
				args["focus"] = "true"
			}
			if _, err := f.run(t, tc.uctx, "terminal.quick", args); err != nil {
				t.Fatal(err)
			}
			if core.Panes(f.state().Spaces[0].Root) == nil {
				t.Fatal("terminal.quick opened no thread tab")
			}
			if tc.after != nil {
				tc.after(t, f)
			}
			c, err := f.store.ImportLegacy(ctx, core.LegacyInput{Threads: []core.LegacyThread{{ID: threadA}, {ID: "s-bbbb00000002"}}}, layoutApply())
			if err != nil {
				t.Fatal(err)
			}
			got := f.state().Spaces[0].Root == nil
			if got != tc.empty {
				t.Errorf("space empty after the import: %v, want %v (removed %d)", got, tc.empty, len(c.Result.Removed))
			}
			if q := f.state().Threads[threadA]; q == nil || q.Quick == nil || !q.Quick.Open {
				t.Errorf("the quick terminal's state was lost: %+v", q)
			}
		})
	}
}
