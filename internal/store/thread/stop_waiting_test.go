package thread

import (
	"errors"
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

func TestStopWaitingUnknownThread(t *testing.T) {
	e := newEnv(t)
	if _, err := e.m.StopWaiting(e.ctx(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
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

// A queued wake goes too: it must not start a turn after the user stopped waiting.
func TestStopWaitingDropsQueuedWakes(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.WakeBatch = time.Hour })
	top := e.stopped("top")
	s := e.m.subs
	s.mu.Lock()
	s.queues[top.ID] = &wakeQueue{items: []delivery{{sub: "sub-x"}}, running: true}
	s.mu.Unlock()
	if _, err := e.m.StopWaiting(e.ctx(), top.ID); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if n := len(s.queues[top.ID].items); n != 0 {
		t.Errorf("%d wakes still queued", n)
	}
	delete(s.queues, top.ID)
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
