package notification_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// events collects the store's Changed events.
type events struct {
	sub *bus.Subscription[notification.Event]
}

func watch(t *testing.T, s *notificationtest.Store) *events {
	t.Helper()
	sub := bus.Subscribe[notification.Event](s.Bus, 64)
	t.Cleanup(sub.Close)
	return &events{sub: sub}
}

// take drains what was published since the last take: the ids that arrived and those
// updated, in order.
func (e *events) take() (arrived, updated []string) {
	for {
		select {
		case ev := <-e.sub.C():
			if c, ok := ev.(notification.Changed); ok {
				arrived = append(arrived, c.Arrived...)
				updated = append(updated, c.Updated...)
			}
		default:
			return arrived, updated
		}
	}
}

func post(title string) notification.Post {
	return notification.Post{Source: "ci", Key: "build", Title: title}
}

func shownIDs(s *notificationtest.Store) []string {
	var ids []string
	for _, n := range s.Snapshot().Notifications {
		if n.Shown() {
			ids = append(ids, n.ID)
		}
	}
	return ids
}

// The key rules, step by step on one store: one notification per source and key; the
// same content is dropped, a change updates in place (no arrival); a dismissed key stays
// dismissed until its content changes; a withdrawn key comes back with any re-post.
func TestKeyRules(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	ev := watch(t, s)
	var id string
	steps := []struct {
		name        string
		do          func() (notification.PostResult, error)
		want        notification.Outcome
		wantStatus  notification.Status
		wantArrived bool
		wantUpdated bool
	}{
		{name: "first post arrives", do: func() (notification.PostResult, error) { return s.Post(ctx, post("Build failed")) },
			want: notification.OutcomePosted, wantStatus: notification.StatusShown, wantArrived: true},
		{name: "same content is dropped", do: func() (notification.PostResult, error) { return s.Post(ctx, post("Build failed")) },
			want: notification.OutcomeUnchanged, wantStatus: notification.StatusShown},
		{name: "changed content updates in place", do: func() (notification.PostResult, error) {
			p := post("Build failed")
			p.Body = "3 tests failed"
			return s.Post(ctx, p)
		}, want: notification.OutcomeUpdated, wantStatus: notification.StatusShown, wantUpdated: true},
		{name: "another level is a change", do: func() (notification.PostResult, error) {
			p := post("Build failed")
			p.Body, p.Level = "3 tests failed", notification.LevelError
			return s.Post(ctx, p)
		}, want: notification.OutcomeUpdated, wantStatus: notification.StatusShown, wantUpdated: true},
		{name: "dismiss", do: func() (notification.PostResult, error) {
			n, err := s.Dismiss(ctx, id)
			return notification.PostResult{Notification: n}, err
		}, wantStatus: notification.StatusDismissed},
		{name: "a dismissed key stays dismissed with the same content", do: func() (notification.PostResult, error) {
			p := post("Build failed")
			p.Body, p.Level = "3 tests failed", notification.LevelError
			return s.Post(ctx, p)
		}, want: notification.OutcomeUnchanged, wantStatus: notification.StatusDismissed},
		{name: "and comes back when it changes", do: func() (notification.PostResult, error) {
			p := post("Build failed")
			p.Body, p.Level = "4 tests failed", notification.LevelError
			return s.Post(ctx, p)
		}, want: notification.OutcomePosted, wantStatus: notification.StatusShown, wantArrived: true},
		{name: "withdraw", do: func() (notification.PostResult, error) {
			n, err := s.Withdraw(ctx, "ci", "build")
			return notification.PostResult{Notification: n}, err
		}, wantStatus: notification.StatusWithdrawn},
		{name: "withdrawing again changes nothing", do: func() (notification.PostResult, error) {
			n, err := s.Withdraw(ctx, "ci", "build")
			return notification.PostResult{Notification: n}, err
		}, wantStatus: notification.StatusWithdrawn},
		{name: "a withdrawn key comes back with the same content", do: func() (notification.PostResult, error) {
			p := post("Build failed")
			p.Body, p.Level = "4 tests failed", notification.LevelError
			return s.Post(ctx, p)
		}, want: notification.OutcomePosted, wantStatus: notification.StatusShown, wantArrived: true},
	}
	for _, st := range steps {
		res, err := st.do()
		if err != nil {
			t.Fatalf("%s: %v", st.name, err)
		}
		if id == "" {
			id = res.Notification.ID
		}
		if res.Notification.ID != id {
			t.Errorf("%s: id %s, want the key's one notification %s", st.name, res.Notification.ID, id)
		}
		if res.Outcome != st.want {
			t.Errorf("%s: outcome %q, want %q", st.name, res.Outcome, st.want)
		}
		if got := res.Notification.Status(); got != st.wantStatus {
			t.Errorf("%s: status %q, want %q", st.name, got, st.wantStatus)
		}
		arrived, updated := ev.take()
		if got := len(arrived) == 1 && arrived[0] == id; got != st.wantArrived || (!st.wantArrived && len(arrived) > 0) {
			t.Errorf("%s: arrived %v, want arrival %v", st.name, arrived, st.wantArrived)
		}
		if got := len(updated) == 1 && updated[0] == id; got != st.wantUpdated || (!st.wantUpdated && len(updated) > 0) {
			t.Errorf("%s: updated %v, want update %v", st.name, updated, st.wantUpdated)
		}
		s.Clock.Advance(time.Second)
	}
	if n := len(s.List(true)); n != 1 {
		t.Errorf("%d notifications in all, want 1 for the one key", n)
	}
}

// A resolved key (the user acted on it) stays resolved with the same content, like a
// dismissed one.
func TestResolvedKeyStaysResolved(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	p := post("Deploy ready")
	p.Actions = []notification.ActionSpec{{Action: notification.Action{Label: "Deploy", Kind: notification.KindCommand, Command: "deploy"}}}
	res, err := s.Post(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Act(ctx, res.Notification.ID, 0, func(context.Context, notification.Notification, notification.Action) error { return nil }); err != nil {
		t.Fatal(err)
	}
	again, err := s.Post(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if again.Outcome != notification.OutcomeUnchanged || again.Notification.State != notification.StateResolved {
		t.Errorf("re-post: %s %s, want unchanged and still resolved", again.Outcome, again.Notification.State)
	}
}

// Without a key the host derives one from the title, body and thread: the same words are
// the same notification, and another level or other actions update it.
func TestDerivedKey(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	var first string
	for _, tt := range []struct {
		name string
		p    notification.Post
		want notification.Outcome
		same bool
	}{
		{"first", notification.Post{Source: "command", Title: "Lunch"}, notification.OutcomePosted, true},
		{"same words", notification.Post{Source: "command", Title: "Lunch"}, notification.OutcomeUnchanged, true},
		{"another level", notification.Post{Source: "command", Title: "Lunch", Level: notification.LevelWarning}, notification.OutcomeUpdated, true},
		{"time-sensitive", notification.Post{Source: "command", Title: "Lunch", Level: notification.LevelWarning, TimeSensitive: true}, notification.OutcomeUpdated, true},
		{"another body", notification.Post{Source: "command", Title: "Lunch", Body: "at noon"}, notification.OutcomePosted, false},
		{"another source", notification.Post{Source: "cal", Title: "Lunch"}, notification.OutcomePosted, false},
	} {
		res, err := s.Post(ctx, tt.p)
		if err != nil {
			t.Fatalf("%s: %v", tt.name, err)
		}
		if res.Outcome != tt.want {
			t.Errorf("%s: outcome %q, want %q", tt.name, res.Outcome, tt.want)
		}
		if first == "" {
			first = res.Notification.ID
		}
		if got := res.Notification.ID == first; got != tt.same {
			t.Errorf("%s: notification %s, the first's %s: same %v, want %v", tt.name, res.Notification.ID, first, got, tt.same)
		}
		if tt.same && res.Notification.Key != notification.DerivedKey("Lunch", "", "") {
			t.Errorf("%s: key %q, want the derived one", tt.name, res.Notification.Key)
		}
		if !strings.HasPrefix(res.Notification.Key, "auto:") {
			t.Errorf("%s: key %q, want a derived one", tt.name, res.Notification.Key)
		}
	}
}

func TestPostValidation(t *testing.T) {
	ok := func(p notification.Post) notification.Post { p.Source, p.Title = "ci", "Hi"; return p }
	yes := true
	long := func(n int) string { return strings.Repeat("x", n) }
	for _, tt := range []struct {
		name    string
		p       notification.Post
		wantErr error
		has     string
	}{
		{"no title", notification.Post{Source: "ci"}, notification.ErrInvalidArgument, "needs a title"},
		{"blank title", notification.Post{Source: "ci", Title: "  "}, notification.ErrInvalidArgument, "needs a title"},
		{"two-line title", notification.Post{Source: "ci", Title: "a\nb"}, notification.ErrInvalidArgument, "one line"},
		{"long title", notification.Post{Source: "ci", Title: long(121)}, notification.ErrInvalidArgument, "at most 120"},
		{"long body", ok(notification.Post{Body: long(1001)}), notification.ErrInvalidArgument, "at most 1000"},
		{"no source", notification.Post{Title: "Hi"}, notification.ErrInvalidArgument, "source"},
		{"bad source", notification.Post{Source: "Some Plugin", Title: "Hi"}, notification.ErrInvalidArgument, "source"},
		{"bad level", ok(notification.Post{Level: "success"}), notification.ErrInvalidArgument, "level"},
		{"host's key", ok(notification.Post{Key: "auto:1"}), notification.ErrInvalidArgument, "host's"},
		{"long key", ok(notification.Post{Key: long(201)}), notification.ErrInvalidArgument, "at most 200"},
		{"unknown thread", ok(notification.Post{ThreadID: "s-gone"}), notification.ErrNotFound, "s-gone"},
		{"four actions", ok(notification.Post{Actions: make([]notification.ActionSpec, 4)}), notification.ErrInvalidArgument, "at most 3"},
		{"no label", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Kind: notification.KindOpen, URL: "https://x.dev"}}}}),
			notification.ErrInvalidArgument, "needs a label"},
		{"long label", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Label: long(33), Kind: notification.KindOpen, URL: "https://x.dev"}}}}),
			notification.ErrInvalidArgument, "at most 32"},
		{"unknown kind", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: "run"}}}}),
			notification.ErrInvalidArgument, "kind"},
		{"file URL", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: notification.KindOpen, URL: "file:///etc/hosts"}}}}),
			notification.ErrInvalidArgument, "http or https"},
		{"send to an unknown thread", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: notification.KindSend, ThreadID: "s-gone", Text: "hi"}}}}),
			notification.ErrNotFound, "s-gone"},
		{"send no text", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: notification.KindSend, ThreadID: "s-1"}}}}),
			notification.ErrInvalidArgument, "needs text"},
		{"start no prompt", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: notification.KindStart}}}}),
			notification.ErrInvalidArgument, "needs a prompt"},
		{"bad command", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: notification.KindCommand, Command: "Deploy Now"}}}}),
			notification.ErrInvalidArgument, "command"},
		{"command from the command source", notification.Post{Source: notification.SourceCommand, Title: "Hi",
			Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: notification.KindCommand, Command: "deploy"}}}},
			notification.ErrInvalidArgument, "only a plugin"},
		{"bad arg name", ok(notification.Post{Actions: []notification.ActionSpec{{Action: notification.Action{Label: "Go", Kind: notification.KindCommand, Command: "deploy",
			Args: map[string]string{"Bad Name": "1"}}}}}), notification.ErrInvalidArgument, "arg name"},
		{"valid", ok(notification.Post{Body: "line one\nline two", ThreadID: "s-1", Actions: []notification.ActionSpec{
			{Action: notification.Action{Label: "Deploy", Kind: notification.KindCommand, Command: "deploy.prod", Args: map[string]string{"env": "prod"}}},
			{Action: notification.Action{Label: "Tell", Kind: notification.KindSend, ThreadID: "s-1", Text: "deploy is ready"}},
			{Action: notification.Action{Label: "Open", Kind: notification.KindOpen, URL: "https://ci.example.com/1"}, Resolves: &yes},
		}}), nil, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := notificationtest.New(t, notificationtest.Options{Threads: []string{"s-1"}})
			_, err := s.Post(context.Background(), tt.p)
			if tt.wantErr == nil {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.has) {
				t.Errorf("err %v, want %v containing %q", err, tt.wantErr, tt.has)
			}
		})
	}
}

// Each action kind's resolves default, and an explicit one.
func TestActionResolvesDefault(t *testing.T) {
	no := false
	s := notificationtest.New(t, notificationtest.Options{})
	res, err := s.Post(context.Background(), notification.Post{Source: "ci", Title: "Hi", Actions: []notification.ActionSpec{
		{Action: notification.Action{Label: "Run", Kind: notification.KindCommand, Command: "run"}},
		{Action: notification.Action{Label: "Start", Kind: notification.KindStart, Prompt: "look at it"}},
		{Action: notification.Action{Label: "Open", Kind: notification.KindOpen, URL: "https://example.com"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var got []bool
	for _, a := range res.Notification.Actions {
		got = append(got, a.Resolves)
	}
	if want := []bool{true, true, false}; !slices.Equal(got, want) {
		t.Errorf("resolves %v, want %v", got, want)
	}
	res, err = s.Post(context.Background(), notification.Post{Source: "ci", Key: "k", Title: "Hi", Actions: []notification.ActionSpec{
		{Action: notification.Action{Label: "Send", Kind: notification.KindSend, ThreadID: "s-1", Text: "go"}, Resolves: &no},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Notification.Actions[0].Resolves {
		t.Error("an explicit resolves=false was not kept")
	}
}

// show_at keeps a notification out of the bell (and arrives nothing) until its time;
// then it arrives. The schedule survives a restart, and one that passed while the daemon
// was stopped arrives when it starts.
func TestShowAt(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	ev := watch(t, s)
	p := post("Standup")
	p.ShowAt = s.Clock.Now().Add(10 * time.Minute)
	res, err := s.Post(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	id := res.Notification.ID
	if res.Outcome != notification.OutcomeScheduled || res.Notification.Status() != notification.StatusScheduled {
		t.Fatalf("post: %s %s, want scheduled", res.Outcome, res.Notification.Status())
	}
	if arrived, _ := ev.take(); len(arrived) != 0 || len(shownIDs(s)) != 0 {
		t.Fatalf("arrived %v, shown %v before show_at", arrived, shownIDs(s))
	}
	// The same post again: unchanged; a changed one while scheduled stays scheduled.
	if again, _ := s.Post(ctx, p); again.Outcome != notification.OutcomeUnchanged {
		t.Errorf("same scheduled post: %s, want unchanged", again.Outcome)
	}
	p.Body = "in room 4"
	if again, _ := s.Post(ctx, p); again.Outcome != notification.OutcomeScheduled {
		t.Errorf("changed scheduled post: %s, want scheduled", again.Outcome)
	}
	s.Clock.Advance(9 * time.Minute)
	s.Tick()
	if arrived, _ := ev.take(); len(arrived) != 0 {
		t.Fatalf("arrived %v a minute early", arrived)
	}
	s.Reopen(t)
	if n, _ := s.Get(id); n.Status() != notification.StatusScheduled || !n.ShowAt.Equal(p.ShowAt) {
		t.Fatalf("after a restart: %s at %v, want scheduled at %v", n.Status(), n.ShowAt, p.ShowAt)
	}
	s.Clock.Advance(time.Minute)
	s.Tick()
	if arrived, _ := ev.take(); !slices.Equal(arrived, []string{id}) {
		t.Fatalf("arrived %v at show_at, want %s", arrived, id)
	}
	if got := shownIDs(s); !slices.Equal(got, []string{id}) {
		t.Errorf("shown %v, want %s", got, id)
	}
	s.Tick()
	if arrived, _ := ev.take(); len(arrived) != 0 {
		t.Errorf("arrived again %v on the next tick", arrived)
	}

	// Due while the daemon was stopped: it arrives at start.
	p2 := notification.Post{Source: "ci", Key: "later", Title: "Later", ShowAt: s.Clock.Now().Add(time.Hour)}
	if _, err := s.Post(ctx, p2); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s.Clock.Advance(2 * time.Hour)
	s.Reopen(t)
	if got := s.Snapshot().Notifications[0]; got.Key != "later" || !got.Shown() {
		t.Errorf("after a restart past show_at: %s %s, want later shown first", got.Key, got.Status())
	}

	// A show_at in the past is at once.
	p3 := notification.Post{Source: "ci", Key: "past", Title: "Past", ShowAt: s.Clock.Now().Add(-time.Minute)}
	if res, _ := s.Post(ctx, p3); res.Outcome != notification.OutcomePosted {
		t.Errorf("past show_at: %s, want posted", res.Outcome)
	}
	// A shown one whose source moves its show_at ahead leaves the bell until then.
	p3.ShowAt = s.Clock.Now().Add(time.Hour)
	if res, _ := s.Post(ctx, p3); res.Outcome != notification.OutcomeScheduled || res.Notification.Shown() {
		t.Errorf("show_at moved ahead: %s %s, want scheduled", res.Outcome, res.Notification.Status())
	}
}

// Snooze hides a shown notification until a time, when it arrives again; it survives a
// restart. A change from the source while it is snoozed keeps it snoozed.
func TestSnooze(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	ev := watch(t, s)
	res, err := s.Post(ctx, post("Review requested"))
	if err != nil {
		t.Fatal(err)
	}
	id := res.Notification.ID
	ev.take()
	if _, err := s.Snooze(ctx, id, s.Clock.Now()); !errors.Is(err, notification.ErrInvalidArgument) {
		t.Errorf("snooze until now: %v, want invalid argument", err)
	}
	n, err := s.Snooze(ctx, id, s.Clock.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if n.Status() != notification.StatusSnoozed || len(shownIDs(s)) != 0 {
		t.Fatalf("snoozed: %s, shown %v", n.Status(), shownIDs(s))
	}
	p := post("Review requested")
	p.Body = "by a reviewer"
	if res, _ := s.Post(ctx, p); res.Outcome != notification.OutcomeUpdated || res.Notification.Status() != notification.StatusSnoozed {
		t.Errorf("change while snoozed: %s %s, want updated and still snoozed", res.Outcome, res.Notification.Status())
	}
	if arrived, updated := ev.take(); len(arrived)+len(updated) != 0 {
		t.Errorf("while snoozed: arrived %v updated %v, want neither", arrived, updated)
	}
	s.Reopen(t)
	s.Clock.Advance(59 * time.Minute)
	s.Tick()
	if arrived, _ := ev.take(); len(arrived) != 0 {
		t.Fatalf("arrived %v before the snooze ended", arrived)
	}
	s.Clock.Advance(time.Minute)
	s.Tick()
	if arrived, _ := ev.take(); !slices.Equal(arrived, []string{id}) {
		t.Fatalf("arrived %v when the snooze ended, want %s", arrived, id)
	}
	n, _ = s.Get(id)
	if !n.Shown() || !n.SnoozedUntil.IsZero() || !n.ArrivedAt.Equal(s.Clock.Now()) {
		t.Errorf("after the snooze: %s, snoozed until %v, arrived %v", n.Status(), n.SnoozedUntil, n.ArrivedAt)
	}

	// Not before its show_at, and not once closed.
	sched := notification.Post{Source: "ci", Key: "s", Title: "S", ShowAt: s.Clock.Now().Add(time.Hour)}
	r2, _ := s.Post(ctx, sched)
	if _, err := s.Snooze(ctx, r2.Notification.ID, s.Clock.Now().Add(2*time.Hour)); !errors.Is(err, notification.ErrFailedPrecondition) {
		t.Errorf("snooze a scheduled one: %v, want failed precondition", err)
	}
	if _, err := s.Dismiss(ctx, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Snooze(ctx, id, s.Clock.Now().Add(time.Hour)); !errors.Is(err, notification.ErrFailedPrecondition) {
		t.Errorf("snooze a dismissed one: %v, want failed precondition", err)
	}
	if _, err := s.Snooze(ctx, "n-nope", s.Clock.Now().Add(time.Hour)); !errors.Is(err, notification.ErrNotFound) {
		t.Errorf("snooze an unknown one: %v, want not found", err)
	}
}

// Clear dismisses what the bell shows; snoozed and scheduled ones stay.
func TestClear(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	ids := map[string]string{}
	for _, k := range []string{"a", "b", "snoozed", "scheduled"} {
		p := notification.Post{Source: "ci", Key: k, Title: k}
		if k == "scheduled" {
			p.ShowAt = s.Clock.Now().Add(time.Hour)
		}
		res, err := s.Post(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		ids[k] = res.Notification.ID
	}
	if _, err := s.Snooze(ctx, ids["snoozed"], s.Clock.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	n, err := s.Clear(ctx)
	if err != nil || n != 2 {
		t.Fatalf("clear: %d, %v; want 2", n, err)
	}
	var left []string
	for _, x := range s.Snapshot().Notifications {
		left = append(left, x.Key)
	}
	slices.Sort(left)
	if !slices.Equal(left, []string{"scheduled", "snoozed"}) {
		t.Errorf("left after clear: %v", left)
	}
	if n, err := s.Clear(ctx); err != nil || n != 0 {
		t.Errorf("clear again: %d, %v; want 0", n, err)
	}
}

// A source withdraws only its own notifications.
func TestWithdrawOwnOnly(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	if _, err := s.Post(ctx, post("Build failed")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Withdraw(ctx, "other", "build"); !errors.Is(err, notification.ErrNotFound) {
		t.Errorf("another source's withdraw: %v, want not found", err)
	}
	if got := shownIDs(s); len(got) != 1 {
		t.Errorf("shown %v after another source's withdraw", got)
	}
	n, err := s.Withdraw(ctx, "ci", "build")
	if err != nil || n.State != notification.StateWithdrawn {
		t.Errorf("own withdraw: %v %v", n.State, err)
	}
}

func TestAct(t *testing.T) {
	ctx := context.Background()
	actions := []notification.ActionSpec{
		{Action: notification.Action{Label: "Retry", Kind: notification.KindCommand, Command: "retry", Args: map[string]string{"job": "7"}}},
		{Action: notification.Action{Label: "Logs", Kind: notification.KindOpen, URL: "https://ci.example.com/7"}},
	}
	ran := func(got *[]string, fail error) func(context.Context, notification.Notification, notification.Action) error {
		return func(_ context.Context, _ notification.Notification, a notification.Action) error {
			*got = append(*got, a.Label)
			return fail
		}
	}
	for _, tt := range []struct {
		name      string
		index     int
		fail      error
		closed    bool
		wantErr   error
		wantRan   []string
		wantState notification.State
	}{
		{name: "primary resolves", index: 0, wantRan: []string{"Retry"}, wantState: notification.StateResolved},
		{name: "open does not resolve", index: 1, wantRan: []string{"Logs"}, wantState: notification.StateActive},
		{name: "a failed action leaves it", index: 0, fail: errors.New("boom"), wantErr: errors.New("boom"), wantRan: []string{"Retry"}, wantState: notification.StateActive},
		{name: "no such action", index: 2, wantErr: notification.ErrInvalidArgument, wantState: notification.StateActive},
		{name: "a dismissed one", index: 0, closed: true, wantErr: notification.ErrFailedPrecondition, wantState: notification.StateDismissed},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := notificationtest.New(t, notificationtest.Options{})
			res, err := s.Post(ctx, notification.Post{Source: "ci", Title: "Build failed", Actions: actions})
			if err != nil {
				t.Fatal(err)
			}
			id := res.Notification.ID
			if tt.closed {
				if _, err := s.Dismiss(ctx, id); err != nil {
					t.Fatal(err)
				}
			}
			var got []string
			_, a, err := s.Act(ctx, id, tt.index, ran(&got, tt.fail))
			switch {
			case tt.wantErr == nil && err != nil:
				t.Fatal(err)
			case tt.wantErr != nil && (err == nil || (!errors.Is(err, tt.wantErr) && err.Error() != tt.wantErr.Error())):
				t.Fatalf("err %v, want %v", err, tt.wantErr)
			}
			if !slices.Equal(got, tt.wantRan) {
				t.Errorf("ran %v, want %v", got, tt.wantRan)
			}
			if tt.wantErr == nil && a.Label != tt.wantRan[0] {
				t.Errorf("act returned action %q", a.Label)
			}
			if n, _ := s.Get(id); n.State != tt.wantState {
				t.Errorf("state %s, want %s", n.State, tt.wantState)
			}
		})
	}
}

// An action that ran while the source changed the notification does not resolve the new
// content, which the user has not acted on.
func TestActKeepsNewerContent(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	p := post("Build failed")
	p.Actions = []notification.ActionSpec{{Action: notification.Action{Label: "Retry", Kind: notification.KindCommand, Command: "retry"}}}
	res, err := s.Post(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	n, _, err := s.Act(ctx, res.Notification.ID, 0, func(context.Context, notification.Notification, notification.Action) error {
		p.Body = "again"
		_, err := s.Post(ctx, p)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if n.State != notification.StateActive || n.Body != "again" {
		t.Errorf("after act: %s %q, want the newer content active", n.State, n.Body)
	}
}

// A notification may name a thread only while it exists; removing the thread withdraws
// it (and only it), and the sweep withdraws those whose thread is gone.
func TestThreads(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{Threads: []string{"s-1", "s-2"}})
	a, err := s.Post(ctx, notification.Post{Source: "ci", Key: "a", Title: "A", ThreadID: "s-1"})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := s.Post(ctx, notification.Post{Source: "ci", Key: "b", Title: "B", ThreadID: "s-2"})
	c, _ := s.Post(ctx, notification.Post{Source: "ci", Key: "c", Title: "C"})
	if n, err := s.ThreadGone(ctx, "s-1"); err != nil || n != 1 {
		t.Fatalf("thread gone: %d, %v", n, err)
	}
	if n, err := s.WithdrawMissingThreads(ctx, func(id string) bool { return id != "s-2" }); err != nil || n != 1 {
		t.Fatalf("sweep: %d, %v", n, err)
	}
	for _, tt := range []struct {
		id   string
		want notification.State
	}{{a.Notification.ID, notification.StateWithdrawn}, {b.Notification.ID, notification.StateWithdrawn}, {c.Notification.ID, notification.StateActive}} {
		if n, _ := s.Get(tt.id); n.State != tt.want {
			t.Errorf("%s: %s, want %s", n.Key, n.State, tt.want)
		}
	}
}

// The snapshot holds the active notifications, shown first (time-sensitive first, newest
// first), and counts the shown time-sensitive ones for the dock badge.
func TestSnapshotOrderAndCount(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	for _, p := range []notification.Post{
		{Source: "ci", Key: "old", Title: "old"},
		{Source: "ci", Key: "urgent", Title: "urgent", TimeSensitive: true},
		{Source: "ci", Key: "new", Title: "new"},
		{Source: "ci", Key: "later", Title: "later", TimeSensitive: true, ShowAt: notificationtest.T0.Add(time.Hour)},
		{Source: "ci", Key: "snoozed", Title: "snoozed", TimeSensitive: true},
	} {
		res, err := s.Post(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		if p.Key == "snoozed" {
			if _, err := s.Snooze(ctx, res.Notification.ID, notificationtest.T0.Add(30*time.Minute)); err != nil {
				t.Fatal(err)
			}
		}
		s.Clock.Advance(time.Second)
	}
	snap := s.Snapshot()
	var keys []string
	for _, n := range snap.Notifications {
		keys = append(keys, n.Key)
	}
	if want := []string{"urgent", "new", "old", "snoozed", "later"}; !slices.Equal(keys, want) {
		t.Errorf("order %v, want %v", keys, want)
	}
	if snap.TimeSensitive != 1 {
		t.Errorf("time-sensitive count %d, want 1 (snoozed and scheduled ones do not count)", snap.TimeSensitive)
	}
}

// Every field survives a restart.
func TestPersistence(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	res, err := s.Post(ctx, notification.Post{Source: "ci", Key: "k", Level: notification.LevelWarning, TimeSensitive: true,
		Title: "Deploy", Body: "two\nlines", ThreadID: "s-1",
		ShowAt: notificationtest.T0.Add(-time.Minute),
		Actions: []notification.ActionSpec{
			{Action: notification.Action{Label: "Go", Kind: notification.KindCommand, Command: "go", Args: map[string]string{"a": "1"}}},
			{Action: notification.Action{Label: "Ask", Kind: notification.KindStart, Prompt: "why", ProjectID: "web"}},
		}})
	if err != nil {
		t.Fatal(err)
	}
	s.Reopen(t)
	got, err := s.Get(res.Notification.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(stripLoc(got)) != fmt.Sprint(stripLoc(res.Notification)) {
		t.Errorf("after a restart:\n got %+v\nwant %+v", got, res.Notification)
	}
}

func stripLoc(n notification.Notification) notification.Notification {
	for _, t := range []*time.Time{&n.ShowAt, &n.CreatedAt, &n.UpdatedAt, &n.ArrivedAt, &n.SnoozedUntil} {
		if !t.IsZero() {
			*t = t.UTC()
		}
	}
	return n
}

// Closed notifications are forgotten 30 days after their last change (then a re-post with
// the same content shows again); active ones are kept however old.
func TestPrune(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	old, _ := s.Post(ctx, post("Build failed"))
	keep, _ := s.Post(ctx, notification.Post{Source: "ci", Key: "active", Title: "Still here"})
	if _, err := s.Dismiss(ctx, old.Notification.ID); err != nil {
		t.Fatal(err)
	}
	s.Clock.Advance(notification.ClosedRetention + time.Hour)
	s.Tick()
	if _, err := s.Get(old.Notification.ID); !errors.Is(err, notification.ErrNotFound) {
		t.Errorf("a closed one past retention: %v, want pruned", err)
	}
	if _, err := s.Get(keep.Notification.ID); err != nil {
		t.Errorf("an active one: %v, want kept", err)
	}
	s.Reopen(t)
	if res, _ := s.Post(ctx, post("Build failed")); res.Outcome != notification.OutcomePosted {
		t.Errorf("re-post after the prune: %s, want posted", res.Outcome)
	}
}

// A source may hold at most MaxActivePerSource active notifications.
func TestActiveCap(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{})
	for i := range notification.MaxActivePerSource {
		if _, err := s.Post(ctx, notification.Post{Source: "spam", Key: fmt.Sprint(i), Title: "x"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Post(ctx, notification.Post{Source: "spam", Key: "one more", Title: "x"}); !errors.Is(err, notification.ErrFull) {
		t.Errorf("past the cap: %v, want ErrFull", err)
	}
	if _, err := s.Post(ctx, notification.Post{Source: "spam", Key: "0", Title: "changed"}); err != nil {
		t.Errorf("an update at the cap: %v", err)
	}
	if _, err := s.Post(ctx, notification.Post{Source: "other", Title: "x"}); err != nil {
		t.Errorf("another source: %v", err)
	}
}
