package command_test

import (
	"fmt"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.space.move given ids (the sidebar's bulk Move to space ▸ and a selection dropped on
// a space tab): each thread moves in order, past one that fails, and the answer carries the
// rev of the last move for the window to wait on.
func TestThreadSpaceMoveIDs(t *testing.T) {
	const a, b, c = "s-aaaa00000001", "s-bbbb00000002", "s-cccc00000003"
	tests := []struct {
		name     string
		ctx      command.Context
		before   []string // threads moved to Two first, one at a time
		args     map[string]string
		wantMsg  string
		wantExit int
		wantDone []string
		wantFail []string
		wantTwo  []string // threads living in Two after
	}{
		{name: "an open thread and a closed one move", ctx: fromApp, args: map[string]string{"ids": a + "," + b, "space": "Two"},
			wantDone: []string{a, b}, wantTwo: []string{a, b}},
		{name: "the CLI's message names the space", ctx: fromCLI, args: map[string]string{"ids": b + "," + c, "space": "Two"},
			wantMsg:  "moved 2 threads to space sp-two \"Two\": " + b + ", " + c,
			wantDone: []string{b, c}, wantTwo: []string{b, c}},
		{name: "one already there fails, the rest move", ctx: fromCLI, before: []string{b}, args: map[string]string{"ids": a + "," + b + "," + c, "space": "sp-two"},
			wantExit: 1, wantDone: []string{a, c}, wantFail: []string{b}, wantTwo: []string{a, b, c}},
		// ids are explicit, so a thread's CLI may move them (without the user's focus).
		{name: "from inside a thread", ctx: fromThread, args: map[string]string{"ids": b, "space": "Two"},
			wantDone: []string{b}, wantTwo: []string{b}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t)
			for _, id := range tt.before {
				f.must(t, fromCLI, "thread.space.move", map[string]string{"id": id, "space": "Two"})
			}
			res := f.must(t, tt.ctx, "thread.space.move", tt.args)
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if res.ExitCode != tt.wantExit {
				t.Errorf("exit = %d, want %d (%s)", res.ExitCode, tt.wantExit, res.Message)
			}
			out, ok := res.JSON.(command.SpaceMoveResult)
			if !ok {
				t.Fatalf("JSON = %T", res.JSON)
			}
			var failed []string
			for _, x := range out.Failed {
				failed = append(failed, x.ID)
			}
			if fmt.Sprint(out.Done) != fmt.Sprint(tt.wantDone) || fmt.Sprint(failed) != fmt.Sprint(tt.wantFail) {
				t.Errorf("done %v failed %v, want %v and %v", out.Done, failed, tt.wantDone, tt.wantFail)
			}
			if out.Rev != f.store.Snapshot().Rev || !out.Changed {
				t.Errorf("rev %d changed %v, want the store's %d", out.Rev, out.Changed, f.store.Snapshot().Rev)
			}
			st := f.state()
			for _, id := range tt.wantTwo {
				if got := st.SpaceOf(id); got != "sp-two" {
					t.Errorf("%s lives in %q, want sp-two", id, got)
				}
			}
			if st.CurrentSpace != "sp-main" {
				t.Errorf("current space %s: the window stays in its space", st.CurrentSpace)
			}
		})
	}
}
