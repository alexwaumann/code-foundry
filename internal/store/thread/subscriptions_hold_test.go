package thread

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// heldLeadWake: a settled subscription, a plain turn end, no current done, failed or
// blocked report, children working when it fired. A report that is missing, a
// progress one, or one older than the last message (whatever its status) is held.
func TestHeldLeadWake(t *testing.T) {
	progress := Report{Status: ReportProgress, Summary: "2 workers started"}
	lead := func(s step, rep Report) Thread {
		return Thread{ID: "s-l", State: s.st, Status: s.status, StatusReason: s.reason, Report: rep}
	}
	working := wakeChildren{Working: 2, Total: 2}
	repeat := Subscription{Condition: CondSettled, Repeat: true}
	waiting := step{StateConnected, StatusIdle, waitingReason(2), ""}
	tests := []struct {
		name string
		sub  Subscription
		t    Thread
		d    wakeDetail
		want bool
	}{
		{"progress, workers working", repeat, lead(finished, progress), wakeDetail{children: working}, true},
		{"idle at its prompt", repeat, lead(atPrompt, progress), wakeDetail{children: working}, true},
		{"shown waiting on its workers", repeat, lead(waiting, progress), wakeDetail{children: working}, true},
		{"a stopped lead at its prompt", repeat, lead(offIdle, progress), wakeDetail{children: working}, true},
		{"no report (its first turn)", repeat, lead(finished, Report{}), wakeDetail{children: working, noReport: true}, true},
		{"a stale progress report", repeat, lead(finished, progress), wakeDetail{children: working, staleReport: true}, true},
		{"a stale done report", repeat, lead(finished, Report{Status: ReportDone}), wakeDetail{children: working, staleReport: true}, true},
		{"a one-shot", Subscription{Condition: CondSettled}, lead(finished, progress), wakeDetail{children: working}, true},
		{"its workers all settled", repeat, lead(finished, progress), wakeDetail{children: wakeChildren{Total: 2, Reported: 2}}, false},
		{"a done report", repeat, lead(finished, Report{Status: ReportDone}), wakeDetail{children: working}, false},
		{"a failed report", repeat, lead(finished, Report{Status: ReportFailed}), wakeDetail{children: working}, false},
		{"a blocked report", repeat, lead(finished, Report{Status: ReportBlocked}), wakeDetail{children: working}, false},
		{"a permission prompt", repeat, lead(askBash, progress), wakeDetail{children: working}, false},
		{"an error", repeat, lead(crashed, progress), wakeDetail{children: working}, false},
		{"its budget", repeat, lead(budget, progress), wakeDetail{children: working}, false},
		{"an idle subscription", Subscription{Condition: CondIdle, Repeat: true}, lead(finished, progress), wakeDetail{children: working}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := heldLeadWake(threadWakePart{sub: tt.sub, t: tt.t, d: tt.d}); got != tt.want {
				t.Errorf("held = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTeamWorking(t *testing.T) {
	th := func(id, by string, s step) Thread {
		return Thread{ID: id, CreatedBy: by, State: s.st, Status: s.status, StatusReason: s.reason}
	}
	waiting := step{StateConnected, StatusIdle, waitingReason(1), ""}
	archived := th("w-arch", "l", busy)
	archived.ArchivedAt = time.Now()
	removing := th("w-rm", "l", finished)
	removing.Removing = true
	tests := []struct {
		name    string
		threads []Thread
		want    int
	}{
		{"none", nil, 0},
		{"busy and settled", []Thread{th("w-1", "l", busy), th("w-2", "l", finished), th("w-3", "l", askBash)}, 1},
		{"archived: not counted; removing: working", []Thread{archived, removing}, 1},
		{"a child shown waiting", []Thread{th("w-1", "l", waiting)}, 1},
		{"a sub-lead with a worker running", []Thread{th("w-1", "l", finished), th("x-1", "w-1", busy)}, 1},
		{"a sub-lead whose workers settled", []Thread{th("w-1", "l", finished), th("x-1", "w-1", finished)}, 0},
		{"a cycle ends", []Thread{th("w-1", "l", finished), th("l", "w-1", finished)}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := teamWorking("l", childIndex(tt.threads)); got != tt.want {
				t.Errorf("teamWorking = %d, want %d", got, tt.want)
			}
		})
	}
}

// leadEnv is a top thread subscribed (settled, repeat) to a lead with three busy
// workers the lead is not subscribed to, on a fake clock.
type leadEnv struct {
	*env
	clock   *atomic.Int64
	top     Thread
	lead    Thread
	workers []Thread
	sub     string
}

func newLeadEnv(t *testing.T) *leadEnv {
	t.Helper()
	clock := &atomic.Int64{}
	clock.Store(time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC).UnixNano())
	l := &leadEnv{clock: clock, env: newEnv(t, func(o *Options) { o.Now = func() time.Time { return time.Unix(0, clock.Load()).UTC() } })}
	l.top, l.lead = l.stopped("top"), l.stopped("lead")
	for _, name := range []string{"w1", "w2", "w3"} {
		w := l.stopped(name)
		if _, ok := l.m.update(w.ID, false, func(rec *record) { rec.s.CreatedBy = l.lead.ID }); !ok {
			t.Fatal("no worker")
		}
		l.setStep(w.ID, busy)
		l.workers = append(l.workers, w)
	}
	l.setStep(l.lead.ID, busy)
	res, err := l.m.Subscribe(l.ctx(), SubscribeOptions{SubscriberID: l.top.ID, TargetThreadID: l.lead.ID, Repeat: true})
	if err != nil {
		t.Fatal(err)
	}
	l.sub = res.Subscription.ID
	return l
}

func (l *leadEnv) tick(d time.Duration) { l.clock.Add(int64(d)) }

func (l *leadEnv) report(st ReportStatus) {
	l.t.Helper()
	if _, err := l.m.Report(l.ctx(), l.lead.ID, Report{Status: st, Summary: st.String()}); err != nil {
		l.t.Fatal(err)
	}
}

// settled waits until the wake fired n times has been held or sent: FiredCount n, and
// the subscriber's queue empty.
func (l *leadEnv) settled(n int) {
	l.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, _ := l.subscription(l.sub)
		s := l.m.subs
		s.mu.Lock()
		_, queued := s.queues[l.top.ID]
		s.mu.Unlock()
		if got.FiredCount == n && !queued {
			return
		}
		if time.Now().After(deadline) {
			l.t.Fatalf("fired %d (want %d), queued %v", got.FiredCount, n, queued)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (l *leadEnv) held() bool {
	s := l.m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.held[l.lead.ID]) > 0
}

// The hold rule end to end: how the lead's turn ends decides whether the top thread is
// woken while the workers run; settling them releases a held wake, once.
func TestLeadWakeHeld(t *testing.T) {
	tests := []struct {
		name string
		// end ends the lead's turn (it is busy, its workers too).
		end func(l *leadEnv)
		// settle is how many workers then settle.
		settle int
		// wakes to top: after the lead's turn ended, then after the workers settled;
		// title is in the last one's header.
		during, after int
		title         string
	}{
		{"no report, its first turn", func(l *leadEnv) { l.setStep(l.lead.ID, finished) }, 3, 0, 1, "finished without a report."},
		{"a stale report", func(l *leadEnv) {
			l.report(ReportProgress)
			l.tick(time.Second)
			l.putItems(l.lead.ID, Item{ID: "u1", Kind: KindUserMessage, Text: "a worker's wake", CreatedAt: l.m.opts.Now()},
				Item{ID: "a1", Kind: KindAssistantText, Text: "One worker left.", CreatedAt: l.m.opts.Now()})
			l.setStep(l.lead.ID, finished)
		}, 3, 0, 1, "(report is from before its last message)"},
		{"a fresh progress report", func(l *leadEnv) {
			l.report(ReportProgress)
			l.setStep(l.lead.ID, finished)
		}, 3, 0, 1, "Report: progress — progress."},
		{"the last child settles: two of three are not enough", func(l *leadEnv) {
			l.report(ReportProgress)
			l.setStep(l.lead.ID, finished)
		}, 2, 0, 0, ""},
		{"the lead's pending request goes at once", func(l *leadEnv) { l.setStep(l.lead.ID, askBash) }, 3, 1, 1, "permission: Bash ls"},
		{"the lead failed", func(l *leadEnv) {
			l.report(ReportFailed)
			l.setStep(l.lead.ID, finished)
		}, 3, 1, 1, "Report: failed — failed."},
		{"the lead crashed", func(l *leadEnv) { l.setStep(l.lead.ID, crashed) }, 3, 1, 1, "interrupted"},
		{"the lead reports done", func(l *leadEnv) {
			l.report(ReportDone)
			l.setStep(l.lead.ID, finished)
		}, 3, 1, 1, "Report: done — done."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := newLeadEnv(t)
			tt.end(l)
			l.settled(1)
			if got := len(wakes(l.items(l.top.ID).Items)); got != tt.during {
				t.Fatalf("wakes while the workers run = %d, want %d", got, tt.during)
			}
			if held := l.held(); held != (tt.during == 0) {
				t.Errorf("held = %v", held)
			}
			for _, w := range l.workers[:tt.settle] {
				l.tick(time.Second)
				l.setStep(w.ID, finished)
			}
			l.waitItems(l.top.ID, "the wakes", func(items []Item) bool { return len(wakes(items)) == tt.after })
			time.Sleep(50 * time.Millisecond) // nothing more comes
			items := l.items(l.top.ID).Items
			ws := wakes(items)
			if len(ws) != tt.after {
				t.Fatalf("wakes = %d, want %d:\n%s", len(ws), tt.after, describeItems(items))
			}
			if tt.after > 0 && !strings.Contains(ws[len(ws)-1].WakeTitle, tt.title) {
				t.Errorf("last wake = %s\nwant it to have %q", ws[len(ws)-1].WakeTitle, tt.title)
			}
			if got, _ := l.subscription(l.sub); got.FiredCount != 1 {
				t.Errorf("fired %d times, want 1 (a release is the held fire's delivery)", got.FiredCount)
			}
			if l.held() != (tt.after == 0) {
				t.Errorf("held = %v after the workers", l.held())
			}
		})
	}
}

// A held wake goes once a lead's team settled while the lead stayed quiet; a fire of
// the same subscription replaces it (the lead woke and settled again).
func TestLeadWakeReplacedByNextSettle(t *testing.T) {
	l := newLeadEnv(t)
	l.setStep(l.lead.ID, finished)
	l.settled(1)
	if !l.held() {
		t.Fatal("not held")
	}
	// The lead works again (a worker's wake, the user), so it is not quiet: settling
	// the workers releases nothing; its next settle wakes the top thread, once.
	l.setStep(l.lead.ID, busy)
	for _, w := range l.workers {
		l.setStep(w.ID, finished)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(wakes(l.items(l.top.ID).Items)); n != 0 {
		t.Fatalf("a busy lead's held wake went: %d wakes", n)
	}
	l.report(ReportDone)
	l.setStep(l.lead.ID, finished)
	l.settled(2)
	items := l.waitItems(l.top.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	time.Sleep(50 * time.Millisecond)
	if ws := wakes(l.items(l.top.ID).Items); len(ws) != 1 || !strings.Contains(ws[0].WakeTitle, "Report: done") {
		t.Errorf("wakes:\n%s", describeItems(items))
	}
	if l.held() {
		t.Error("still held")
	}
}

// Unsubscribing, or archiving the top thread, drops a held wake: it is never sent.
func TestLeadWakeHeldForgotten(t *testing.T) {
	for _, drop := range []string{"unsubscribe", "archive the top thread"} {
		t.Run(drop, func(t *testing.T) {
			l := newLeadEnv(t)
			l.setStep(l.lead.ID, finished)
			l.settled(1)
			switch drop {
			case "unsubscribe":
				if _, err := l.m.Unsubscribe(l.ctx(), UnsubscribeOptions{ID: l.sub}); err != nil {
					t.Fatal(err)
				}
			default:
				if _, err := l.m.Archive(l.ctx(), l.top.ID, true); err != nil {
					t.Fatal(err)
				}
			}
			if l.held() {
				t.Error("still held")
			}
			for _, w := range l.workers {
				l.setStep(w.ID, finished)
			}
			time.Sleep(50 * time.Millisecond)
			if n := len(wakes(l.items(l.top.ID).Items)); n != 0 {
				t.Errorf("%d wakes", n)
			}
		})
	}
}

// The realistic flow: a lead subscribed to its three workers (--notify) is woken by
// each and settles after each turn; its parent is woken once, after the last.
func TestLeadSubscribedToWorkers(t *testing.T) {
	e := newEnv(t)
	top, lead := e.stopped("top"), e.stopped("lead")
	var workers []Thread
	for _, name := range []string{"w1", "w2", "w3"} {
		w := e.stopped(name)
		if _, ok := e.m.update(w.ID, false, func(rec *record) { rec.s.CreatedBy = lead.ID }); !ok {
			t.Fatal("no worker")
		}
		e.setStep(w.ID, busy)
		if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: lead.ID, TargetThreadID: w.ID, Repeat: true}); err != nil {
			t.Fatal(err)
		}
		workers = append(workers, w)
	}
	e.setStep(lead.ID, busy)
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: top.ID, TargetThreadID: lead.ID, Repeat: true})
	if err != nil {
		t.Fatal(err)
	}
	// Its first turn ends (no process: a wake starts one); shown waiting on 3 child
	// threads.
	e.setStep(lead.ID, step{StateDisconnected, StatusNeedsAttention, "finished", ""})
	for i, w := range workers {
		e.setStep(w.ID, finished)
		// The wake starts a lead turn (the fake answers it) that ends.
		e.waitItems(lead.ID, "the lead's wake turn", func(items []Item) bool { return len(wakes(items)) == i+1 })
		e.waitFor(lead.ID, "the lead settled", func(s Thread) bool { return Meets(CondSettled, s) && s.State == StateConnected })
		// The fake replays one turn per process: the next wake starts another.
		if err := e.m.Close(e.ctx(), lead.ID); err != nil {
			t.Fatal(err)
		}
		e.waitFor(lead.ID, "the lead stopped", func(s Thread) bool { return s.State == StateDisconnected })
		time.Sleep(50 * time.Millisecond)
		want := 0
		if i == len(workers)-1 {
			want = 1
			e.waitItems(top.ID, "the top wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		}
		if n := len(wakes(e.items(top.ID).Items)); n != want {
			t.Fatalf("after worker %d: %d top wakes, want %d", i+1, n, want)
		}
	}
	got, _ := e.subscription(res.Subscription.ID)
	if got.FiredCount < 4 {
		t.Errorf("the lead's subscription fired %d times, want a settle per turn", got.FiredCount)
	}
	if w := wakes(e.items(top.ID).Items)[0]; strings.Contains(w.WakeTitle, "still working") {
		t.Errorf("wake = %s", w.WakeTitle)
	}
}
