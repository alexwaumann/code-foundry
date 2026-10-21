package thread

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"
)

// Which subscriptions a restart fires, and who gets a notice.
func TestPlanRestartWakes(t *testing.T) {
	t0 := time.Date(2026, 10, 19, 10, 45, 49, 0, time.UTC)
	now := t0.Add(time.Second)
	cut := func(id string) Thread {
		return Thread{ID: id, Name: "kid " + id, State: StateDisconnected, Status: StatusError, StatusReason: ReasonInterrupted,
			DisconnectReason: ReasonDaemonStopped, StatusChangedAt: t0}
	}
	crashed := cut("c")
	crashed.DisconnectReason = ReasonDaemonRestarts
	closed := cut("x")
	closed.DisconnectReason = ReasonClosed
	done := Thread{ID: "d", State: StateDisconnected, Status: StatusNeedsAttention, StatusReason: "finished", DisconnectReason: ReasonDaemonStopped}
	working := Thread{ID: "w", State: StateConnected, Status: StatusBusy, StatusReason: "working"}
	parent := Thread{ID: "p", State: StateDisconnected, Status: StatusIdle, StatusReason: "at prompt"}
	lead := cut("l") // a subscriber whose own turn the stop cut
	threads := map[string]Thread{}
	for _, th := range []Thread{cut("a"), cut("b"), crashed, closed, done, working, parent, lead, {ID: "q", State: StateDisconnected}} {
		threads[th.ID] = th
	}
	lookup := func(id string) (Thread, bool) { th, ok := threads[id]; return th, ok }
	sub := func(id, subscriber, target string, c Condition) Subscription {
		return Subscription{ID: id, SubscriberID: subscriber, TargetKind: TargetThread, TargetID: target, Condition: c, Repeat: true,
			CreatedAt: t0.Add(-time.Hour)}
	}
	suppressed := func(s Subscription) Subscription { s.SuppressedAt = t0; return s }
	firedAfter := func(s Subscription) Subscription { s.LastFiredAt = t0.Add(time.Millisecond); return s }
	pr := Subscription{ID: "sub-pr", SubscriberID: "p", TargetKind: TargetPullRequest, TargetID: "o/r#1", Condition: CondChecksDone}

	type fire struct {
		sub     string
		at      time.Time
		stopped bool
	}
	type plan struct {
		subscriber  string
		fires       []fire
		interrupted []string
		subs        int
		self        bool
	}
	tests := []struct {
		name  string
		subs  []Subscription
		want  []plan
		clear []string
	}{
		{"suppressed, target interrupted", []Subscription{suppressed(sub("s1", "p", "a", CondSettled))},
			[]plan{{"p", []fire{{"s1", t0, true}}, []string{"a"}, 1, false}}, []string{"s1"}},
		{"suppressed, target finished at the stop", []Subscription{suppressed(sub("s1", "p", "d", CondSettled))},
			[]plan{{"p", []fire{{"s1", t0, false}}, nil, 1, false}}, []string{"s1"}},
		{"suppressed, target working again: cleared only", []Subscription{suppressed(sub("s1", "p", "w", CondSettled))},
			nil, []string{"s1"}},
		{"interrupted, nothing suppressed (a crash)", []Subscription{sub("s1", "p", "c", CondSettled)},
			[]plan{{"p", []fire{{"s1", t0, true}}, []string{"c"}, 1, false}}, nil},
		{"interrupted, attention subscription", []Subscription{sub("s1", "p", "a", CondAttention)},
			[]plan{{"p", []fire{{"s1", t0, true}}, []string{"a"}, 1, false}}, nil},
		{"interrupted, one-shot", []Subscription{func() Subscription { s := sub("s1", "p", "a", CondSettled); s.Repeat = false; return s }()},
			[]plan{{"p", []fire{{"s1", t0, true}}, []string{"a"}, 1, false}}, nil},
		{"interrupted, already told after it", []Subscription{firedAfter(sub("s1", "p", "a", CondSettled))}, nil, nil},
		{"interrupted, disconnected subscription", []Subscription{sub("s1", "p", "a", CondDisconnected)}, nil, nil},
		{"interrupted by a close, not the stop", []Subscription{sub("s1", "p", "x", CondSettled)}, nil, nil},
		{"target at rest", []Subscription{sub("s1", "p", "d", CondSettled), pr}, nil, nil},
		{"target archived or removed", []Subscription{suppressed(sub("s1", "p", "gone", CondSettled))}, nil, []string{"s1"}},
		{"subscriber archived or removed", []Subscription{sub("s1", "gone", "a", CondSettled)}, nil, nil},
		{"two subscriptions to one target: one fire, the oldest", []Subscription{
			sub("s2", "p", "a", CondAttention),
			func() Subscription {
				s := sub("s1", "p", "a", CondSettled)
				s.CreatedAt = t0.Add(-2 * time.Hour)
				return s
			}(),
		}, []plan{{"p", []fire{{"s1", t0, true}}, []string{"a"}, 2, false}}, nil},
		{"several children, every subscription counted", []Subscription{
			sub("s1", "p", "a", CondSettled), suppressed(sub("s2", "p", "b", CondSettled)), sub("s3", "p", "d", CondSettled), pr,
		}, []plan{{"p", []fire{{"s1", t0, true}, {"s2", t0, true}}, []string{"a", "b"}, 4, false}}, []string{"s2"}},
		{"its own turn cut: a notice alone", []Subscription{sub("s1", "l", "d", CondSettled)},
			[]plan{{"l", nil, nil, 1, true}}, nil},
		{"two subscribers", []Subscription{sub("s1", "p", "a", CondSettled), sub("s2", "q", "b", CondSettled), sub("s3", "q", "d", CondSettled)},
			[]plan{{"p", []fire{{"s1", t0, true}}, []string{"a"}, 1, false}, {"q", []fire{{"s2", t0, true}}, []string{"b"}, 2, false}}, nil},
		{"no subscriptions", nil, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plans, clear := planRestartWakes(restartInput{subs: tt.subs, thread: lookup}, now)
			var got []plan
			for _, p := range plans {
				g := plan{subscriber: p.subscriber, subs: p.notice.subscriptions, self: p.notice.self}
				for _, f := range p.fires {
					g.fires = append(g.fires, fire{f.sub, f.at, f.stopped})
				}
				for _, th := range p.notice.interrupted {
					g.interrupted = append(g.interrupted, th.ID)
				}
				if !p.notice.at.Equal(now) {
					t.Errorf("notice at %v, want %v", p.notice.at, now)
				}
				got = append(got, g)
			}
			if !slices.EqualFunc(got, tt.want, func(a, b plan) bool {
				return a.subscriber == b.subscriber && slices.Equal(a.fires, b.fires) && slices.Equal(a.interrupted, b.interrupted) &&
					a.subs == b.subs && a.self == b.self
			}) {
				t.Errorf("plans = %+v\nwant %+v", got, tt.want)
			}
			if !slices.Equal(clear, tt.clear) {
				t.Errorf("clear = %v, want %v", clear, tt.clear)
			}
		})
	}
}

// The restart wake's header and JSON: the notice alone, or first with the thread
// wakes after it.
func TestRestartWakeMessage(t *testing.T) {
	at := time.Date(2026, 10, 19, 10, 45, 50, 0, time.UTC)
	kid := func(id, name string) Thread {
		return Thread{ID: id, Name: name, State: StateDisconnected, Status: StatusError, StatusReason: ReasonInterrupted,
			DisconnectReason: ReasonDaemonStopped}
	}
	a, b := kid("s-a", "Tests"), kid("s-b", "Docs")
	a.Report = Report{Status: ReportProgress, Summary: "halfway", At: at.Add(-time.Minute)}
	part := func(th Thread, stopped bool) threadWakePart {
		return threadWakePart{sub: Subscription{ID: "sub-" + th.ID, Condition: CondSettled}, t: th, at: at.Add(-time.Second),
			d: wakeDetail{afterRestart: true, appStopped: stopped}}
	}
	done := Thread{ID: "s-d", Name: "Lint", State: StateDisconnected, Status: StatusNeedsAttention, StatusReason: "finished",
		Report: Report{Status: ReportDone, Summary: "clean", At: at.Add(-time.Minute)}}
	tests := []struct {
		name   string
		notice restartNotice
		parts  []threadWakePart
		title  string
		kinds  []string // the JSON's kind, then a batch's wakes' kinds
	}{
		{"notice alone, its own turn cut", restartNotice{at: at, subscriptions: 2, self: true}, nil,
			"The app restarted at 10:45 UTC; your own turn was interrupted; none of your child threads were interrupted.",
			[]string{"restart"}},
		{"one child interrupted", restartNotice{at: at, interrupted: []Thread{a}, subscriptions: 1}, []threadWakePart{part(a, true)},
			`The app restarted at 10:45 UTC; 1 of your child threads was interrupted: "Tests" (s-a); its session resumes on your next send. ` +
				`Thread "Tests" (s-a) was interrupted when the app stopped. Report: progress — halfway.`,
			[]string{"batch", "restart", "thread"}},
		{"two interrupted", restartNotice{at: at, interrupted: []Thread{a, b}, subscriptions: 3},
			[]threadWakePart{part(a, true), part(b, true)},
			`The app restarted at 10:45 UTC; 2 of your child threads were interrupted: "Tests" (s-a), "Docs" (s-b); their sessions resume on your next send. ` +
				`2 threads interrupted: Thread "Tests" (s-a) was interrupted when the app stopped. Report: progress — halfway. ` +
				`Thread "Docs" (s-b) was interrupted when the app stopped.`,
			[]string{"batch", "restart", "thread", "thread"}},
		{"one interrupted, one finished at the stop", restartNotice{at: at, interrupted: []Thread{a}, subscriptions: 2},
			[]threadWakePart{part(a, true), part(done, false)},
			`The app restarted at 10:45 UTC; 1 of your child threads was interrupted: "Tests" (s-a); its session resumes on your next send. ` +
				`2 threads settled: Thread "Tests" (s-a) was interrupted when the app stopped. Report: progress — halfway. ` +
				`Thread "Lint" (s-d) needs attention: finished. Report: done — clean.`,
			[]string{"batch", "restart", "thread", "thread"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := restartWake(tt.notice, tt.parts)
			if msg.WakeTitle != tt.title {
				t.Errorf("title:\n got %s\nwant %s", msg.WakeTitle, tt.title)
			}
			if !strings.HasPrefix(msg.Text, wakePrefix+tt.title+"\n```json\n") || msg.Origin != OriginWake {
				t.Errorf("text = %q", msg.Text)
			}
			var p struct {
				Kind  string `json:"kind"`
				Wakes []struct {
					Kind         string `json:"kind"`
					AfterRestart bool   `json:"after_restart"`
				} `json:"wakes"`
			}
			if err := json.Unmarshal([]byte(msg.WakeJSON), &p); err != nil {
				t.Fatal(err)
			}
			kinds := []string{p.Kind}
			for _, w := range p.Wakes {
				kinds = append(kinds, w.Kind)
				if w.Kind == "thread" && !w.AfterRestart {
					t.Errorf("a thread wake without after_restart: %s", msg.WakeJSON)
				}
			}
			if !slices.Equal(kinds, tt.kinds) {
				t.Errorf("kinds = %v, want %v", kinds, tt.kinds)
			}
		})
	}
	// The notice's own JSON.
	msg := restartWake(restartNotice{at: at, interrupted: []Thread{a, b}, subscriptions: 3}, nil)
	var got wakeRestartPayload
	if err := json.Unmarshal([]byte(msg.WakeJSON), &got); err != nil {
		t.Fatal(err)
	}
	want := wakeRestartPayload{Kind: "restart", RestartedAt: "2026-10-19T10:45:50.000Z", Subscriptions: 3, Interrupted: []wakeInterrupted{
		{ID: "s-a", Name: "Tests", Reason: ReasonDaemonStopped}, {ID: "s-b", Name: "Docs", Reason: ReasonDaemonStopped}}}
	if got.Kind != want.Kind || got.RestartedAt != want.RestartedAt || got.Subscriptions != want.Subscriptions ||
		!slices.Equal(got.Interrupted, want.Interrupted) || got.OwnTurnInterrupted {
		t.Errorf("payload = %+v, want %+v", got, want)
	}
}

// restartEnv is a parent subscribed (settled, repeat: --notify) to two busy children,
// and a third busy thread no one watches; nothing has stopped yet.
type restartEnv struct {
	*env
	parent        Thread
	kids          []Thread
	loner         Thread
	subA, subB    string
	restartMutate []func(*Options)
}

func newRestartEnv(t *testing.T, mutate ...func(*Options)) *restartEnv {
	t.Helper()
	r := &restartEnv{env: newFixtureEnvAt(t, hangFixture(t), nil, mutate...), restartMutate: mutate}
	r.parent = r.stopped("Orchestrator")
	for _, name := range []string{"Tests", "Docs"} {
		k := r.create(CreateOptions{Name: name, InitialPrompt: "go", CreatedBy: r.parent.ID, Notify: true})
		r.kids = append(r.kids, r.waitFor(k.ID, "busy", func(s Thread) bool { return s.Status == StatusBusy }))
	}
	r.loner = r.create(CreateOptions{Name: "Loner", InitialPrompt: "go"})
	// Connected: its message went out (a first message never sent is not a turn to resume).
	r.waitFor(r.loner.ID, "busy", func(s Thread) bool { return s.Status == StatusBusy && s.State == StateConnected })
	subs, err := r.m.Subscriptions(r.ctx(), r.parent.ID)
	if err != nil || len(subs) != 2 {
		t.Fatalf("subscriptions = %+v, %v", subs, err)
	}
	r.subA, r.subB = subs[0].ID, subs[1].ID
	return r
}

// A busy child the daemon's stop interrupts: its parent's wake is recorded at the stop
// and goes at the next start, with the restart notice, as one message; only once.
func TestRestartWakesDelivered(t *testing.T) {
	r := newRestartEnv(t)
	r.restart(r.restartMutate...)
	for _, id := range []string{r.subA, r.subB} {
		if s, ok := r.subscription(id); !ok || s.SuppressedAt.IsZero() || s.FiredCount != 0 {
			t.Fatalf("after the stop, %s = %+v (%v): want a suppressed fire, not counted", id, s, ok)
		}
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(wakes(r.items(r.parent.ID).Items)); n != 0 {
		t.Fatalf("%d wakes before DeliverRestartWakes", n)
	}
	r.m.DeliverRestartWakes()
	items := r.waitItems(r.parent.ID, "the restart wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	if !strings.HasPrefix(w.WakeTitle, "The app restarted at ") ||
		!strings.Contains(w.WakeTitle, "; 2 of your child threads were interrupted: \"Tests\" ("+r.kids[0].ID+"), \"Docs\" ("+r.kids[1].ID+"); their sessions resume on your next send. 2 threads interrupted: Thread \"Tests\"") {
		t.Errorf("title = %s", w.WakeTitle)
	}
	var p struct {
		Kind  string            `json:"kind"`
		Wakes []json.RawMessage `json:"wakes"`
	}
	if err := json.Unmarshal([]byte(w.WakeJSON), &p); err != nil || p.Kind != "batch" || len(p.Wakes) != 3 {
		t.Fatalf("JSON (%v): %s", err, w.WakeJSON)
	}
	var notice wakeRestartPayload
	if err := json.Unmarshal(p.Wakes[0], &notice); err != nil || notice.Kind != "restart" || len(notice.Interrupted) != 2 ||
		notice.Subscriptions != 2 || notice.Interrupted[0].Reason != ReasonDaemonStopped {
		t.Errorf("notice (%v) = %+v", err, notice)
	}
	for _, id := range []string{r.subA, r.subB} {
		if s, ok := r.subscription(id); !ok || !s.SuppressedAt.IsZero() || s.FiredCount != 1 {
			t.Errorf("after delivery, %s = %+v (%v): want fired once, suppression cleared", id, s, ok)
		}
	}
	// No subscriptions, and its turn on the user's message was cut too: a notice of its
	// own (e10-1).
	lonerItems := r.waitItems(r.loner.ID, "the loner's notice", func(items []Item) bool { return len(wakes(items)) == 1 })
	if w := wakes(lonerItems)[0]; !strings.HasSuffix(w.WakeTitle, `; your own turn was interrupted while handling the user's message: "go".`) {
		t.Errorf("the unsubscribed thread's notice: %s", w.WakeTitle)
	}
	// Once per start.
	r.m.DeliverRestartWakes()
	time.Sleep(100 * time.Millisecond)
	if n := len(wakes(r.items(r.parent.ID).Items)); n != 1 {
		t.Errorf("wakes after a second call = %d, want 1", n)
	}

	// Another restart: the children were told about already. The parent, started by its
	// wake and busy, was cut this time: a notice alone.
	r.waitFor(r.parent.ID, "the parent working", func(s Thread) bool { return s.Status == StatusBusy })
	r.restart(r.restartMutate...)
	r.m.DeliverRestartWakes()
	items = r.waitItems(r.parent.ID, "the second restart's wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	if w := wakes(items)[1]; !strings.HasSuffix(w.WakeTitle, "; your own turn was interrupted; none of your child threads were interrupted.") ||
		!strings.Contains(w.WakeJSON, `"kind": "restart"`) {
		t.Errorf("second restart's wake: %s\n%s", w.WakeTitle, w.WakeJSON)
	}
}

// A crash records nothing at its stop: a child left busy is loaded interrupted
// ("daemon restarted") and its subscriber hears it all the same.
func TestRestartWakesAfterCrash(t *testing.T) {
	r := newRestartEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := r.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	// What a crash leaves: the rows as last published (busy, connected), nothing
	// suppressed.
	for _, k := range r.kids {
		k.State, k.Status, k.StatusReason, k.DisconnectReason = StateConnected, StatusBusy, "working", ""
		if err := saveThread(context.Background(), r.m.opts.DB, k); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.m.opts.DB.Exec(`UPDATE thread_subscriptions SET suppressed_at = 0`); err != nil {
		t.Fatal(err)
	}
	r.open(r.restartMutate...)
	r.m.DeliverRestartWakes()
	items := r.waitItems(r.parent.ID, "the restart wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	if !strings.Contains(w.WakeTitle, "2 of your child threads were interrupted") || !strings.Contains(w.WakeJSON, `"reason": "daemon restarted"`) {
		t.Errorf("wake: %s\n%s", w.WakeTitle, w.WakeJSON)
	}
}

// A thread archived between the restart and the delivery is left out of the message;
// one archived before is not planned at all (its subscriptions went with it).
func TestRestartWakesSkipArchived(t *testing.T) {
	r := newRestartEnv(t, func(o *Options) { o.WakeBatch = 300 * time.Millisecond })
	r.restart(r.restartMutate...)
	r.m.DeliverRestartWakes()
	if _, err := r.m.Archive(r.ctx(), r.kids[1].ID, true); err != nil {
		t.Fatal(err)
	}
	items := r.waitItems(r.parent.ID, "the restart wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	if !strings.Contains(w.WakeTitle, "1 of your child threads was interrupted: \"Tests\"") || strings.Contains(w.WakeTitle, "Docs") {
		t.Errorf("title = %s", w.WakeTitle)
	}
}
