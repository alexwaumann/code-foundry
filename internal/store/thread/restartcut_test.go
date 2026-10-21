package thread

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestReportCoversTurn(t *testing.T) {
	t0 := time.Date(2026, 10, 21, 1, 22, 35, 0, time.UTC)
	user := func(at time.Time, origin MessageOrigin) Item {
		return Item{Kind: KindUserMessage, CreatedAt: at, Origin: origin}
	}
	rep := func(st ReportStatus, at time.Time) Report { return Report{Status: st, Summary: "x", At: at} }
	tests := []struct {
		name  string
		rep   Report
		items []Item
		want  bool
	}{
		{"done after the last message", rep(ReportDone, t0), []Item{user(t0.Add(-time.Minute), OriginUser)}, true},
		{"failed after it", rep(ReportFailed, t0), []Item{user(t0.Add(-time.Minute), OriginUser)}, true},
		{"blocked after it", rep(ReportBlocked, t0), []Item{user(t0.Add(-time.Minute), OriginUser)}, true},
		{"after a wake, too", rep(ReportDone, t0), []Item{user(t0.Add(-time.Minute), OriginWake)}, true},
		{"the same millisecond", rep(ReportDone, t0), []Item{user(t0.Add(400*time.Microsecond), OriginUser)}, true},
		{"progress is not final", rep(ReportProgress, t0), []Item{user(t0.Add(-time.Minute), OriginUser)}, false},
		{"no report", Report{}, []Item{user(t0.Add(-time.Minute), OriginUser)}, false},
		{"before the last message", rep(ReportDone, t0), []Item{user(t0.Add(-time.Hour), OriginUser), user(t0.Add(time.Minute), OriginUser)}, false},
		{"a subagent's message is not the thread's", rep(ReportDone, t0),
			[]Item{user(t0.Add(-time.Minute), OriginUser), {Kind: KindUserMessage, CreatedAt: t0.Add(time.Minute), ParentToolUseID: "tu"}}, true},
		{"no message", rep(ReportDone, t0), nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := reportCoversTurn(tt.rep, tt.items); got != tt.want {
				t.Errorf("reportCoversTurn = %v, want %v", got, tt.want)
			}
		})
	}
}

// Who gets a restart notice for a cut turn of its own (e10-1), and the fires about
// threads the daemon's death cut after their final report (e10-7).
func TestPlanRestartWakesCutTurns(t *testing.T) {
	t0 := time.Date(2026, 10, 21, 1, 24, 6, 0, time.UTC)
	now := t0.Add(time.Second)
	cut := func(id string) Thread {
		return Thread{ID: id, State: StateDisconnected, Status: StatusError, StatusReason: ReasonInterrupted,
			DisconnectReason: ReasonDaemonStopped, StatusChangedAt: t0}
	}
	unsent := cut("n")
	unsent.PendingFirst = &PendingFirst{Text: "go", Prompt: "go"}
	reported := Thread{ID: "r", State: StateDisconnected, Status: StatusNeedsAttention, StatusReason: "finished",
		DisconnectReason: ReasonDaemonRestarts, StatusChangedAt: t0, Report: Report{Status: ReportDone, At: t0.Add(-time.Second)}}
	idle := Thread{ID: "p", State: StateDisconnected, Status: StatusIdle, StatusReason: "at prompt"}
	threads := map[string]Thread{}
	for _, th := range []Thread{cut("e"), cut("w"), cut("l"), unsent, reported, idle} {
		threads[th.ID] = th
	}
	lookup := func(id string) (Thread, bool) { th, ok := threads[id]; return th, ok }
	sub := func(id, subscriber, target string) Subscription {
		return Subscription{ID: id, SubscriberID: subscriber, TargetKind: TargetThread, TargetID: target, Condition: CondSettled,
			Repeat: true, CreatedAt: t0.Add(-time.Hour)}
	}
	type plan struct {
		subscriber string
		fires      []string
		self       bool
		selfOnly   bool
	}
	tests := []struct {
		name     string
		subs     []Subscription
		reported map[string]bool
		cut      []string
		want     []plan
	}{
		{"a cut turn with no subscriptions: a notice alone", nil, nil, []string{"e"}, []plan{{"e", nil, true, true}}},
		{"a cut child its subscriber hears about: none of its own", []Subscription{sub("s1", "p", "w")}, nil, []string{"w"},
			[]plan{{"p", []string{"s1"}, false, false}}},
		{"a cut lead with subscriptions: its usual notice", []Subscription{sub("s1", "l", "p")}, nil, []string{"l"},
			[]plan{{"l", nil, true, false}}},
		{"a first message never sent: no notice", nil, nil, []string{"n"}, nil},
		{"not cut", nil, nil, []string{"p"}, nil},
		{"gone", nil, nil, []string{"gone"}, nil},
		{"reported at the death: its subscriber hears", []Subscription{sub("s1", "p", "r")}, map[string]bool{"r": true}, nil,
			[]plan{{"p", []string{"s1"}, false, false}}},
		{"reported, told already", []Subscription{func() Subscription { s := sub("s1", "p", "r"); s.LastFiredAt = t0.Add(time.Millisecond); return s }()},
			map[string]bool{"r": true}, nil, nil},
		{"finished at the stop but not cut after a report: nothing", []Subscription{sub("s1", "p", "r")}, nil, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plans, _ := planRestartWakes(restartInput{subs: tt.subs, thread: lookup, reported: tt.reported, cut: tt.cut}, now)
			var got []plan
			for _, p := range plans {
				g := plan{subscriber: p.subscriber, self: p.notice.self, selfOnly: p.selfOnly}
				for _, f := range p.fires {
					g.fires = append(g.fires, f.sub)
				}
				got = append(got, g)
			}
			if !slices.EqualFunc(got, tt.want, func(a, b plan) bool {
				return a.subscriber == b.subscriber && slices.Equal(a.fires, b.fires) && a.self == b.self && a.selfOnly == b.selfOnly
			}) {
				t.Errorf("plans = %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

// The notice for a cut turn: it quotes the user's message the turn was handling; a
// notice alone about a turn a wake started is not sent.
func TestRestartNoticeOwnTurn(t *testing.T) {
	at := time.Date(2026, 10, 21, 1, 24, 30, 0, time.UTC)
	user := func(text string, origin MessageOrigin) Item {
		return Item{Kind: KindUserMessage, Text: text, Origin: origin}
	}
	long := strings.Repeat("word ", 80)
	tests := []struct {
		name     string
		notice   restartNotice
		selfOnly bool
		items    []Item
		send     bool
		title    string
	}{
		{"no subscriptions, the user's message", restartNotice{at: at, self: true}, true,
			[]Item{user("old", OriginUser), {Kind: KindAssistantText, Text: "ok"}, user("Add a streak freeze\nto the stats page", OriginUser)}, true,
			`The app restarted at 01:24 UTC; your own turn was interrupted while handling the user's message: "Add a streak freeze to the stats page".`},
		{"no subscriptions, a wake's turn: not sent", restartNotice{at: at, self: true}, true,
			[]Item{user("go", OriginUser), user("[code-foundry wake] …", OriginWake)}, false, ""},
		{"no subscriptions, no message: not sent", restartNotice{at: at, self: true}, true, nil, false, ""},
		{"with subscriptions, the user's message", restartNotice{at: at, self: true, subscriptions: 2}, false,
			[]Item{user("Ship it", OriginUser)}, true,
			`The app restarted at 01:24 UTC; your own turn was interrupted while handling the user's message: "Ship it"; none of your child threads were interrupted.`},
		{"with subscriptions, a wake's turn: as before", restartNotice{at: at, self: true, subscriptions: 2}, false,
			[]Item{user("[code-foundry wake] …", OriginWake)}, true,
			`The app restarted at 01:24 UTC; your own turn was interrupted; none of your child threads were interrupted.`},
		{"a long message is cut", restartNotice{at: at, self: true}, true, []Item{user(long, OriginUser)}, true,
			`The app restarted at 01:24 UTC; your own turn was interrupted while handling the user's message: "` + oneLine(long, maxRestartMessage) + `".`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rw := &restartWakes{notice: tt.notice, selfOnly: tt.selfOnly}
			rw.ownTurn(tt.items)
			_, send := rw.keepLive(&Snapshot{}, nil)
			if send != tt.send {
				t.Fatalf("send = %v, want %v", send, tt.send)
			}
			if !send {
				return
			}
			msg := restartWake(rw.notice, nil)
			if msg.WakeTitle != tt.title {
				t.Errorf("title:\n got %s\nwant %s", msg.WakeTitle, tt.title)
			}
			if rw.notice.message != "" && !strings.Contains(msg.WakeJSON, `"own_turn_message": `) {
				t.Errorf("JSON has no own_turn_message: %s", msg.WakeJSON)
			}
		})
	}
}

// End to end: a thread with no subscriptions whose turn on the user's message the stop
// cut is told after the restart, quoting it (e10-1).
func TestRestartNoticeForACutTurn(t *testing.T) {
	e := newFixtureEnvAt(t, hangFixture(t), nil)
	s := e.create(CreateOptions{Name: "Ember", InitialPrompt: "Add a streak freeze"})
	e.waitFor(s.ID, "busy", func(s Thread) bool { return s.Status == StatusBusy && s.State == StateConnected })
	idle := e.connected(CreateOptions{Name: "Idle"})
	e.restart()
	e.m.DeliverRestartWakes()
	items := e.waitItems(s.ID, "the restart notice", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	if !strings.HasSuffix(w.WakeTitle, `; your own turn was interrupted while handling the user's message: "Add a streak freeze".`) ||
		!strings.Contains(w.WakeJSON, `"own_turn_interrupted": true`) {
		t.Errorf("notice: %s\n%s", w.WakeTitle, w.WakeJSON)
	}
	// It carries the restart's resume note, like any message after the stop.
	if !strings.HasPrefix(w.ResumeNote, "[code-foundry] Your previous turn was stopped because the Code Foundry app restarted") {
		t.Errorf("resume note %q", w.ResumeNote)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(wakes(e.items(idle.ID).Items)); n != 0 {
		t.Errorf("a thread at its prompt got %d wakes", n)
	}
}

// e10-7: a turn the stop cut after its final report finished: needs attention
// "finished", no resume note; its subscriber's wake after the restart says so.
func TestReportedBeforeTheStop(t *testing.T) {
	t.Run("a clean stop", func(t *testing.T) {
		r := newRestartEnv(t)
		done := r.kids[0]
		r.waitFor(done.ID, "its message sent", func(s Thread) bool { return s.State == StateConnected })
		if _, err := r.m.Report(r.ctx(), done.ID, Report{Status: ReportDone, Summary: "streak freeze shipped"}); err != nil {
			t.Fatal(err)
		}
		r.restart(r.restartMutate...)
		got, _ := r.m.Get(r.ctx(), done.ID)
		if got.Status != StatusNeedsAttention || got.StatusReason != "finished" || got.ResumeNote.Pending() {
			t.Fatalf("reported, then stopped: %v %q, note %+v", got.Status, got.StatusReason, got.ResumeNote)
		}
		if other, _ := r.m.Get(r.ctx(), r.kids[1].ID); other.StatusReason != ReasonInterrupted {
			t.Errorf("the unreported child: %q", other.StatusReason)
		}
		r.m.DeliverRestartWakes()
		items := r.waitItems(r.parent.ID, "the restart wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		w := wakes(items)[0].WakeTitle
		if !strings.Contains(w, `1 of your child threads was interrupted: "Docs"`) ||
			!strings.Contains(w, `Thread "Tests" (`+done.ID+`) needs attention: finished`) || !strings.Contains(w, "Report: done — streak freeze shipped.") {
			t.Errorf("wake: %s", w)
		}
	})
	t.Run("the daemon died", func(t *testing.T) {
		r := newRestartEnv(t)
		done := r.kids[0]
		r.waitFor(done.ID, "its message sent", func(s Thread) bool { return s.State == StateConnected })
		if _, err := r.m.Report(r.ctx(), done.ID, Report{Status: ReportDone, Summary: "streak freeze shipped"}); err != nil {
			t.Fatal(err)
		}
		live, _ := r.m.Get(r.ctx(), done.ID)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := r.m.Shutdown(ctx); err != nil {
			t.Fatal(err)
		}
		// What a crash leaves: the row as last published (busy, connected), nothing
		// suppressed.
		if err := saveThread(context.Background(), r.m.opts.DB, live); err != nil {
			t.Fatal(err)
		}
		if _, err := r.m.opts.DB.Exec(`UPDATE thread_subscriptions SET suppressed_at = 0`); err != nil {
			t.Fatal(err)
		}
		r.open(r.restartMutate...)
		got, _ := r.m.Get(r.ctx(), done.ID)
		if got.Status != StatusNeedsAttention || got.StatusReason != "finished" || got.ResumeNote.Pending() {
			t.Fatalf("reported, then the daemon died: %v %q, note %+v", got.Status, got.StatusReason, got.ResumeNote)
		}
		r.m.DeliverRestartWakes()
		items := r.waitItems(r.parent.ID, "the restart wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		if w := wakes(items)[0].WakeTitle; !strings.Contains(w, `Thread "Tests" (`+done.ID+`) needs attention: finished`) {
			t.Errorf("wake: %s", w)
		}
	})
}
