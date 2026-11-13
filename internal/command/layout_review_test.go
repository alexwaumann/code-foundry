package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// Rules from the review of the shell (docs/notes/shell-review-fixes-daemon.md).

// An archived thread lives in no space: opened from a space that is not the default one, its
// tab opens there and the window stays in that space. A thread with no record that is not
// archived lives in the default space, as before.
func TestThreadOpenArchivedOpensInTheCurrentSpace(t *testing.T) {
	f := newLayoutFixture(t)
	f.thread.Others = []*v1.Thread{
		{Id: "s-arch00000001", ArchivedAt: timestamppb.Now()},
		{Id: "s-live00000002"},
	}
	f.must(t, fromApp, "space.switch", map[string]string{"space": "Two"})
	res := f.must(t, fromApp, "thread.open", map[string]string{"id": "s-arch00000001"}).JSON.(command.LayoutResult)
	if st := f.state(); res.Space != "sp-two" || st.CurrentSpace != "sp-two" || st.SpaceOf("s-arch00000001") != "sp-two" {
		t.Fatalf("archived thread opened in %s, current %s, lives in %s; want all sp-two", res.Space, st.CurrentSpace, st.SpaceOf("s-arch00000001"))
	}
	f.must(t, fromApp, "thread.open", map[string]string{"id": "s-live00000002"})
	if st := f.state(); st.SpaceOf("s-live00000002") != "sp-main" || st.CurrentSpace != "sp-main" {
		t.Fatalf("a live thread with no record: lives in %s, current %s; want the default space", st.SpaceOf("s-live00000002"), st.CurrentSpace)
	}
}

// A sidebar row dropped on the grid is one thread.open with the place: a place in a strip, a
// new pane on a pane's edge, or a new pane on the grid's outer edge. Each is one commit.
func TestThreadOpenAtADropPlace(t *testing.T) {
	tests := []struct {
		name  string
		args  map[string]string
		check func(t *testing.T, st *core.State, tab string)
		err   string
	}{
		{name: "a place in a strip", args: map[string]string{"pane": "p-left", "index": "0"}, check: func(t *testing.T, st *core.State, tab string) {
			if _, p := st.FindPane("p-left"); p.Tabs[0].ID != tab {
				t.Errorf("p-left %v; want the thread first", p.Tabs)
			}
		}},
		{name: "a pane's edge", args: map[string]string{"split": "p-right", "edge": "bottom"}, check: func(t *testing.T, st *core.State, tab string) {
			_, p, _ := st.FindTab(tab)
			if p.ID == "p-right" || p.ID == "p-left" || len(p.Tabs) != 1 {
				t.Errorf("the thread is in %s with %v; want a new pane of its own", p.ID, p.Tabs)
			}
		}},
		{name: "the outer edge", args: map[string]string{"outer": "left"}, check: func(t *testing.T, st *core.State, tab string) {
			root := st.Space("sp-main").Root
			if root.T != core.NodeSplit || root.Kids[0].T != core.NodePane || root.Kids[0].Tabs[0].ID != tab {
				t.Errorf("root %+v; want the thread's new pane first in the row", root)
			}
		}},
		{name: "an index without a pane", args: map[string]string{"index": "1"}, err: "--index"},
		{name: "an edge without --split", args: map[string]string{"pane": "p-left", "edge": "left"}, err: "--edge goes with --split"},
		{name: "--split without an edge", args: map[string]string{"split": "p-left"}, err: "--split needs --edge"},
		{name: "two places", args: map[string]string{"pane": "p-left", "outer": "left"}, err: "give one of"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newLayoutFixture(t)
			args := map[string]string{"id": "s-new000000003"}
			for k, v := range tt.args {
				args[k] = v
			}
			rev := f.store.Snapshot().Rev
			res, err := f.run(t, fromApp, "thread.open", args)
			if tt.err != "" {
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.err) {
					t.Fatalf("err %v; want an invalid argument naming %q", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := f.store.Snapshot().Rev; got != rev+1 {
				t.Errorf("%d commits; want one", got-rev)
			}
			tab := res.JSON.(command.LayoutResult).Tab
			if f.focus() != "sp-main/"+paneOfTab(f.state(), tab)+"/"+tab {
				t.Errorf("focus %s; want the new tab %s", f.focus(), tab)
			}
			tt.check(t, f.state(), tab)
		})
	}
}

// Drafts are the user's text: a thread's model can read their ids (layout show) but cannot
// discard or clear one, and a page's call asks the user first. The window, the user's CLI and
// a plugin end one as before.
func TestDraftsAreTheUsers(t *testing.T) {
	for _, verb := range []string{"composer.draft.discard", "composer.draft.clear"} {
		t.Run(verb, func(t *testing.T) {
			f := newLayoutFixture(t)
			draft := func() string {
				tab := f.must(t, fromApp, "composer.new", nil).JSON.(command.LayoutResult).Tab
				return f.must(t, fromApp, "composer.draft.start", map[string]string{"tab": tab, "label": "Fix the login"}).JSON.(command.LayoutResult).Draft
			}
			drafts := func() int { return len(f.state().Space("sp-main").Drafts) }
			d := draft()
			if out, err := json.Marshal(f.must(t, fromThread, "layout.show", nil).JSON); err != nil || !strings.Contains(string(out), d) {
				t.Errorf("layout show --json from a thread does not list draft %s (%v):\n%s", d, err, out)
			}
			_, err := f.run(t, fromThread, verb, map[string]string{"draft": d})
			var fe *command.FailedError
			if !errors.As(err, &fe) || !strings.Contains(err.Error(), "the user's") || drafts() != 1 {
				t.Fatalf("from a thread: %v, %d drafts; want a refusal and the draft kept", err, drafts())
			}
			_, err = f.run(t, fromPage, verb, map[string]string{"draft": d})
			var ce *command.ConfirmError
			if !errors.As(err, &ce) || !strings.Contains(ce.Message, `"Fix the login"`) || drafts() != 1 {
				t.Fatalf("from a page: %v, %d drafts; want the user asked, naming the draft", err, drafts())
			}
			f.must(t, fromPage, verb, map[string]string{"draft": d}, command.Confirmed(true))
			if drafts() != 0 {
				t.Fatal("the page's call the user allowed did not end the draft")
			}
			for _, uctx := range []command.Context{fromApp, fromCLI, {Origin: command.OriginPlugin}} {
				d := draft()
				f.must(t, uctx, verb, map[string]string{"draft": d})
				if drafts() != 0 {
					t.Fatalf("%+v did not end the draft", uctx)
				}
			}
		})
	}
}

// terminal.reset starts the old terminal's argv again: from a page, a terminal started with
// a command line of its own asks as terminal.new --argv does; a plain shell's reset does not.
func TestTerminalResetFromAPage(t *testing.T) {
	t.Setenv("SHELL", "/bin/zsh")
	for _, tt := range []struct {
		name string
		argv []string
		uctx command.Context
		asks bool
	}{
		{"a page resets a plain shell", []string{"/bin/zsh", "-l"}, fromPage, false},
		{"a page resets a custom command line", []string{"node", "server.js", "--port", "3000"}, fromPage, true},
		{"the window resets a custom command line", []string{"node", "server.js"}, fromApp, false},
		{"a thread resets a custom command line", []string{"node", "server.js"}, fromThread, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			term := &commandtest.Terminal{Terminals: []*v1.Terminal{{Id: "t-old", Argv: tt.argv, Cwd: "/w",
				State: v1.TerminalState_TERMINAL_STATE_RUNNING, Labels: termlabel.Free()}}}
			reg := command.NewRegistry()
			if err := command.RegisterTerminal(reg, command.TerminalDeps{Terminal: term, Project: &commandtest.Project{}, Thread: &commandtest.Thread{}}); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(context.Background(), tt.uctx, "terminal.reset", map[string]string{"id": "t-old"})
			var ce *command.ConfirmError
			if asked := errors.As(err, &ce); asked != tt.asks {
				t.Fatalf("asked %v (%v); want %v", asked, err, tt.asks)
			}
			if !tt.asks {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !strings.Contains(ce.Message, `"node" "server.js" "--port" "3000"`) {
				t.Errorf("the question does not show the command line:\n%s", ce.Message)
			}
			if len(creates(term.Requests())) != 0 {
				t.Fatal("it started the command line before the user answered")
			}
			if _, err := reg.Invoke(context.Background(), tt.uctx, "terminal.reset", map[string]string{"id": "t-old"}, command.Confirmed(true)); err != nil {
				t.Fatal(err)
			}
			if c := creates(term.Requests()); len(c) != 1 || !slices.Equal(c[0].GetArgv(), tt.argv) {
				t.Errorf("created %v; want the old argv once allowed", c)
			}
		})
	}
}

// space.remove --archive archives what the space's sidebar lists: the user's threads and a
// thread's child whose creator no longer exists. A child whose creator exists goes with its
// creator (the thread store's cascade), as before.
func TestSpaceRemoveArchivesTheSidebarsThreads(t *testing.T) {
	f := newLayoutFixture(t)
	f.thread.Others = []*v1.Thread{
		{Id: "s-aaaa00000001"},
		{Id: "s-orph00000002", CreatedBy: "s-gone00000009"},
		{Id: "s-kid000000003", CreatedBy: "s-aaaa00000001"},
		{Id: "s-arch00000004", ArchivedAt: timestamppb.Now()},
	}
	_, err := f.run(t, fromCLI, "space.remove", map[string]string{"space": "Main", "archive": "true"})
	var ce *command.ConfirmError
	if !errors.As(err, &ce) || !strings.Contains(ce.Message, "its 2 threads are archived") {
		t.Fatalf("question: %v", err)
	}
	f.must(t, fromCLI, "space.remove", map[string]string{"space": "Main", "archive": "true"}, command.Confirmed(true))
	var archived []string
	for _, r := range f.thread.Requests() {
		if a, ok := r.(*v1.ArchiveThreadRequest); ok {
			archived = append(archived, a.GetId())
		}
	}
	slices.Sort(archived)
	if !slices.Equal(archived, []string{"s-aaaa00000001", "s-orph00000002"}) {
		t.Errorf("archived %v; want the user's thread and the orphaned child", archived)
	}
}
