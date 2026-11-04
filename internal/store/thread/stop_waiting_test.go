package thread

import (
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

// stopSubIDs are the ids of subs.
func stopSubIDs(subs []Subscription) []string {
	out := make([]string, len(subs))
	for i, s := range subs {
		out[i] = s.ID
	}
	return out
}

// StopWaiting takes every kind of subscription of the thread, a repeat one too, leaves
// other threads' alone and ends the waiting it held up. The target is not stopped.
func TestStopWaitingRemovesTheWakes(t *testing.T) {
	l := newLeadEnv(t)
	other := l.stopped("other")
	l.tick(time.Second) // listing order is creation order
	timer, err := l.m.Subscribe(l.ctx(), SubscribeOptions{SubscriberID: l.top.ID, TargetEvery: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := l.m.Subscribe(l.ctx(), SubscribeOptions{SubscriberID: other.ID, TargetThreadID: l.lead.ID})
	if err != nil {
		t.Fatal(err)
	}
	l.setStep(l.top.ID, finished)
	l.waitFor(l.top.ID, "waiting on the lead", func(s Thread) bool { return s.StatusReason == "waiting on 1 child thread" })

	res, err := l.m.StopWaiting(l.ctx(), l.top.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := stopSubIDs(res.Removed), []string{l.sub, timer.Subscription.ID}; !slices.Equal(got, want) {
		t.Errorf("removed %v, want %v", got, want)
	}
	if res.Thread.Status != StatusNeedsAttention || res.Thread.StatusReason != "finished" {
		t.Errorf("thread %s %q, want the turn's end", res.Thread.Status, res.Thread.StatusReason)
	}
	left, err := l.m.Subscriptions(l.ctx(), "")
	if err != nil {
		t.Fatal(err)
	}
	if got := stopSubIDs(left); !slices.Equal(got, []string{theirs.Subscription.ID}) {
		t.Errorf("left %v, want the other thread's only", got)
	}
	if lead, _ := l.m.Snapshot().Thread(l.lead.ID); lead.Status != StatusBusy {
		t.Errorf("lead %s, want it still working", lead.Status)
	}
	l.setStep(l.lead.ID, finished)
	time.Sleep(50 * time.Millisecond)
	if n := len(wakes(l.items(l.top.ID).Items)); n != 0 {
		t.Errorf("%d wakes after stopping", n)
	}
}

// A resident thread refuses, leaving its wakes alone: they run its board.
func TestStopWaitingRefuses(t *testing.T) {
	e := newEnv(t)
	resident, _, err := e.m.EnsureResident(e.ctx(), "ember", ResidentOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	plain := e.stopped("plain")
	tests := []struct {
		name    string
		id      string
		want    error
		wantMsg string
		left    int
	}{
		{name: "an ordinary thread", id: plain.ID},
		{name: "a resident thread", id: resident.ID, want: ErrFailedPrecondition, wantMsg: "resident ember thread", left: 1},
		{name: "an unknown thread", id: "nope", want: ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.id != "nope" {
				if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: tt.id, TargetEvery: time.Hour}); err != nil {
					t.Fatal(err)
				}
			}
			_, err := e.m.StopWaiting(e.ctx(), tt.id)
			if !errors.Is(err, tt.want) || (tt.wantMsg != "" && !strings.Contains(err.Error(), tt.wantMsg)) {
				t.Fatalf("err = %v, want %v naming %q", err, tt.want, tt.wantMsg)
			}
			if tt.id == "nope" {
				return
			}
			if subs, err := e.m.Subscriptions(e.ctx(), tt.id); err != nil || len(subs) != tt.left {
				t.Errorf("left %d subscriptions (%v), want %d", len(subs), err, tt.left)
			}
		})
	}
}

// batchWindow is a real batch window: long enough to act inside it under -race.
const batchWindow = time.Second

func withBatchWindow(o *Options) { o.WakeBatch = batchWindow }

// inWindow waits until the drain took a wake to id off the queue and holds it in the
// batch window.
func inWindow(t *testing.T, e *env, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s := e.m.subs
		s.mu.Lock()
		q := s.queues[id]
		open := q != nil && len(q.taken) > 0
		s.mu.Unlock()
		if open {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("no wake in its batch window")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// drained waits until no wake to id is left in its queue, the batch window included.
func drained(t *testing.T, e *env, id string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		s := e.m.subs
		s.mu.Lock()
		_, busy := s.queues[id]
		s.mu.Unlock()
		if !busy {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the queue did not drain")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The ways of taking back a wake that already fired and waits out its batch window.
var takeBacks = []struct {
	name string
	take func(t *testing.T, e *env, top, target, sub string) []string
}{
	{"stop waiting", func(t *testing.T, e *env, top, _, _ string) []string {
		res, err := e.m.StopWaiting(e.ctx(), top)
		if err != nil {
			t.Fatal(err)
		}
		return stopSubIDs(res.Removed)
	}},
	{"the row's x, by id", func(t *testing.T, e *env, _, _, sub string) []string {
		gone, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{ID: sub})
		if err != nil {
			t.Fatal(err)
		}
		return stopSubIDs(gone)
	}},
	{"unsubscribe by target", func(t *testing.T, e *env, top, target, _ string) []string {
		gone, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{SubscriberID: top, TargetThreadID: target})
		if err != nil {
			t.Fatal(err)
		}
		return stopSubIDs(gone)
	}},
}

// Scenario A: a child settles and, inside the window, the user takes the wake back. It
// never goes, for a one-shot (nothing but the wake is left of it) or a repeat one, the
// wake limit slot comes back, and the thread stops reading waiting at once.
func TestWakeTakenBackInTheBatchWindow(t *testing.T) {
	for _, tt := range takeBacks {
		for _, repeat := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s repeat=%t", tt.name, repeat), func(t *testing.T) {
				e := newEnv(t, withBatchWindow)
				top, child := e.stopped("top"), e.stopped("child")
				e.setStep(child.ID, busy)
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: top.ID, TargetThreadID: child.ID, Repeat: repeat})
				if err != nil {
					t.Fatal(err)
				}
				e.setStep(child.ID, finished)
				inWindow(t, e, top.ID)
				if gone := tt.take(t, e, top.ID, child.ID, res.Subscription.ID); !slices.Equal(gone, []string{res.Subscription.ID}) {
					t.Errorf("reported %v, want the subscription", gone)
				}
				if th, _ := e.m.Snapshot().Thread(top.ID); shownWaiting(th.Status, th.StatusReason) {
					t.Errorf("reads %q though nothing is coming", th.StatusReason)
				}
				drained(t, e, top.ID)
				time.Sleep(50 * time.Millisecond)
				if n := len(wakes(e.items(top.ID).Items)); n != 0 {
					t.Errorf("%d wakes after taking it back", n)
				}
				s := e.m.subs
				s.mu.Lock()
				defer s.mu.Unlock()
				if n := len(s.sent[top.ID]); n != 0 {
					t.Errorf("%d wake limit slots kept", n)
				}
			})
		}
	}
}

// Scenario B: the target is a lead with working children, so without the take-back the
// drain would hold the wake after the stop: the list would go from 0 rows to 1 and the
// thread be woken once the team settled, maybe hours later.
func TestLeadWakeTakenBackInTheBatchWindow(t *testing.T) {
	for _, tt := range takeBacks {
		t.Run(tt.name, func(t *testing.T) {
			l := newLeadEnv(t, withBatchWindow)
			l.setStep(l.lead.ID, finished)
			inWindow(t, l.env, l.top.ID)
			tt.take(t, l.env, l.top.ID, l.lead.ID, l.sub)
			drained(t, l.env, l.top.ID)
			if l.held() {
				t.Error("held after it was taken back")
			}
			if subs, _ := l.m.Subscriptions(l.ctx(), l.top.ID); len(subs) != 0 {
				t.Errorf("listed again: %v", stopSubIDs(subs))
			}
			for _, w := range l.workers {
				l.setStep(w.ID, finished)
			}
			time.Sleep(100 * time.Millisecond)
			drained(t, l.env, l.top.ID)
			if n := len(wakes(l.items(l.top.ID).Items)); n != 0 {
				t.Errorf("%d wakes once the team settled", n)
			}
		})
	}
}

// Taking one wake back leaves what the user did not take back: another subscription's in
// the same batch, and one that fires after a stop and joins the batch still open.
func TestTakeBackIsPerWake(t *testing.T) {
	titled := func(e *env, id string) []string {
		var out []string
		for _, w := range wakes(e.items(id).Items) {
			out = append(out, w.WakeTitle)
		}
		return out
	}
	tests := []struct {
		name string
		run  func(t *testing.T, e *env, top string, a, b Thread, sub func(Thread) string)
	}{
		{"unsubscribing one leaves the other in the batch", func(t *testing.T, e *env, top string, a, b Thread, sub func(Thread) string) {
			first := sub(a)
			sub(b)
			e.setStep(a.ID, finished)
			inWindow(t, e, top)
			e.setStep(b.ID, finished)
			if _, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{ID: first}); err != nil {
				t.Fatal(err)
			}
		}},
		{"a subscription made after the stop joins the open batch and goes", func(t *testing.T, e *env, top string, a, b Thread, sub func(Thread) string) {
			sub(a)
			e.setStep(a.ID, finished)
			inWindow(t, e, top)
			if _, err := e.m.StopWaiting(e.ctx(), top); err != nil {
				t.Fatal(err)
			}
			sub(b)
			e.setStep(b.ID, finished)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t, withBatchWindow)
			top, a, b := e.stopped("top"), e.stopped("about-a"), e.stopped("about-b")
			e.setStep(a.ID, busy)
			e.setStep(b.ID, busy)
			sub := func(target Thread) string {
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: top.ID, TargetThreadID: target.ID})
				if err != nil {
					t.Fatal(err)
				}
				return res.Subscription.ID
			}
			tt.run(t, e, top.ID, a, b, sub)
			e.waitItems(top.ID, "the wake", func(items []Item) bool { return len(wakes(items)) > 0 })
			drained(t, e, top.ID)
			got := titled(e, top.ID)
			if len(got) != 1 || !strings.Contains(got[0], "about-b") || strings.Contains(got[0], "about-a") {
				t.Errorf("wakes %q, want the one about b alone", got)
			}
		})
	}
}

// Without a take-back the same wake goes: the window above is a real one.
func TestBatchWindowDeliversUntouched(t *testing.T) {
	e := newEnv(t, withBatchWindow)
	top, child := e.stopped("top"), e.stopped("child")
	e.setStep(child.ID, busy)
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: top.ID, TargetThreadID: child.ID}); err != nil {
		t.Fatal(err)
	}
	e.setStep(child.ID, finished)
	inWindow(t, e, top.ID)
	e.waitItems(top.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
}

// A one-shot goes when it fires, but its wake can be held while the lead's team works.
// It is listed until the wake goes, and every way of dropping it drops it; wakes held for
// the lead's subscribers are not the lead's to drop.
func TestHeldOneShot(t *testing.T) {
	oneShot := func(t *testing.T) (*leadEnv, string) {
		t.Helper()
		l := newLeadEnv(t)
		if _, err := l.m.Unsubscribe(l.ctx(), UnsubscribeOptions{ID: l.sub}); err != nil {
			t.Fatal(err)
		}
		res, err := l.m.Subscribe(l.ctx(), SubscribeOptions{SubscriberID: l.top.ID, TargetThreadID: l.lead.ID})
		if err != nil {
			t.Fatal(err)
		}
		l.setStep(l.lead.ID, finished)
		deadline := time.Now().Add(5 * time.Second)
		for !l.held() {
			if time.Now().After(deadline) {
				t.Fatal("the wake was not held")
			}
			time.Sleep(5 * time.Millisecond)
		}
		return l, res.Subscription.ID
	}
	listed := func(t *testing.T, l *leadEnv) []string {
		t.Helper()
		subs, err := l.m.Subscriptions(l.ctx(), l.top.ID)
		if err != nil {
			t.Fatal(err)
		}
		return stopSubIDs(subs)
	}
	settle := func(l *leadEnv) {
		for _, w := range l.workers {
			l.setStep(w.ID, finished)
		}
	}
	tests := []struct {
		name string
		drop func(t *testing.T, l *leadEnv, sub string) []string
		// wakes to top once the workers settled.
		want int
	}{
		{"left alone it is listed, then goes out", func(*testing.T, *leadEnv, string) []string { return nil }, 1},
		{"unsubscribed by id", func(t *testing.T, l *leadEnv, sub string) []string {
			gone, err := l.m.Unsubscribe(l.ctx(), UnsubscribeOptions{ID: sub})
			if err != nil {
				t.Fatal(err)
			}
			return stopSubIDs(gone)
		}, 0},
		{"stop waiting", func(t *testing.T, l *leadEnv, _ string) []string {
			res, err := l.m.StopWaiting(l.ctx(), l.top.ID)
			if err != nil {
				t.Fatal(err)
			}
			return stopSubIDs(res.Removed)
		}, 0},
		{"the lead stops waiting: what is held for top stays", func(t *testing.T, l *leadEnv, _ string) []string {
			if _, err := l.m.StopWaiting(l.ctx(), l.lead.ID); err != nil {
				t.Fatal(err)
			}
			return nil
		}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l, sub := oneShot(t)
			if got := listed(t, l); !slices.Equal(got, []string{sub}) {
				t.Fatalf("listed %v, want the held one-shot", got)
			}
			if gone := tt.drop(t, l, sub); gone != nil {
				if !slices.Equal(gone, []string{sub}) {
					t.Errorf("removed %v", gone)
				}
				if got := listed(t, l); len(got) != 0 {
					t.Errorf("still listed: %v", got)
				}
			}
			settle(l)
			l.waitItems(l.top.ID, "the wakes", func(items []Item) bool { return len(wakes(items)) == tt.want })
			time.Sleep(50 * time.Millisecond)
			if got := len(wakes(l.items(l.top.ID).Items)); got != tt.want {
				t.Errorf("%d wakes, want %d", got, tt.want)
			}
			if got := listed(t, l); len(got) != 0 {
				t.Errorf("listed after it went: %v", got)
			}
		})
	}
}

// The thread's shells stop with its wakes, through the same path as thread.shell.stop:
// a stop note, the process group gone. One that cannot be found is an error naming it,
// and the wakes are gone all the same.
func TestStopWaitingStopsShells(t *testing.T) {
	const task = "by3gxdr0o"
	tests := []struct {
		name    string
		found   bool
		wantErr string
	}{
		{name: "the shell stops", found: true},
		{name: "its process group cannot be found", wantErr: task},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sleeper := exec.Command("sleep", "60")
			sleeper.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			if err := sleeper.Start(); err != nil {
				t.Fatal(err)
			}
			exited := make(chan error, 1)
			go func() { exited <- sleeper.Wait() }()
			t.Cleanup(func() { _ = sleeper.Process.Kill() })
			probe := &fakeServerProbe{groups: map[string]int{}}
			if tt.found {
				probe.groups[task] = sleeper.Process.Pid
			}
			e := newFixtureEnvAt(t, fixturePath("shells"), []string{"CF_FAKE_CLAUDE_UNPROMPTED=" + t.TempDir()},
				func(o *Options) { o.ServerProbe = probe })
			s := e.create(CreateOptions{InitialPrompt: "launch"})
			e.waitFor(s.ID, "the shell", func(s Thread) bool { return len(s.BackgroundShells) == 1 })
			if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: s.ID, TargetEvery: time.Hour}); err != nil {
				t.Fatal(err)
			}

			res, err := e.m.StopWaiting(e.ctx(), s.ID)
			if len(res.Removed) != 1 {
				t.Errorf("removed %d wakes, want 1", len(res.Removed))
			}
			if tt.wantErr != "" {
				if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want one naming %s", err, tt.wantErr)
				}
				if len(res.Shells) != 0 {
					t.Errorf("shells %v, want none stopped", res.Shells)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Shells) != 1 || res.Shells[0].TaskID != task {
				t.Errorf("shells %v", res.Shells)
			}
			select {
			case <-exited:
			case <-time.After(5 * time.Second):
				t.Fatal("the shell's process group still runs")
			}
			e.waitItems(s.ID, "the stop note", func(items []Item) bool {
				return slices.ContainsFunc(items, func(it Item) bool {
					return it.Kind == KindNote && strings.HasPrefix(it.Text, "Stopped background shell: ")
				})
			})
		})
	}
}
