package thread

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// midTurnAt starts a thread at path's first permission prompt: mid-turn, and the turn
// ends when the test answers (allow).
func midTurnAt(t *testing.T, path string, vars []string, mutate ...func(*Options)) (*env, Thread) {
	t.Helper()
	e := newFixtureEnvAt(t, path, vars, mutate...)
	s := e.create(CreateOptions{InitialPrompt: "write"})
	return e, e.asking(s.ID)
}

func (e *env) asking(id string) Thread {
	e.t.Helper()
	return e.waitFor(id, "the permission prompt", func(s Thread) bool {
		return s.State == StateConnected && strings.HasPrefix(s.StatusReason, "permission:") && s.PendingRequestID != ""
	})
}

// allow answers the pending request, which ends the turn.
func (e *env) allow(s Thread) {
	e.t.Helper()
	if _, err := e.m.Respond(e.ctx(), s.ID, s.PendingRequestID, Decision{Allow: true}); err != nil {
		e.t.Fatal(err)
	}
}

// putAwaySelf asks for p and expects it deferred, the thread untouched.
func (e *env) putAwaySelf(s Thread, p PutAway) {
	e.t.Helper()
	got, deferred, err := e.m.PutAwaySelf(e.ctx(), s.ID, p)
	if err != nil {
		e.t.Fatal(err)
	}
	if !deferred || got.State != StateConnected || !got.ArchivedAt.IsZero() || got.Snoozed() {
		e.t.Fatalf("PutAwaySelf = deferred %v, %+v; want deferred, nothing done yet", deferred, got)
	}
}

// pendingPutAway is the thread's pending put-away, nil without one.
func (e *env) pendingPutAway(id string) *PutAway {
	e.m.mu.Lock()
	defer e.m.mu.Unlock()
	return e.m.recs[id].putAway
}

// putAwayIn is what each form leaves on the thread, for the tables.
type putAwayForm struct {
	name string
	p    func(now time.Time) PutAway
	done func(Thread) bool
}

var putAwayForms = []putAwayForm{
	{"archive", func(time.Time) PutAway { return PutAway{Kind: PutAwayArchive} }, func(s Thread) bool { return !s.ArchivedAt.IsZero() }},
	{"snooze", func(now time.Time) PutAway { return PutAway{Kind: PutAwaySnooze, Until: now.Add(time.Hour)} }, func(s Thread) bool { return !s.SnoozedUntil.IsZero() }},
	{"save", func(time.Time) PutAway { return PutAway{Kind: PutAwaySave} }, func(s Thread) bool { return !s.SavedAt.IsZero() }},
}

// The agreed end state, for each form: the turn ends by itself, then the thread is put
// away idle at its prompt, and at no point does that turn ask for attention. Presence is
// not attended and nothing views the thread, so nothing acknowledges it either: a plain
// turn ends "finished" here.
func TestPutAwaySelfAtTurnEnd(t *testing.T) {
	for _, f := range putAwayForms {
		t.Run(f.name, func(t *testing.T) {
			e, s := midTurnAt(t, fixturePath("write-allow"), nil, func(o *Options) { o.Attended = func() bool { return false } })
			sub := bus.Subscribe[Event](e.bus, 1024)
			defer sub.Close()
			e.putAwaySelf(s, f.p(time.Now()))
			e.allow(s)
			got := e.waitFor(s.ID, "put away", f.done)
			if got.State != StateDisconnected || got.DisconnectReason != ReasonClosed {
				t.Errorf("state %v %q, want disconnected closed", got.State, got.DisconnectReason)
			}
			if got.Status != StatusIdle || got.StatusReason != "at prompt" {
				t.Errorf("status %v %q, want idle at prompt", got.Status, got.StatusReason)
			}
			items := e.items(s.ID).Items
			if end, ok := lastKind(items, KindTurnEnd); !ok || end.Turn == nil || isSynthTurn(end.Turn) {
				t.Errorf("the turn did not end by itself: %s", describeItems(items))
			}
			if _, ok := lastKind(items, KindError); ok {
				t.Errorf("an error in the timeline: %s", describeItems(items))
			}
			for drained := false; !drained; {
				select {
				case ev := <-sub.C():
					u, ok := ev.(Updated)
					if !ok || u.Thread.ID != s.ID {
						continue
					}
					reason := u.Thread.StatusReason
					if u.Thread.Status == StatusError || (u.Thread.Status == StatusNeedsAttention && !strings.HasPrefix(reason, "permission:")) {
						t.Errorf("published %v %q", u.Thread.Status, reason)
					}
				default:
					drained = true
				}
			}
			rows, err := loadThreads(e.ctx(), e.m.opts.DB)
			if err != nil || len(rows) != 1 {
				t.Fatalf("load = %v, %v", rows, err)
			}
			if r := rows[0]; r.Status != StatusIdle || r.StatusReason != "at prompt" || !f.done(r) {
				t.Errorf("persisted %v %q: %+v", r.Status, r.StatusReason, r)
			}
		})
	}
}

// The turn's end runs on its own context: the request that asked is gone by then (the
// CLI exits at once), and with a slow exit a cancelled request cannot have mattered.
func TestPutAwaySelfOutlivesItsRequest(t *testing.T) {
	for _, f := range putAwayForms {
		t.Run(f.name, func(t *testing.T) {
			e, s := midTurnAt(t, fixturePath("write-allow"), []string{"CF_FAKE_CLAUDE_EXIT_DELAY=300ms"})
			ctx, cancel := context.WithCancel(e.ctx())
			if _, deferred, err := e.m.PutAwaySelf(ctx, s.ID, f.p(time.Now())); err != nil || !deferred {
				t.Fatalf("PutAwaySelf = %v, %v", deferred, err)
			}
			cancel()
			e.allow(s)
			got := e.waitFor(s.ID, "put away", f.done)
			if got.Status != StatusIdle || got.StatusReason != "at prompt" {
				t.Errorf("status %v %q, want idle at prompt", got.Status, got.StatusReason)
			}
		})
	}
}

// What happens at once to a thread not mid-turn (a shell of the thread calling after the
// turn) must also outlive its request: the close ends that shell, and the CLI in it. This
// is the report's failure in the one place deferring cannot help: real Claude ended the
// request ~30 ms into a ~300 ms close.
func TestPutAwaySelfAtPromptOutlivesItsRequest(t *testing.T) {
	for _, f := range putAwayForms {
		t.Run(f.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_EXIT_DELAY=300ms"})
			s := e.create(CreateOptions{})
			e.waitFor(s.ID, "at its prompt", func(s Thread) bool { return s.State == StateConnected && s.Status == StatusIdle })
			ctx, cancel := context.WithCancel(e.ctx())
			defer cancel()
			type result struct {
				deferred bool
				err      error
			}
			done := make(chan result, 1)
			go func() {
				_, deferred, err := e.m.PutAwaySelf(ctx, s.ID, f.p(time.Now()))
				done <- result{deferred, err}
			}()
			e.waitFor(s.ID, "closing", func(s Thread) bool { return s.State == StateClosing })
			cancel() // the close killed the shell that asked
			if r := <-done; r.deferred || r.err != nil {
				t.Fatalf("PutAwaySelf = %+v", r)
			}
			got := e.snapshot(s.ID)
			if !f.done(got) || got.State != StateDisconnected || got.Status != StatusIdle {
				t.Errorf("end state %+v", got)
			}
		})
	}
}

// The user taking over drops it, for each kind of put-away: the turn then ends like any
// other, with the thread live and in the list.
func TestPutAwaySelfCancelled(t *testing.T) {
	takeovers := []struct {
		name string
		do   func(e *env, s Thread) error
	}{
		{"a message during the turn", func(e *env, s Thread) error {
			_, err := e.m.Send(e.ctx(), s.ID, Message{Text: "wait, one more thing"})
			return err
		}},
		{"a message from another thread", func(e *env, s Thread) error {
			_, err := e.m.Send(e.ctx(), s.ID, Message{Text: "more work", ByThreadID: "s-other"})
			return err
		}},
		{"an unarchive", func(e *env, s Thread) error { _, err := e.m.Archive(e.ctx(), s.ID, false); return err }},
		{"an unsnooze", func(e *env, s Thread) error { _, err := e.m.Snooze(e.ctx(), s.ID, time.Time{}); return err }},
	}
	for _, f := range putAwayForms {
		for _, tt := range takeovers {
			t.Run(f.name+"/"+tt.name, func(t *testing.T) {
				e, s := midTurnAt(t, fixturePath("write-allow"), nil)
				e.putAwaySelf(s, f.p(time.Now()))
				if err := tt.do(e, s); err != nil {
					t.Fatal(err)
				}
				if p := e.pendingPutAway(s.ID); p != nil {
					t.Fatalf("still pending: %+v", p)
				}
				e.allow(s)
				got := e.waitFor(s.ID, "the turn's end", func(s Thread) bool { return s.StatusReason == "finished" })
				if got.State != StateConnected || f.done(got) {
					t.Errorf("end state %+v, want live and in the list", got)
				}
			})
		}
	}
}

func TestPutAwaySelfInterrupted(t *testing.T) {
	for _, f := range putAwayForms {
		t.Run(f.name, func(t *testing.T) {
			// interrupt-pending: the turn holds at a permission prompt until interrupted.
			e, s := midTurnAt(t, fixturePath("interrupt-pending"), nil)
			e.putAwaySelf(s, f.p(time.Now()))
			if err := e.m.Interrupt(e.ctx(), s.ID, ""); err != nil {
				t.Fatal(err)
			}
			if p := e.pendingPutAway(s.ID); p != nil {
				t.Fatalf("still pending: %+v", p)
			}
			e.waitItems(s.ID, "the turn's end", hasTurnEnd)
			got := e.waitFor(s.ID, "back at its prompt", func(s Thread) bool { return s.Status == StatusIdle })
			if got.State != StateConnected || f.done(got) {
				t.Errorf("end state %+v, want live and in the list", got)
			}
		})
	}
}

// A turn interrupted by something the daemon's Interrupt did not see (the budget stop)
// has the same end, by the result's terminal reason alone: is_error is off here, so the
// failed-turn rule cannot be what drops it.
func TestPutAwaySelfInterruptedTurnDrops(t *testing.T) {
	data, err := os.ReadFile(fixturePath("interrupt-pending"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "interrupted.jsonl")
	if err := os.WriteFile(path, []byte(strings.ReplaceAll(string(data), `"is_error":true`, `"is_error":false`)), 0o600); err != nil {
		t.Fatal(err)
	}
	e, s := midTurnAt(t, path, nil)
	e.putAwaySelf(s, PutAway{Kind: PutAwayArchive})
	live, _, _, _, err := e.m.lifecycle(s.ID)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := live.st.connection()
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Interrupt(e.ctx()); err != nil {
		t.Fatal(err)
	}
	e.waitItems(s.ID, "the turn's end", hasTurnEnd)
	e.waitFor(s.ID, "dropped", func(s Thread) bool { return s.Status == StatusIdle && e.pendingPutAway(s.ID) == nil })
	if got := e.snapshot(s.ID); got.State != StateConnected || !got.ArchivedAt.IsZero() {
		t.Errorf("end state %+v", got)
	}
}

// A wake is not the user: it leaves the put-away alone, and it still lands at the turn's end.
func TestPutAwaySelfKeptByAWake(t *testing.T) {
	e, s := midTurnAt(t, fixturePath("write-allow"), nil)
	e.putAwaySelf(s, PutAway{Kind: PutAwayArchive})
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "a shell ended", Origin: OriginWake, WakeTitle: "wake"}); err != nil {
		t.Fatal(err)
	}
	if e.pendingPutAway(s.ID) == nil {
		t.Fatal("a wake dropped the put-away")
	}
	e.allow(s)
	e.waitFor(s.ID, "archived", func(s Thread) bool { return !s.ArchivedAt.IsZero() })
}

// The process ending mid-turn drops it, and the status stays what happened.
func TestPutAwaySelfCrash(t *testing.T) {
	tests := []struct {
		name       string
		code       int
		want       Status
		wantReason string
	}{
		{name: "a crash", code: 1, want: StatusError, wantReason: ReasonCrashed},
		{name: "an exit", code: 0, want: StatusError, wantReason: ReasonCrashed},
	}
	for _, f := range putAwayForms {
		for _, tt := range tests {
			t.Run(f.name+"/"+tt.name, func(t *testing.T) {
				e, s := midTurnAt(t, fixturePath("write-allow"), nil)
				e.putAwaySelf(s, f.p(time.Now()))
				e.exit(s.ID, tt.code)
				got := e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
				if got.Status != tt.want || got.StatusReason != tt.wantReason {
					t.Errorf("status %v %q, want %v %q", got.Status, got.StatusReason, tt.want, tt.wantReason)
				}
				if f.done(got) || e.pendingPutAway(s.ID) != nil {
					t.Errorf("put away %v, pending %+v; want neither", f.done(got), e.pendingPutAway(s.ID))
				}
				// The next start's turn owes the old request nothing.
				if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
					t.Fatal(err)
				}
				e.allow(e.asking(s.ID))
				got = e.waitFor(s.ID, "the turn's end", func(s Thread) bool { return s.StatusReason == "finished" })
				if got.State != StateConnected || f.done(got) {
					t.Errorf("end state %+v, want live and in the list", got)
				}
			})
		}
	}
}

// resultFixture is write-allow with edit applied to its result line.
func resultFixture(t *testing.T, edit func(string) string) string {
	t.Helper()
	data, err := os.ReadFile(fixturePath("write-allow"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(data), "\n")
	edited := false
	for i, l := range lines {
		if strings.Contains(l, `"type":"result"`) {
			lines[i], edited = edit(l), true
		}
	}
	if !edited {
		t.Fatal("no result line")
	}
	path := filepath.Join(t.TempDir(), "edited.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A failed turn drops it: "error" needs the user more than the thread needs to go.
func TestPutAwaySelfFailedTurn(t *testing.T) {
	path := resultFixture(t, func(l string) string {
		l = strings.Replace(l, `"is_error":false`, `"is_error":true`, 1)
		return strings.Replace(l, `"subtype":"success"`, `"subtype":"error_during_execution"`, 1)
	})
	e, s := midTurnAt(t, path, nil)
	e.putAwaySelf(s, PutAway{Kind: PutAwayArchive})
	e.allow(s)
	got := e.waitFor(s.ID, "the failed turn", func(s Thread) bool { return strings.HasPrefix(s.StatusReason, "error:") })
	if got.Status != StatusNeedsAttention || got.State != StateConnected || !got.ArchivedAt.IsZero() || e.pendingPutAway(s.ID) != nil {
		t.Errorf("end state %+v", got)
	}
}

// A snooze whose time passed during the turn is dropped: the thread would wake at once.
func TestPutAwaySelfSnoozeTimePassed(t *testing.T) {
	clk := newTestClock()
	e, s := midTurnAt(t, fixturePath("write-allow"), nil, func(o *Options) { o.Now = clk.Now })
	e.putAwaySelf(s, PutAway{Kind: PutAwaySnooze, Until: clk.Now().Add(time.Hour)})
	clk.advance(2 * time.Hour)
	e.allow(s)
	got := e.waitFor(s.ID, "the turn's end", func(s Thread) bool { return s.StatusReason == "finished" })
	if got.State != StateConnected || got.Snoozed() || e.pendingPutAway(s.ID) != nil {
		t.Errorf("end state %+v", got)
	}
}

// A second call replaces the first.
func TestPutAwaySelfSecondReplaces(t *testing.T) {
	e, s := midTurnAt(t, fixturePath("write-allow"), nil)
	e.putAwaySelf(s, PutAway{Kind: PutAwayArchive})
	until := time.Now().Add(time.Hour)
	e.putAwaySelf(s, PutAway{Kind: PutAwaySnooze, Until: until})
	e.allow(s)
	got := e.waitFor(s.ID, "snoozed", func(s Thread) bool { return s.Snoozed() })
	if !got.ArchivedAt.IsZero() {
		t.Errorf("archived too: %+v", got)
	}
}

// The user putting the thread away differently, now, wins: the turn is cut off and what
// was pending goes with the process.
func TestPutAwaySelfOverruledByTheUser(t *testing.T) {
	e, s := midTurnAt(t, fixturePath("write-allow"), nil)
	e.putAwaySelf(s, PutAway{Kind: PutAwaySnooze, Until: time.Now().Add(time.Hour)})
	got, err := e.m.Archive(e.ctx(), s.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if got.ArchivedAt.IsZero() || got.Snoozed() || got.Status != StatusIdle || got.StatusReason != ReasonArchived || e.pendingPutAway(s.ID) != nil {
		t.Errorf("end state %v %q, archived %v, snoozed %v, pending %+v", got.Status, got.StatusReason, got.ArchivedAt, got.Snoozed(), e.pendingPutAway(s.ID))
	}
}

// A result with a turn queued behind it is not the end of the thread's work: the last
// turn's is. Turn 2 here is Claude's own (a queued wake).
func TestPutAwaySelfWaitsForQueuedTurn(t *testing.T) {
	path := resultFixture(t, func(l string) string {
		return strings.Replace(l, `"queued_turn_count":0`, `"queued_turn_count":1`, 1) + "\n" + l
	})
	dir := t.TempDir()
	e, s := midTurnAt(t, path, []string{"CF_FAKE_CLAUDE_UNPROMPTED=" + dir})
	e.putAwaySelf(s, PutAway{Kind: PutAwayArchive})
	e.allow(s)
	e.waitItems(s.ID, "the first turn's end", hasTurnEnd)
	if got := e.snapshot(s.ID); got.State != StateConnected || e.pendingPutAway(s.ID) == nil {
		t.Fatalf("after the queued result: %+v, pending %+v", got, e.pendingPutAway(s.ID))
	}
	if err := os.WriteFile(filepath.Join(dir, "turn-2"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "archived", func(s Thread) bool { return !s.ArchivedAt.IsZero() })
}

// Claude can outlive the close by up to CloseTimeout while a background agent runs, and
// when that ends it takes a turn. That turn is not the user's to see: the thread was put
// away, and its status stays what the close began with.
func TestPutAwaySelfTurnOnTheWayOut(t *testing.T) {
	second, err := os.ReadFile(fixturePath("text-table"))
	if err != nil {
		t.Fatal(err)
	}
	path := resultFixture(t, func(l string) string { return l })
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(append([]byte("\n"), second...)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	e, s := midTurnAt(t, path, []string{"CF_FAKE_CLAUDE_CLOSE_TURN=20ms", "CF_FAKE_CLAUDE_EXIT_DELAY=400ms"},
		func(o *Options) { o.Attended = func() bool { return false } })
	sub := bus.Subscribe[Event](e.bus, 1024)
	defer sub.Close()
	e.putAwaySelf(s, PutAway{Kind: PutAwayArchive})
	e.allow(s)
	got := e.waitFor(s.ID, "archived", func(s Thread) bool { return !s.ArchivedAt.IsZero() })
	if got.Status != StatusIdle || got.StatusReason != "at prompt" {
		t.Errorf("status %v %q, want idle at prompt", got.Status, got.StatusReason)
	}
	if n := countTurnEnds(e.items(s.ID).Items); n != 2 {
		t.Fatalf("%d turn ends, want the one on the way out too", n)
	}
	for drained := false; !drained; {
		select {
		case ev := <-sub.C():
			if u, ok := ev.(Updated); ok && u.Thread.ID == s.ID && u.Thread.StatusReason == "finished" {
				t.Errorf("published %v %q on the way out", u.Thread.Status, u.Thread.StatusReason)
			}
		default:
			drained = true
		}
	}
}

// A message sent after the turn's end starts a new process. However late the put-away gets
// there (a slow thread below it holds an archive up), it must only wait for the process
// the turn's end closed: the new one is the user's turn, and the threads below and the
// shells stay.
func TestPutAwayAtTurnEndGivesWayToANewProcess(t *testing.T) {
	for _, form := range []struct {
		name string
		p    PutAway
	}{
		{name: "archive", p: PutAway{Kind: PutAwayArchive}},
		{name: "snooze", p: PutAway{Kind: PutAwaySnooze, Until: time.Now().Add(time.Hour)}},
		{name: "save", p: PutAway{Kind: PutAwaySave}},
	} {
		t.Run(form.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, fixturePath("write-allow"), nil)
			s := e.asking(e.create(CreateOptions{Name: "Lead", InitialPrompt: "write"}).ID)
			kid := e.asking(e.create(CreateOptions{Name: "Worker", InitialPrompt: "write", CreatedBy: s.ID}).ID)
			gone := &runner{id: s.ID, done: make(chan struct{})}
			close(gone.done)
			_, err := e.m.applyPutAway(e.ctx(), s.ID, form.p, gone)
			if !errors.Is(err, ErrFailedPrecondition) {
				t.Fatalf("err = %v, want ErrFailedPrecondition", err)
			}
			got, err := e.m.Get(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.State != StateConnected || !got.ArchivedAt.IsZero() || got.Snoozed() {
				t.Errorf("thread = %v archived %v snoozed %v, want it left running", got.State, got.ArchivedAt, got.Snoozed())
			}
			below, err := e.m.Get(e.ctx(), kid.ID)
			if err != nil {
				t.Fatal(err)
			}
			if below.State != StateConnected || !below.ArchivedAt.IsZero() {
				t.Errorf("the thread below = %v archived %v, want it left running", below.State, below.ArchivedAt)
			}
		})
	}
}

// A thread not mid-turn is put away at once, as any caller's would be.
func TestPutAwaySelfNotMidTurn(t *testing.T) {
	for _, f := range putAwayForms {
		t.Run(f.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, fixturePath("text-table"), nil)
			s := e.create(CreateOptions{})
			e.waitFor(s.ID, "at its prompt", func(s Thread) bool { return s.State == StateConnected && s.Status == StatusIdle })
			got, deferred, err := e.m.PutAwaySelf(e.ctx(), s.ID, f.p(time.Now()))
			if err != nil || deferred || !f.done(got) || got.State != StateDisconnected {
				t.Errorf("PutAwaySelf = %+v, deferred %v, %v", got, deferred, err)
			}
		})
	}
}

// What the plain calls refuse stays refused, at once, with nothing pending.
func TestPutAwaySelfRefusals(t *testing.T) {
	e, s := midTurnAt(t, fixturePath("write-allow"), nil)
	if _, _, err := e.m.PutAwaySelf(e.ctx(), s.ID, PutAway{Kind: PutAwaySnooze, Until: time.Now().Add(-time.Minute)}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("a past snooze: %v", err)
	}
	if _, _, err := e.m.PutAwaySelf(e.ctx(), "s-nope", PutAway{Kind: PutAwayArchive}); !errors.Is(err, ErrNotFound) {
		t.Errorf("an unknown thread: %v", err)
	}
	if p := e.pendingPutAway(s.ID); p != nil {
		t.Errorf("pending after a refusal: %+v", p)
	}
	e.m.mu.Lock()
	rec := e.m.recs[s.ID]
	rec.s.Kind, rec.s.ResidentName = KindResident, "ember"
	e.m.commitLocked(rec, false)
	e.m.mu.Unlock()
	for _, f := range putAwayForms {
		if _, _, err := e.m.PutAwaySelf(e.ctx(), s.ID, f.p(time.Now())); !errors.Is(err, ErrFailedPrecondition) {
			t.Errorf("%s of a resident: %v", f.name, err)
		}
	}
	if p := e.pendingPutAway(s.ID); p != nil {
		t.Errorf("pending after a refusal: %+v", p)
	}
}

// The turn's end archives like any archive: a child its creator watches wakes no one,
// though the turn ended by itself rather than by the close. A plain turn end does wake it,
// so the count means something. The subscription is to idle, or the prompt that holds the
// turn open would be a wake of its own. A hidden thread below it holds the archive up in
// its cascade, past the debounce that publishes idle: the wakes must be gone before that.
func TestPutAwaySelfArchiveWakesNoOne(t *testing.T) {
	tests := []struct {
		name      string
		putAway   bool
		below     bool
		wantWakes int
	}{
		{name: "archiving itself", putAway: true, wantWakes: 0},
		{name: "archiving itself, a slow thread below it", putAway: true, below: true, wantWakes: 0},
		{name: "a plain turn end", wantWakes: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, fixturePath("write-allow"), []string{"CF_FAKE_CLAUDE_EXIT_DELAY=400ms"}, func(o *Options) { o.WakeBatch = -1 })
			parent := e.stopped("Lead")
			kid := e.create(CreateOptions{Name: "Worker", InitialPrompt: "write", CreatedBy: parent.ID})
			s := e.asking(kid.ID)
			if tt.below {
				e.asking(e.create(CreateOptions{Name: "Helper", InitialPrompt: "write", CreatedBy: kid.ID}).ID)
			}
			if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetThreadID: kid.ID, Condition: CondIdle, Repeat: true}); err != nil {
				t.Fatal(err)
			}
			if tt.putAway {
				e.putAwaySelf(s, PutAway{Kind: PutAwayArchive})
			}
			e.allow(s)
			if tt.putAway {
				e.waitFor(kid.ID, "archived", func(s Thread) bool { return !s.ArchivedAt.IsZero() })
			} else {
				e.waitFor(kid.ID, "the turn's end", func(s Thread) bool { return s.StatusReason == "finished" })
			}
			time.Sleep(200 * time.Millisecond) // a wake would go at once
			if n := len(wakes(e.items(parent.ID).Items)); n != tt.wantWakes {
				t.Errorf("the creator got %d wakes, want %d", n, tt.wantWakes)
			}
		})
	}
}

// Snoozing shares archive's guard: a cut-off turn reads idle "snoozed", published that way
// from the first, and what was wrong before the snooze stays.
func TestSnoozeStatus(t *testing.T) {
	snooze := func(e *env, id string) (Thread, error) { return e.m.Snooze(e.ctx(), id, time.Now().Add(time.Hour)) }
	save := func(e *env, id string) (Thread, error) { return e.m.SaveForLater(e.ctx(), id) }
	tests := []struct {
		name       string
		setup      statusSetup
		do         func(e *env, id string) (Thread, error)
		before     func(e *env, s Thread)
		want       Status
		wantReason string
	}{
		{name: "busy", setup: busySetup, do: snooze, want: StatusIdle, wantReason: ReasonSnoozed},
		{name: "busy, saved", setup: busySetup, do: save, want: StatusIdle, wantReason: ReasonSnoozed},
		{name: "at a permission prompt", setup: permissionSetup, do: snooze, want: StatusIdle, wantReason: ReasonSnoozed},
		{name: "idle", setup: idleSetup, do: snooze, want: StatusIdle, wantReason: "at prompt"},
		{name: "crashed before", setup: busySetup, do: snooze, want: StatusError, wantReason: ReasonCrashed,
			before: func(e *env, s Thread) {
				e.exit(s.ID, 1)
				e.waitFor(s.ID, "crashed", func(s Thread) bool { return s.State == StateDisconnected })
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, s := tt.setup.start(t)
			if tt.before != nil {
				tt.before(e, s)
			}
			sub := bus.Subscribe[Event](e.bus, 1024)
			defer sub.Close()
			got, err := tt.do(e, s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != tt.want || got.StatusReason != tt.wantReason {
				t.Errorf("snoozed status %v %q, want %v %q", got.Status, got.StatusReason, tt.want, tt.wantReason)
			}
			for drained := false; !drained; {
				select {
				case ev := <-sub.C():
					if u, ok := ev.(Updated); ok && u.Thread.ID == s.ID && u.Thread.StatusReason == ReasonInterrupted {
						t.Errorf("published %v %q while snoozing", u.Thread.Status, u.Thread.StatusReason)
					}
				default:
					drained = true
				}
			}
			rows, err := loadThreads(e.ctx(), e.m.opts.DB)
			if err != nil || len(rows) != 1 {
				t.Fatalf("load = %v, %v", rows, err)
			}
			if r := rows[0]; r.Status != tt.want || r.StatusReason != tt.wantReason {
				t.Errorf("persisted %v %q, want %v %q", r.Status, r.StatusReason, tt.want, tt.wantReason)
			}
		})
	}
}

// A plain snooze or archive whose own request ends mid-close fails, and the turn it cut
// off reads what it is: the thread is not put away, so nothing explains it otherwise.
func TestPutAwayFailedRequestReadsInterrupted(t *testing.T) {
	tests := []struct {
		name string
		do   func(ctx context.Context, e *env, id string) error
	}{
		{"archive", func(ctx context.Context, e *env, id string) error { _, err := e.m.Archive(ctx, id, true); return err }},
		{"snooze", func(ctx context.Context, e *env, id string) error {
			_, err := e.m.Snooze(ctx, id, time.Now().Add(time.Hour))
			return err
		}},
		{"save", func(ctx context.Context, e *env, id string) error { _, err := e.m.SaveForLater(ctx, id); return err }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, hangFixture(t), []string{"CF_FAKE_CLAUDE_EXIT_DELAY=300ms"})
			s := e.create(CreateOptions{InitialPrompt: "go"})
			e.waitFor(s.ID, "busy", func(s Thread) bool { return s.State == StateConnected && s.Status == StatusBusy })
			ctx, cancel := context.WithCancel(e.ctx())
			defer cancel()
			go func() {
				e.waitFor(s.ID, "closing", func(s Thread) bool { return s.State == StateClosing })
				cancel()
			}()
			if err := tt.do(ctx, e, s.ID); !errors.Is(err, context.Canceled) {
				t.Fatalf("err = %v, want cancelled", err)
			}
			got := e.waitFor(s.ID, "stopped", func(s Thread) bool { return s.State == StateDisconnected })
			if got.Status != StatusError || got.StatusReason != ReasonInterrupted || !got.ArchivedAt.IsZero() || got.Snoozed() {
				t.Errorf("end state %v %q, archived %v, snoozed %v", got.Status, got.StatusReason, got.ArchivedAt, got.Snoozed())
			}
		})
	}
}

// endPuttingAway falls back only for a turn this very close cut off.
func TestEndPuttingAway(t *testing.T) {
	now := time.Now()
	tests := []struct {
		name       string
		away       awayClose
		failed     bool
		thread     func(*Thread)
		want       Status
		wantReason string
	}{
		{name: "a failed archive after its close", away: awayClose{ReasonArchived, true}, failed: true, want: StatusError, wantReason: ReasonInterrupted},
		{name: "a failed snooze after its close", away: awayClose{ReasonSnoozed, true}, failed: true, want: StatusError, wantReason: ReasonInterrupted},
		{name: "one that worked", away: awayClose{ReasonSnoozed, true}, want: StatusIdle, wantReason: ReasonSnoozed},
		{name: "the idle reason left by an earlier snooze", away: awayClose{ReasonSnoozed, false}, failed: true, want: StatusIdle, wantReason: ReasonSnoozed},
		{name: "snoozed meanwhile", away: awayClose{ReasonSnoozed, true}, failed: true, want: StatusIdle, wantReason: ReasonSnoozed,
			thread: func(s *Thread) { s.SavedAt = now }},
		{name: "archived meanwhile", away: awayClose{ReasonSnoozed, true}, failed: true, want: StatusIdle, wantReason: ReasonSnoozed,
			thread: func(s *Thread) { s.ArchivedAt = now }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.stopped("away")
			e.m.mu.Lock()
			rec := e.m.recs[s.ID]
			rec.s.Status, rec.s.StatusReason = StatusIdle, tt.away.reason
			if tt.thread != nil {
				tt.thread(&rec.s)
			}
			a := tt.away
			rec.away = &a
			e.m.mu.Unlock()
			e.m.endPuttingAway(s.ID, tt.failed)
			e.m.mu.Lock()
			got, cleared := rec.s, rec.away == nil
			e.m.mu.Unlock()
			if got.Status != tt.want || got.StatusReason != tt.wantReason || !cleared {
				t.Errorf("status %v %q (cleared %v), want %v %q", got.Status, got.StatusReason, cleared, tt.want, tt.wantReason)
			}
		})
	}
}
