package thread

import (
	"testing"
	"time"
)

// Auto-tidy's rules (docs/notes/auto-tidy.md) on one thread: which threads each step may
// take, and which it leaves where they are.
func TestAutoTidyRules(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	idleBefore := now.Add(-3 * 24 * time.Hour)  // threads.auto_save_after = 3 days
	savedBefore := now.Add(-7 * 24 * time.Hour) // threads.auto_archive_after = 1 week
	old := now.Add(-10 * 24 * time.Hour)
	recent := now.Add(-time.Hour)
	exists := Known([]Thread{{ID: "s-lead"}})
	prSnoozeEvent := &SnoozeEvent{SubscriptionID: "sub-1", Kind: TargetPullRequest, Target: snoozePR, Condition: CondMerged, Since: old}

	// rest is the user's own thread, stopped at its prompt, idle for ten days.
	rest := func(f func(*Thread)) Thread {
		s := Thread{ID: "s-1", State: StateDisconnected, Status: StatusIdle, StatusReason: "at prompt", CreatedAt: old, LastActivityAt: old}
		if f != nil {
			f(&s)
		}
		return s
	}
	// savedOld is rest saved for later ten days ago.
	savedOld := func(f func(*Thread)) Thread {
		return rest(func(s *Thread) {
			s.SavedAt = old
			if f != nil {
				f(s)
			}
		})
	}
	tests := []struct {
		name    string
		t       Thread
		save    bool
		archive bool
	}{
		{name: "idle at its prompt, stopped", t: rest(nil), save: true},
		{name: "idle at its prompt, running", t: rest(func(s *Thread) { s.State = StateConnected }), save: true},
		{name: "active within the time", t: rest(func(s *Thread) { s.LastActivityAt = recent })},
		{name: "active exactly at the limit", t: rest(func(s *Thread) { s.LastActivityAt = idleBefore })},
		{name: "pinned", t: rest(func(s *Thread) { s.Pinned = true })},
		{name: "taken back out of Snoozed within the time", t: rest(func(s *Thread) { s.ReturnedAt = recent })},
		{name: "taken back out long ago", t: rest(func(s *Thread) { s.ReturnedAt = old }), save: true},
		{name: "archived", t: rest(func(s *Thread) { s.ArchivedAt = old })},
		{name: "snoozed until a time", t: rest(func(s *Thread) { s.SnoozedUntil = now.Add(time.Hour) })},
		{name: "resident (Ember)", t: rest(func(s *Thread) { s.Kind, s.ResidentName = KindResident, "ember" })},
		{name: "owned by a plugin", t: rest(func(s *Thread) { s.Owner = "plugin:x" })},
		{name: "created by a thread that exists", t: rest(func(s *Thread) { s.CreatedBy = "s-lead" })},
		{name: "created by a thread since removed", t: rest(func(s *Thread) { s.CreatedBy = "s-gone" }), save: true},
		{name: "being removed", t: rest(func(s *Thread) { s.Removing = true })},
		{name: "working", t: rest(func(s *Thread) { s.State, s.Status, s.StatusReason = StateConnected, StatusBusy, "working" })},
		{name: "starting", t: rest(func(s *Thread) { s.State, s.Status, s.StatusReason = StateStarting, StatusUnknown, "starting" })},
		{name: "closing", t: rest(func(s *Thread) { s.State = StateClosing })},
		{name: "setting up", t: rest(func(s *Thread) { s.Setup = &Setup{Phase: SetupRunning} })},
		{name: "asking a permission", t: rest(func(s *Thread) {
			s.State, s.Status, s.StatusReason, s.PendingRequestID = StateConnected, StatusNeedsAttention, "permission: Bash", "r-1"
		})},
		{name: "asking a question", t: rest(func(s *Thread) { s.Status, s.StatusReason = StatusNeedsAttention, "question: Which?" })},
		{name: "finished, not seen yet", t: rest(func(s *Thread) { s.Status, s.StatusReason = StatusNeedsAttention, "finished" })},
		{name: "marked unread (finished again)", t: rest(func(s *Thread) { s.Status, s.StatusReason = StatusNeedsAttention, "finished" })},
		{name: "woken from a snooze", t: rest(func(s *Thread) { s.Status, s.StatusReason = StatusNeedsAttention, ReasonSnoozeEnded })},
		{name: "interrupted", t: rest(func(s *Thread) { s.Status, s.StatusReason = StatusError, ReasonInterrupted })},
		{name: "crashed", t: rest(func(s *Thread) { s.Status, s.StatusReason = StatusError, ReasonCrashed })},
		{name: "status not known", t: rest(func(s *Thread) { s.Status, s.StatusReason = StatusUnknown, "" })},
		{name: "waiting on child threads", t: rest(func(s *Thread) { s.StatusReason = "waiting on 2 child threads" })},
		{name: "a wake pending", t: rest(func(s *Thread) { s.State, s.WakePending = StateConnected, true })},
		{name: "a background shell running", t: rest(func(s *Thread) { s.State, s.BackgroundShellsRunning = StateConnected, 1 })},
		{name: "a background subagent running", t: rest(func(s *Thread) {
			s.State, s.AgentRuns = StateConnected, []AgentRun{{ID: "a1", Background: true, SpawnDepth: 1, Status: AgentRunning}}
		})},
		{name: "a move queued", t: rest(func(s *Thread) { s.State, s.PendingWorktreePath = StateConnected, "/elsewhere" })},
		{name: "a reseed pending", t: rest(func(s *Thread) { s.State, s.ReseedPending = StateConnected, true })},

		{name: "saved by the user long ago", t: savedOld(nil), archive: true},
		{name: "saved automatically long ago", t: savedOld(func(s *Thread) { s.AutoSavedAfter = 3 * 24 * time.Hour }), archive: true},
		{name: "saved long ago, active since (another thread wrote)", t: savedOld(func(s *Thread) { s.LastActivityAt = recent }), archive: true},
		{name: "saved within the time", t: savedOld(func(s *Thread) { s.SavedAt = recent })},
		{name: "saved exactly at the limit", t: savedOld(func(s *Thread) { s.SavedAt = savedBefore })},
		{name: "saved and pinned", t: savedOld(func(s *Thread) { s.Pinned = true })},
		{name: "snoozed until a time long ago set", t: rest(func(s *Thread) { s.SnoozedUntil = now.Add(24 * time.Hour); s.StatusChangedAt = old })},
		{name: "snoozed until an event long ago (a save waiting on something)", t: savedOld(func(s *Thread) { s.SnoozeEvent = prSnoozeEvent })},
		{name: "auto-saved, then snoozed until an event", t: savedOld(func(s *Thread) { s.SnoozeEvent, s.AutoSavedAfter = prSnoozeEvent, 3*24*time.Hour })},
		{name: "an event's snooze ended long ago, idle since", t: rest(func(s *Thread) { s.SnoozeEndedBy, s.ReturnedAt = "#7 was merged", old }), save: true},
		{name: "saved, working now (another thread wrote)", t: savedOld(func(s *Thread) {
			s.State, s.Status, s.StatusReason = StateConnected, StatusBusy, "working"
		})},
		{name: "saved, asking", t: savedOld(func(s *Thread) { s.Status, s.StatusReason = StatusNeedsAttention, "question: Which?" })},
		{name: "saved, created by a thread that exists", t: savedOld(func(s *Thread) { s.CreatedBy = "s-lead" })},
		{name: "saved, resident", t: savedOld(func(s *Thread) { s.Kind = KindResident })},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := AutoSaveDue(tt.t, exists, idleBefore); got != tt.save {
				t.Errorf("AutoSaveDue = %v, want %v (refusal %q)", got, tt.save, TidyRefusal(tt.t, exists))
			}
			if got := AutoArchiveDue(tt.t, exists, savedBefore); got != tt.archive {
				t.Errorf("AutoArchiveDue = %v, want %v (refusal %q)", got, tt.archive, TidyRefusal(tt.t, exists))
			}
		})
	}
}

// AutoSave saves an idle thread for later as the user's Save for later does, marked as
// auto-tidy's with the setting's time, and the mark survives a restart.
func TestAutoSave(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(time.Hour))
	s := e.stopped("idle")
	pinned := e.stopped("pinned")
	if _, err := e.m.Pin(e.ctx(), pinned.ID, true); err != nil {
		t.Fatal(err)
	}
	after := 3 * 24 * time.Hour
	now := clk.advance(4 * 24 * time.Hour)

	// Not yet due by its setting: nothing changes.
	if got, ok, err := e.m.AutoSave(e.ctx(), s.ID, 7*24*time.Hour, now.Add(-7*24*time.Hour)); err != nil || ok || got.Snoozed() {
		t.Fatalf("AutoSave before its time = saved %v, %v, %v; want left alone", ok, got.SavedAt, err)
	}
	if got, ok, err := e.m.AutoSave(e.ctx(), pinned.ID, after, now.Add(-after)); err != nil || ok || got.Snoozed() {
		t.Errorf("AutoSave of a pinned thread = saved %v, %v, %v; want left alone", ok, got.SavedAt, err)
	}

	got, ok, err := e.m.AutoSave(e.ctx(), s.ID, after, now.Add(-after))
	if err != nil || !ok {
		t.Fatalf("AutoSave = %v, %v; want saved", ok, err)
	}
	if !got.SavedAt.Equal(now.Truncate(time.Millisecond)) || !got.SnoozedUntil.IsZero() || got.AutoSavedAfter != after || !got.ArchivedAt.IsZero() {
		t.Errorf("auto-saved = SavedAt %v SnoozedUntil %v mark %v archived %v; want saved now, marked %v", got.SavedAt, got.SnoozedUntil, got.AutoSavedAfter, got.ArchivedAt, after)
	}
	if got.Status != StatusIdle || got.State != StateDisconnected {
		t.Errorf("auto-saved = %s %s; want left as it was", got.State, got.Status)
	}
	// Saved already: a second pass does nothing.
	if _, ok, err := e.m.AutoSave(e.ctx(), s.ID, after, clk.Now().Add(-after)); ok || err != nil {
		t.Errorf("AutoSave of a saved thread = %v, %v; want left alone", ok, err)
	}

	e.restart(clk.opts(time.Hour))
	after2, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || after2.AutoSavedAfter != after || after2.SavedAt.UnixMilli() != got.SavedAt.UnixMilli() {
		t.Errorf("after restart = mark %v SavedAt %v, %v; want %v, %v", after2.AutoSavedAfter, after2.SavedAt, err, after, got.SavedAt)
	}
	if _, _, err := e.m.AutoSave(e.ctx(), s.ID, 0, now); err == nil {
		t.Error("AutoSave with no time = nil error, want one")
	}
}

// Whatever the user does that ends or replaces the save clears auto-tidy's mark, and it stays
// cleared after a restart; the user saving it again keeps the time and makes it theirs.
func TestAutoSavedMarkCleared(t *testing.T) {
	tests := []struct {
		name      string
		act       func(e *env, id string) Thread
		stillSave bool
	}{
		{name: "unsnooze", act: func(e *env, id string) Thread {
			s, err := e.m.Snooze(e.ctx(), id, time.Time{})
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "the user saves it", stillSave: true, act: func(e *env, id string) Thread {
			s, err := e.m.SaveForLater(e.ctx(), id)
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "the user snoozes it until an event", stillSave: true, act: func(e *env, id string) Thread {
			s, err := e.m.SnoozeUntilEvent(e.ctx(), id, EventSnooze{PullRequest: snoozePR, Condition: CondMerged})
			if err != nil || s.SnoozeEvent == nil {
				e.t.Fatalf("SnoozeUntilEvent = %+v, %v", s.SnoozeEvent, err)
			}
			return s
		}},
		{name: "a timed snooze", act: func(e *env, id string) Thread {
			s, err := e.m.Snooze(e.ctx(), id, e.m.opts.Now().Add(time.Hour))
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "pin", act: func(e *env, id string) Thread {
			s, err := e.m.Pin(e.ctx(), id, true)
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "archive", act: func(e *env, id string) Thread {
			s, err := e.m.Archive(e.ctx(), id, true)
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "the user's message", act: func(e *env, id string) Thread {
			if _, err := e.m.Send(e.ctx(), id, Message{Text: "again"}); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "unsaved", func(s Thread) bool { return s.SavedAt.IsZero() })
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clk := newTestClock()
			prs := tidyPRs()
			e := newEnv(t, prs.opts, clk.opts(time.Hour))
			s := e.stopped("idle")
			now := clk.advance(2 * 24 * time.Hour)
			auto, ok, err := e.m.AutoSave(e.ctx(), s.ID, 24*time.Hour, now.Add(-24*time.Hour))
			if err != nil || !ok {
				t.Fatalf("AutoSave = %v, %v", ok, err)
			}
			got := tt.act(e, s.ID)
			if got.AutoSavedAfter != 0 || got.SavedAt.IsZero() == tt.stillSave {
				t.Errorf("after %s: mark %v SavedAt %v; want no mark, saved %v", tt.name, got.AutoSavedAfter, got.SavedAt, tt.stillSave)
			}
			if tt.stillSave && !got.SavedAt.Equal(auto.SavedAt) {
				t.Errorf("after %s: SavedAt %v; want the auto-save's %v kept", tt.name, got.SavedAt, auto.SavedAt)
			}
			e.restart(prs.opts, clk.opts(time.Hour))
			if after, err := e.m.Get(e.ctx(), s.ID); err != nil || after.AutoSavedAfter != 0 {
				t.Errorf("after %s and a restart: mark %v, %v; want none", tt.name, after.AutoSavedAfter, err)
			}
		})
	}
}

// AutoArchive archives a thread saved for later longer than the setting, as the user's
// archive does, and leaves a timed snooze, a pinned or a recent save alone.
func TestAutoArchive(t *testing.T) {
	week := 7 * 24 * time.Hour
	tests := []struct {
		name    string
		setup   func(e *env, clk *testClock) Thread
		archive bool
	}{
		{name: "saved by the user", archive: true, setup: func(e *env, clk *testClock) Thread {
			return e.saved()
		}},
		{name: "saved by auto-tidy", archive: true, setup: func(e *env, clk *testClock) Thread {
			s := e.stopped("auto")
			now := clk.advance(2 * 24 * time.Hour)
			got, ok, err := e.m.AutoSave(e.ctx(), s.ID, 24*time.Hour, now.Add(-24*time.Hour))
			if err != nil || !ok {
				e.t.Fatalf("AutoSave = %v, %v", ok, err)
			}
			return got
		}},
		{name: "snoozed until a time", setup: func(e *env, clk *testClock) Thread {
			s := e.stopped("timed")
			got, err := e.m.Snooze(e.ctx(), s.ID, clk.Now().Add(30*24*time.Hour))
			if err != nil {
				e.t.Fatal(err)
			}
			return got
		}},
		{name: "snoozed until an event", setup: func(e *env, clk *testClock) Thread {
			return e.eventSnoozed(EventSnooze{PullRequest: snoozePR, Condition: CondMerged})
		}},
		{name: "saved by auto-tidy, then snoozed until an event", setup: func(e *env, clk *testClock) Thread {
			s := e.stopped("auto")
			now := clk.advance(2 * 24 * time.Hour)
			if _, ok, err := e.m.AutoSave(e.ctx(), s.ID, 24*time.Hour, now.Add(-24*time.Hour)); err != nil || !ok {
				e.t.Fatalf("AutoSave = %v, %v", ok, err)
			}
			got, err := e.m.SnoozeUntilEvent(e.ctx(), s.ID, EventSnooze{PullRequest: snoozePR, Condition: CondMerged})
			if err != nil || got.SnoozeEvent == nil {
				e.t.Fatalf("SnoozeUntilEvent = %+v, %v", got.SnoozeEvent, err)
			}
			return got
		}},
		{name: "saved and pinned", setup: func(e *env, clk *testClock) Thread {
			s := e.saved()
			got, err := e.m.Pin(e.ctx(), s.ID, true) // unsnoozes; save it again, pinned
			if err != nil {
				e.t.Fatal(err)
			}
			if got, err = e.m.SaveForLater(e.ctx(), got.ID); err != nil || !got.Pinned {
				e.t.Fatalf("SaveForLater pinned = %+v, %v", got, err)
			}
			return got
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clk := newTestClock()
			e := newEnv(t, tidyPRs().opts, clk.opts(time.Hour))
			s := tt.setup(e, clk)
			// Not yet a week.
			if _, ok, err := e.m.AutoArchive(e.ctx(), s.ID, clk.Now().Add(-week)); ok || err != nil {
				t.Fatalf("AutoArchive within the week = %v, %v; want left alone", ok, err)
			}
			now := clk.advance(8 * 24 * time.Hour)
			got, ok, err := e.m.AutoArchive(e.ctx(), s.ID, now.Add(-week))
			if err != nil || ok != tt.archive {
				t.Fatalf("AutoArchive = %v, %v; want %v", ok, err, tt.archive)
			}
			if !tt.archive {
				if !got.ArchivedAt.IsZero() || !got.Snoozed() || (s.SnoozeEvent != nil) != (got.SnoozeEvent != nil) {
					t.Errorf("left alone = archived %v snoozed %v event %+v; want as it was", got.ArchivedAt, got.Snoozed(), got.SnoozeEvent)
				}
				return
			}
			if got.ArchivedAt.IsZero() || got.Snoozed() || got.AutoSavedAfter != 0 || got.State != StateDisconnected {
				t.Errorf("auto-archived = archived %v snoozed %v mark %v %s; want archived, not snoozed, no mark", got.ArchivedAt, got.Snoozed(), got.AutoSavedAfter, got.State)
			}
		})
	}
}

// A thread that comes back to the list (unsnoozed, unarchived, its snooze ending) starts
// auto-tidy's idle clock again, so the next tick does not put it straight back; the time
// survives a restart.
func TestAutoTidyClockRestartsOnReturn(t *testing.T) {
	day := 24 * time.Hour
	tests := []struct {
		name string
		// away puts the thread away at the clock's time; back brings it back after 10 days.
		away, back func(e *env, id string)
	}{
		{name: "unsnooze an auto-save",
			away: func(e *env, id string) {
				if _, ok, err := e.m.AutoSave(e.ctx(), id, day, e.m.opts.Now().Add(-day)); err != nil || !ok {
					e.t.Fatalf("AutoSave = %v, %v", ok, err)
				}
			},
			back: func(e *env, id string) {
				if _, err := e.m.Snooze(e.ctx(), id, time.Time{}); err != nil {
					e.t.Fatal(err)
				}
			}},
		{name: "unarchive",
			away: func(e *env, id string) {
				if _, err := e.m.Archive(e.ctx(), id, true); err != nil {
					e.t.Fatal(err)
				}
			},
			back: func(e *env, id string) {
				if _, err := e.m.Archive(e.ctx(), id, false); err != nil {
					e.t.Fatal(err)
				}
			}},
		{name: "an event ends the snooze",
			away: func(e *env, id string) {
				if _, err := e.m.SnoozeUntilEvent(e.ctx(), id, EventSnooze{PullRequest: snoozePR, Condition: CondMerged}); err != nil {
					e.t.Fatal(err)
				}
			},
			back: func(e *env, id string) {
				e.m.PullRequestChanged(stateEvent("merged", PRChangeMerged))
				e.woken(id)
				if _, ok, err := e.m.ClearSnoozeEnded(e.ctx(), id); !ok || err != nil { // the user cleared the wake
					e.t.Fatalf("ClearSnoozeEnded = %v, %v", ok, err)
				}
			}},
		{name: "a snooze's time arrives",
			away: func(e *env, id string) {
				if _, err := e.m.Snooze(e.ctx(), id, e.m.opts.Now().Add(10*day-time.Minute)); err != nil {
					e.t.Fatal(err)
				}
			},
			back: func(e *env, id string) {
				e.m.wakeSnoozed()
				if _, ok, err := e.m.ClearSnoozeEnded(e.ctx(), id); !ok || err != nil { // the user cleared the wake
					e.t.Fatalf("ClearSnoozeEnded = %v, %v", ok, err)
				}
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clk := newTestClock()
			prs := tidyPRs()
			e := newEnv(t, prs.opts, clk.opts(time.Hour))
			s := e.stopped("idle")
			clk.advance(2 * day)
			tt.away(e, s.ID)
			now := clk.advance(10 * day)
			tt.back(e, s.ID)
			got, err := e.m.Get(e.ctx(), s.ID)
			if err != nil || !got.ReturnedAt.Equal(now.Truncate(time.Millisecond)) || got.Snoozed() || !got.ArchivedAt.IsZero() {
				t.Fatalf("back = ReturnedAt %v snoozed %v archived %v, %v; want back in the list at %v", got.ReturnedAt, got.Snoozed(), got.ArchivedAt, err, now)
			}
			// Idle for twelve days, but back only now: not due until a day after its return.
			if _, ok, err := e.m.AutoSave(e.ctx(), s.ID, day, now.Add(-day)); ok || err != nil {
				t.Errorf("AutoSave right after its return = %v, %v; want left alone", ok, err)
			}
			e.restart(prs.opts, clk.opts(time.Hour))
			if after, err := e.m.Get(e.ctx(), s.ID); err != nil || !after.ReturnedAt.Equal(got.ReturnedAt) {
				t.Errorf("after restart ReturnedAt = %v, %v; want %v", after.ReturnedAt, err, got.ReturnedAt)
			}
			later := clk.advance(day + time.Minute)
			if _, ok, err := e.m.AutoSave(e.ctx(), s.ID, day, later.Add(-day)); !ok || err != nil {
				t.Errorf("AutoSave a day after its return = %v, %v; want saved", ok, err)
			}
		})
	}
}

// tidyPRs is a pull request source holding open acme/web#7, for the cases that snooze a thread
// until an event on it (snooze_event.go).
func tidyPRs() *fakePRs {
	return newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: pending4, Title: "Fix login"})
}
