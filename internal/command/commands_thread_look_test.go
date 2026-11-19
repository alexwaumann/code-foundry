package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/command"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// looks returns the notifications under thread id's look key, every state.
func looks(s *notificationtest.Store, id string) []notification.Notification {
	var out []notification.Notification
	for _, n := range s.List(true) {
		if n.Source == notification.SourceCommand && n.Key == notification.LookKey(id) {
			out = append(out, n)
		}
	}
	return out
}

// The request is one notification per thread, warning and time-sensitive, naming the
// thread; a second post replaces the first in place; withdraw takes it back.
func TestThreadLookOnePerThread(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{Threads: []string{"s-1", "s-2"}})
	r := command.NewRegistry()
	if err := command.RegisterThreadLook(r, command.ThreadLookDeps{Notes: s}); err != nil {
		t.Fatal(err)
	}
	in := func(id string) command.Context { return command.Context{ActiveThreadID: id} }
	look := func(id string, args map[string]string) command.Result {
		t.Helper()
		res, err := r.Invoke(ctx, in(id), "thread.look", args)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	res := look("s-1", map[string]string{"title": "Review the plan", "body": "Before the workers start"})
	v := res.JSON.(command.ThreadLookView)
	if !v.Posted || v.Outcome != string(notification.OutcomePosted) || !strings.HasPrefix(res.Message, "asked the user to look") {
		t.Fatalf("first post = %+v, %q", v, res.Message)
	}
	got := looks(s, "s-1")
	if len(got) != 1 {
		t.Fatalf("look notifications = %d, want 1", len(got))
	}
	first := got[0]
	if first.Level != notification.LevelWarning || !first.TimeSensitive || first.ThreadID != "s-1" ||
		first.Title != "Review the plan" || first.Body != "Before the workers start" || first.Status() != notification.StatusShown {
		t.Fatalf("notification = %+v", first)
	}

	s.Clock.Advance(time.Minute)
	res = look("s-1", map[string]string{"title": "Pick a name"})
	if v := res.JSON.(command.ThreadLookView); v.Outcome != string(notification.OutcomeUpdated) {
		t.Fatalf("second post outcome = %q (%s)", v.Outcome, res.Message)
	}
	got = looks(s, "s-1")
	if len(got) != 1 || got[0].ID != first.ID || got[0].Title != "Pick a name" || got[0].Body != "" ||
		!got[0].UpdatedAt.After(first.UpdatedAt) || got[0].Status() != notification.StatusShown {
		t.Fatalf("after the second post: %+v", got)
	}
	if n := len(s.Snapshot().Notifications); n != 1 {
		t.Fatalf("bell holds %d, want 1", n)
	}
	// The same words again change nothing.
	if res := look("s-1", map[string]string{"title": "Pick a name"}); res.JSON.(command.ThreadLookView).Outcome != string(notification.OutcomeUnchanged) {
		t.Fatalf("same words: %s", res.Message)
	}

	// Another thread has its own.
	look("s-2", map[string]string{"title": "Look"})
	if n := len(s.Snapshot().Notifications); n != 2 {
		t.Fatalf("bell holds %d, want 2", n)
	}

	res = look("s-1", map[string]string{"withdraw": "true"})
	if v := res.JSON.(command.ThreadLookView); !v.Withdrawn {
		t.Fatalf("withdraw: %+v %q", v, res.Message)
	}
	if got := looks(s, "s-1"); len(got) != 1 || got[0].State != notification.StateWithdrawn {
		t.Fatalf("after withdraw: %+v", got)
	}
	res = look("s-1", map[string]string{"withdraw": "true"})
	if v := res.JSON.(command.ThreadLookView); v.Withdrawn || !strings.Contains(res.Message, "was not asking") {
		t.Fatalf("withdraw again: %+v %q", v, res.Message)
	}
	// Asking again after a withdrawal shows it again, as the same notification.
	look("s-1", map[string]string{"title": "Pick a name"})
	if got := looks(s, "s-1"); len(got) != 1 || got[0].ID != first.ID || got[0].Status() != notification.StatusShown {
		t.Fatalf("asked again: %+v", got)
	}

	for name, args := range map[string]map[string]string{
		"no title":            {},
		"withdraw with words": {"withdraw": "true", "title": "x"},
	} {
		if _, err := r.Invoke(ctx, in("s-1"), "thread.look", args); !errors.Is(err, command.ErrInvalidArgs) {
			t.Errorf("%s: err = %v, want invalid args", name, err)
		}
	}
	if _, err := r.Invoke(ctx, command.Context{}, "thread.look", map[string]string{"title": "x"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("no thread: err = %v, want invalid args", err)
	}
}

// Nothing is posted while the thread's own tab is open in the space the user's window
// shows; anything else posts, unknown included.
func TestThreadLookOnScreen(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{Threads: []string{"s-1"}})
	lay := layouttest.New(nil)
	r := command.NewRegistry()
	if err := command.RegisterThreadLook(r, command.ThreadLookDeps{Notes: s, Layout: lay}); err != nil {
		t.Fatal(err)
	}
	apply := func(op core.Op) {
		t.Helper()
		if _, err := lay.Apply(ctx, op, layout.ApplyOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	look := func() command.ThreadLookView {
		t.Helper()
		if n, ok := s.Active(notification.SourceCommand, notification.LookKey("s-1")); ok {
			if _, err := s.Withdraw(ctx, n.Source, n.Key); err != nil {
				t.Fatal(err)
			}
		}
		res, err := r.Invoke(ctx, command.Context{ActiveThreadID: "s-1"}, "thread.look", map[string]string{"title": "Look"})
		if err != nil {
			t.Fatal(err)
		}
		return res.JSON.(command.ThreadLookView)
	}

	apply(&core.OpenThread{Thread: "s-1"})
	if v := look(); !v.Posted {
		t.Fatalf("no window has loaded the layout: %+v, want posted", v)
	}
	lay.MarkImported()
	if v := look(); v.Posted || v.Reason != "on_screen" {
		t.Fatalf("tab in the current space: %+v, want not posted", v)
	}
	if _, ok := s.Active(notification.SourceCommand, notification.LookKey("s-1")); ok {
		t.Fatal("a request is active while the thread is on screen")
	}
	apply(&core.NewSpace{Name: "Other", Switch: true})
	if v := look(); !v.Posted {
		t.Fatalf("tab in another space: %+v, want posted", v)
	}
	apply(&core.SwitchSpace{Space: "sp-main"})
	if v := look(); v.Posted {
		t.Fatalf("back in its space: %+v, want not posted", v)
	}
	apply(&core.CloseThread{Thread: "s-1"})
	if v := look(); !v.Posted {
		t.Fatalf("no tab: %+v, want posted", v)
	}
}

func TestThreadOnScreen(t *testing.T) {
	st := func(current string, tabs map[string][]string) *core.State {
		s := &core.State{V: core.Version, CurrentSpace: current, DefaultSpace: "sp-a"}
		for _, sp := range []string{"sp-a", "sp-b"} {
			space := &core.Space{ID: sp, Name: sp}
			if ids := tabs[sp]; len(ids) > 0 {
				p := &core.Node{T: core.NodePane, ID: "p-" + sp}
				for _, id := range ids {
					p.Tabs = append(p.Tabs, &core.Tab{ID: "t-" + id, Kind: "thread", Thread: id, Key: "thread:" + id})
				}
				p.Active = p.Tabs[0].ID
				space.Root, space.Focus = p, p.ID
			}
			s.Spaces = append(s.Spaces, space)
		}
		return s
	}
	diff := func(current string) *core.State {
		s := st(current, nil)
		p := &core.Node{T: core.NodePane, ID: "p-d", Tabs: []*core.Tab{{ID: "t-d", Kind: "diff", Thread: "s-1", Key: "diff:s-1"}}, Active: "t-d"}
		s.Spaces[0].Root, s.Spaces[0].Focus = p, p.ID
		return s
	}
	tests := []struct {
		name          string
		snap          *layout.Snapshot
		on, wantKnown bool
	}{
		{"no layout", nil, false, false},
		{"not imported", &layout.Snapshot{State: st("sp-a", map[string][]string{"sp-a": {"s-1"}})}, false, false},
		{"its tab in the current space", &layout.Snapshot{LegacyImported: true, State: st("sp-a", map[string][]string{"sp-a": {"s-2", "s-1"}})}, true, true},
		{"its tab in another space", &layout.Snapshot{LegacyImported: true, State: st("sp-b", map[string][]string{"sp-a": {"s-1"}})}, false, true},
		{"no tab", &layout.Snapshot{LegacyImported: true, State: st("sp-a", map[string][]string{"sp-a": {"s-2"}})}, false, true},
		{"only a linked tab", &layout.Snapshot{LegacyImported: true, State: diff("sp-a")}, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			on, known := command.ThreadOnScreen(tt.snap, "s-1")
			if on != tt.on || known != tt.wantKnown {
				t.Fatalf("ThreadOnScreen = %v, %v; want %v, %v", on, known, tt.on, tt.wantKnown)
			}
		})
	}
}
