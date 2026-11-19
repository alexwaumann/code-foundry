package thread

import (
	"errors"
	"testing"
	"time"
)

// Mark as unread against every way the thread may be seen afterwards (unread.go): it is
// "finished" as a turn that ended unseen, cleared the way that one is, except that the
// view already open when it was marked does not see it, running or stopped, until a new
// view, the focus or a message.
func TestMarkUnread(t *testing.T) {
	type step string
	const (
		watch      step = "watch"      // open a viewer (another one when one is open)
		unwatch    step = "unwatch"    // close the last viewer opened
		mark       step = "mark"       // MarkUnread
		focus      step = "focus"      // the thread gains the focus (FocusGained)
		attend     step = "attend"     // presence becomes attended
		leave      step = "leave"      // presence stops being attended
		send       step = "send"       // a message (the fixture answers only the first prompt: the turn runs on)
		stop       step = "stop"       // close the thread: its runner detaches
		restart    step = "restart"    // the daemon restarts
		isFinished step = "finished"   // the status is (and stays) NeedsAttention "finished"
		isIdle     step = "idle"       // the status becomes Idle "at prompt"
		isWorking  step = "is working" // a message started a turn (a stopped thread starts)
	)
	tests := []struct {
		name  string
		steps []step // after a first turn seen by an open viewer, while attended
	}{
		{"running, no view: marked, then opened: seen", []step{unwatch, mark, isFinished, watch, isIdle}},
		{"running, viewed: held, also when the user comes back; the focus: seen", []step{mark, isFinished, leave, attend, isFinished, focus, isIdle}},
		{"running, viewed: held; a second view: seen", []step{mark, isFinished, watch, isIdle}},
		{"running, viewed: held; closed and opened again: seen", []step{mark, isFinished, unwatch, isFinished, watch, isIdle}},
		{"running, viewed: held; a message ends it", []step{mark, isFinished, send, isWorking}},
		{"running, viewed: held across the stop and a restart; opened: seen", []step{mark, isFinished, stop, isFinished, restart, isFinished, watch, isIdle}},
		{"running, viewed while away: marked; a new view while away; the user comes back: seen", []step{leave, mark, isFinished, watch, isFinished, attend, isIdle}},
		{"running, viewed while away: the focus ends the hold; the user comes back: seen", []step{leave, mark, focus, isFinished, attend, isIdle}},
		{"stopped, no view: marked, kept across a restart, then opened: seen", []step{unwatch, stop, mark, isFinished, restart, isFinished, watch, isIdle}},
		{"stopped, viewed: held, also when the user comes back; the focus: seen", []step{stop, mark, isFinished, leave, attend, isFinished, focus, isIdle}},
		{"stopped, viewed: held; a second view: seen", []step{stop, mark, isFinished, watch, isIdle}},
		{"stopped, viewed: held; a message starts it", []step{stop, mark, isFinished, send, isWorking}},
		{"stopped, no view: the focus with no view keeps it", []step{unwatch, stop, mark, focus, isFinished}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, att := attendedEnv(t, true)
			s := e.create(CreateOptions{InitialPrompt: "a table please"})
			cancels := []func(){openViewer(t, e, s.ID)}
			e.waitItems(s.ID, "turn end", hasTurnEnd)
			e.waitFor(s.ID, "the first turn seen", isIdleStatus)
			for _, st := range tt.steps {
				switch st {
				case watch:
					cancels = append(cancels, openViewer(t, e, s.ID))
				case unwatch:
					n := e.m.viewerCount(s.ID)
					cancels[len(cancels)-1]()
					cancels = cancels[:len(cancels)-1]
					deadline := time.Now().Add(5 * time.Second)
					for e.m.viewerCount(s.ID) >= n {
						if time.Now().After(deadline) {
							t.Fatal("the viewer never left")
						}
						time.Sleep(5 * time.Millisecond)
					}
				case mark:
					got, err := e.m.MarkUnread(e.ctx(), s.ID)
					if err != nil {
						t.Fatal(err)
					}
					if !isFinishedStatus(got) {
						t.Fatalf("MarkUnread answered %s %q, want finished", got.Status, got.StatusReason)
					}
				case focus:
					e.m.FocusGained(s.ID)
				case attend:
					setAttended(e, att, true)
				case leave:
					setAttended(e, att, false)
				case send:
					if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "another table"}); err != nil {
						t.Fatal(err)
					}
				case stop:
					if err := e.m.Close(e.ctx(), s.ID); err != nil {
						t.Fatal(err)
					}
					e.waitFor(s.ID, "stopped", stopped)
				case restart:
					e.restart(func(o *Options) { o.Attended = att.Load })
					cancels = nil // the old manager's viewers went with it
				case isFinished:
					e.waitFor(s.ID, "finished", isFinishedStatus)
					time.Sleep(settle)
					if got, _ := e.m.Get(e.ctx(), s.ID); !isFinishedStatus(got) {
						t.Fatalf("%s: %s %q, want finished", st, got.Status, got.StatusReason)
					}
				case isIdle:
					e.waitFor(s.ID, "seen (idle)", isIdleStatus)
				case isWorking:
					e.waitFor(s.ID, "working", func(s Thread) bool { return s.Status == StatusBusy })
				}
			}
		})
	}
}

// Only an idle thread at its prompt can be marked: anything else is refused and keeps
// its status.
func TestMarkUnreadRefusals(t *testing.T) {
	tests := []struct {
		name string
		set  func(e *env, id string)
		why  string
	}{
		{"working", func(e *env, id string) { e.setStep(id, busy) }, "working"},
		{"starting", func(e *env, id string) {
			e.setStep(id, step{StateStarting, StatusUnknown, "starting", ""})
		}, "starting"},
		{"asking permission", func(e *env, id string) { e.setStep(id, offAsking) }, "waiting on an answer"},
		{"asking a question", func(e *env, id string) { e.setStep(id, askWhich) }, "waiting on an answer"},
		{"already Done", func(e *env, id string) { e.setStep(id, finished) }, "already unread"},
		{"a turn error", func(e *env, id string) {
			e.setStep(id, step{StateDisconnected, StatusNeedsAttention, "error: 529", ""})
		}, "needing attention (error: 529)"},
		{"woken from a snooze", func(e *env, id string) {
			e.setStep(id, step{StateDisconnected, StatusNeedsAttention, ReasonSnoozeEnded, ""})
		}, "needing attention (snooze ended)"},
		{"interrupted", func(e *env, id string) { e.setStep(id, crashed) }, "in error (interrupted)"},
		{"archived", func(e *env, id string) {
			if _, err := e.m.Archive(e.ctx(), id, true); err != nil {
				e.t.Fatal(err)
			}
		}, "archived"},
		{"snoozed", func(e *env, id string) {
			if _, err := e.m.Snooze(e.ctx(), id, time.Now().Add(time.Hour)); err != nil {
				e.t.Fatal(err)
			}
		}, "snoozed"},
		{"saved for later", func(e *env, id string) {
			if _, err := e.m.SaveForLater(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
		}, "saved for later"},
		{"setting up", func(e *env, id string) {
			e.m.update(id, false, func(rec *record) { rec.s.Setup = &Setup{Phase: SetupRunning} })
		}, "setting up"},
		{"a setup that failed", func(e *env, id string) {
			e.m.update(id, false, func(rec *record) { rec.s.Setup = &Setup{Phase: SetupFailed} })
		}, "setting up"},
		{"waiting on a child thread", func(e *env, id string) {
			child := e.stopped("child")
			e.setStep(child.ID, busy)
			if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: id, TargetThreadID: child.ID, Repeat: true}); err != nil {
				e.t.Fatal(err)
			}
			e.waitFor(id, "waiting", func(s Thread) bool { return s.StatusReason == waitingReason(1) })
		}, "not at its prompt (" + waitingReason(1) + ")"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.stopped("refused")
			tt.set(e, s.ID)
			before, err := e.m.Get(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			_, err = e.m.MarkUnread(e.ctx(), s.ID)
			if !errors.Is(err, ErrFailedPrecondition) {
				t.Fatalf("err = %v, want failed precondition", err)
			}
			if want := "thread " + s.ID + " is " + tt.why + "; only an idle thread at its prompt can be marked unread"; err.Error() != "failed precondition: "+want && !containsMsg(err, want) {
				t.Errorf("err = %q, want it to say %q", err, want)
			}
			got, _ := e.m.Get(e.ctx(), s.ID)
			if got.Status != before.Status || got.StatusReason != before.StatusReason {
				t.Errorf("status %s %q, want it kept as %s %q", got.Status, got.StatusReason, before.Status, before.StatusReason)
			}
		})
	}
	t.Run("an unknown thread", func(t *testing.T) {
		e := newEnv(t)
		if _, err := e.m.MarkUnread(e.ctx(), "s-nope"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("err = %v, want not found", err)
		}
	})
	t.Run("a stopped idle thread is marked", func(t *testing.T) {
		e := newEnv(t)
		s := e.stopped("ok")
		e.setStep(s.ID, offIdle)
		got, err := e.m.MarkUnread(e.ctx(), s.ID)
		if err != nil || !isFinishedStatus(got) || got.State != StateDisconnected {
			t.Fatalf("MarkUnread = %s %s %q, %v; want disconnected, finished", got.State, got.Status, got.StatusReason, err)
		}
	})
}

func containsMsg(err error, s string) bool {
	return err != nil && len(err.Error()) >= len(s) && err.Error()[len(err.Error())-len(s):] == s
}

// Marking fires nothing: no subscription to the thread fires, whatever its condition,
// and its subscriber gets no wake; the thread's next real attention fires as ever.
func TestMarkUnreadFiresNoWake(t *testing.T) {
	for _, running := range []bool{false, true} {
		for _, cond := range []Condition{CondSettled, CondIdle, CondAttention, CondError, CondDisconnected} {
			name := string(cond) + " stopped"
			if running {
				name = string(cond) + " running"
			}
			t.Run(name, func(t *testing.T) {
				e, _ := attendedEnv(t, true)
				subscriber := e.stopped("subscriber")
				var target Thread
				if running {
					target = e.connected(CreateOptions{Name: "target"})
					e.waitFor(target.ID, "idle", isIdleStatus)
				} else {
					target = e.stopped("target")
					e.setStep(target.ID, offIdle)
				}
				res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: subscriber.ID, TargetThreadID: target.ID, Condition: cond, Repeat: true})
				if err != nil {
					t.Fatal(err)
				}
				fired := 0
				if res.Fired {
					fired = 1
					e.waitItems(subscriber.ID, "the first wake", func(items []Item) bool { return len(wakes(items)) == 1 })
					e.waitFor(subscriber.ID, "the wake's turn", func(s Thread) bool { return s.Status != StatusBusy && s.Status != StatusUnknown })
				}
				if _, err := e.m.MarkUnread(e.ctx(), target.ID); err != nil {
					t.Fatal(err)
				}
				time.Sleep(settle)
				if got, _ := e.subscription(res.Subscription.ID); got.FiredCount != fired {
					t.Errorf("fired %d times, want %d", got.FiredCount, fired)
				}
				if n := len(wakes(e.items(subscriber.ID).Items)); n != fired {
					t.Errorf("%d wakes, want %d", n, fired)
				}
			})
		}
	}
	t.Run("the next real attention still fires", func(t *testing.T) {
		e, _ := attendedEnv(t, true)
		subscriber, target := e.stopped("subscriber"), e.stopped("target")
		e.setStep(target.ID, offIdle)
		res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: subscriber.ID, TargetThreadID: target.ID, Condition: CondAttention, Repeat: true})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.m.MarkUnread(e.ctx(), target.ID); err != nil {
			t.Fatal(err)
		}
		e.setStep(target.ID, busy)
		e.setStep(target.ID, finished)
		e.waitItems(subscriber.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
		if got, _ := e.subscription(res.Subscription.ID); got.FiredCount != 1 {
			t.Errorf("fired %d times, want 1", got.FiredCount)
		}
	})
}
