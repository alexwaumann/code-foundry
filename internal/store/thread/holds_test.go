package thread

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// The user's put-aways hold (holds.go, docs/notes/snooze-holds-archive-refuses.md).

// family is a lead, its worker and the worker's worker, plus a thread unrelated to them,
// all stopped. Which of them is archived or snoozed is each test's.
type family struct {
	lead, worker, grand, other Thread
}

func (e *env) family() family {
	e.t.Helper()
	l := family{lead: e.stopped("lead"), worker: e.stopped("worker"), grand: e.stopped("grand"), other: e.stopped("other")}
	e.setCreatedBy(l.worker.ID, l.lead.ID)
	e.setCreatedBy(l.grand.ID, l.worker.ID)
	return l
}

func (e *env) setCreatedBy(id, by string) {
	e.t.Helper()
	if _, ok := e.m.update(id, true, func(rec *record) { rec.s.CreatedBy = by }); !ok {
		e.t.Fatalf("no thread %s", id)
	}
}

// archive archives id as the user.
func (e *env) archive(id string) Thread {
	e.t.Helper()
	s, err := e.m.Archive(e.ctx(), id, true)
	if err != nil || s.ArchivedAt.IsZero() {
		e.t.Fatalf("Archive = %+v, %v", s, err)
	}
	return s
}

// snoozeFor snoozes id as the user, an hour from now.
func (e *env) snoozeFor(id string) Thread {
	e.t.Helper()
	s, err := e.m.Snooze(e.ctx(), id, e.m.opts.Now().Add(time.Hour))
	if err != nil || s.SnoozedUntil.IsZero() {
		e.t.Fatalf("Snooze = %+v, %v", s, err)
	}
	return s
}

func TestCreatedByLocked(t *testing.T) {
	e := newEnv(t)
	l := e.family()
	tests := []struct {
		name    string
		id, by  string
		created bool
	}{
		{"the creator", l.worker.ID, l.lead.ID, true},
		{"the creator's creator", l.grand.ID, l.lead.ID, true},
		{"an unrelated thread", l.worker.ID, l.other.ID, false},
		{"the thread it created", l.worker.ID, l.grand.ID, false},
		{"itself", l.worker.ID, l.worker.ID, false},
		{"the user", l.worker.ID, "", false},
		{"a thread the user made", l.lead.ID, l.other.ID, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e.m.mu.Lock()
			got := e.m.createdByLocked(tt.id, tt.by)
			e.m.mu.Unlock()
			if got != tt.created {
				t.Errorf("createdByLocked(%s, %q) = %v, want %v", tt.id, tt.by, got, tt.created)
			}
		})
	}

	// A removed thread ends the chain: its threads are the user's from then on.
	e.m.mu.Lock()
	delete(e.m.recs, l.worker.ID)
	got := e.m.createdByLocked(l.grand.ID, l.lead.ID)
	e.m.mu.Unlock()
	if got {
		t.Error("the chain went through a removed thread")
	}

	// A cycle (only a corrupt row) ends.
	e2 := newEnv(t)
	a, b := e2.stopped("a"), e2.stopped("b")
	e2.setCreatedBy(a.ID, b.ID)
	e2.setCreatedBy(b.ID, a.ID)
	e2.m.mu.Lock()
	got = e2.m.createdByLocked(a.ID, "s-nobody")
	e2.m.mu.Unlock()
	if got {
		t.Error("a cycle made a stranger the creator")
	}
}

// Every route that unarchives, for each kind of caller: the user and the thread's
// creators may, any other thread (or a wake) is refused and the thread stays archived.
func TestArchivedRefusesThreadsThatDidNotCreateIt(t *testing.T) {
	type caller func(l family) string
	user := func(family) string { return "" }
	lead := func(l family) string { return l.lead.ID }
	worker := func(l family) string { return l.worker.ID }
	other := func(l family) string { return l.other.ID }
	grand := func(l family) string { return l.grand.ID }
	send := func(e *env, id, by string) error {
		_, err := e.m.Send(e.ctx(), id, Message{Text: "hello", ByThreadID: by})
		return err
	}
	unarchive := func(e *env, id, by string) error {
		_, err := e.m.Archive(AskedBy(e.ctx(), by), id, false)
		return err
	}
	pin := func(e *env, id, by string) error {
		_, err := e.m.Pin(AskedBy(e.ctx(), by), id, true)
		return err
	}
	snooze := func(e *env, id, by string) error {
		_, err := e.m.Snooze(AskedBy(e.ctx(), by), id, e.m.opts.Now().Add(time.Hour))
		return err
	}
	save := func(e *env, id, by string) error {
		_, err := e.m.SaveForLater(AskedBy(e.ctx(), by), id)
		return err
	}
	tests := []struct {
		name   string
		target func(l family) Thread
		by     caller
		act    func(e *env, id, by string) error
		ok     bool
	}{
		{"the user sends", func(l family) Thread { return l.worker }, user, send, true},
		{"its creator sends", func(l family) Thread { return l.worker }, lead, send, true},
		{"its creator's creator sends", func(l family) Thread { return l.grand }, lead, send, true},
		{"an unrelated thread sends", func(l family) Thread { return l.worker }, other, send, false},
		{"a thread it created sends", func(l family) Thread { return l.worker }, grand, send, false},
		{"a thread sends to the user's thread", func(l family) Thread { return l.lead }, worker, send, false},

		{"the user unarchives", func(l family) Thread { return l.worker }, user, unarchive, true},
		{"its creator unarchives", func(l family) Thread { return l.worker }, lead, unarchive, true},
		{"an unrelated thread unarchives", func(l family) Thread { return l.worker }, other, unarchive, false},

		{"the user pins", func(l family) Thread { return l.worker }, user, pin, true},
		{"its creator pins", func(l family) Thread { return l.grand }, lead, pin, true},
		{"an unrelated thread pins", func(l family) Thread { return l.worker }, other, pin, false},

		{"the user snoozes", func(l family) Thread { return l.worker }, user, snooze, true},
		{"its creator snoozes", func(l family) Thread { return l.worker }, lead, snooze, true},
		{"an unrelated thread snoozes", func(l family) Thread { return l.worker }, other, snooze, false},
		{"an unrelated thread saves it for later", func(l family) Thread { return l.worker }, other, save, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			l := e.family()
			target := tt.target(l)
			e.archive(target.ID)
			err := tt.act(e, target.ID, tt.by(l))
			if tt.ok {
				if err != nil {
					t.Fatalf("refused: %v", err)
				}
				e.waitFor(target.ID, "unarchived", func(s Thread) bool { return s.ArchivedAt.IsZero() })
				return
			}
			if !errors.Is(err, ErrFailedPrecondition) {
				t.Fatalf("err = %v, want FailedPrecondition", err)
			}
			for _, want := range []string{"thread " + target.ID + " is archived", "only the user can unarchive it", "code-foundry thread read " + target.ID, "tell the user"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("err %q lacks %q", err, want)
				}
			}
			got, gerr := e.m.Get(e.ctx(), target.ID)
			if gerr != nil || got.ArchivedAt.IsZero() || got.State != StateDisconnected || got.Pinned || got.Snoozed() {
				t.Errorf("after the refusal = %+v, %v; want archived and stopped as it was", got, gerr)
			}
			// A refused message left nothing in the timeline (a stopped thread writes its
			// message's item before it starts).
			for _, it := range e.items(target.ID).Items {
				if it.Kind == KindUserMessage && it.Text == "hello" {
					t.Errorf("the refused message is in the timeline: %+v", it)
				}
			}
			// Reading stays allowed.
			if _, err := e.m.Items(e.ctx(), target.ID); err != nil {
				t.Errorf("reading the archived thread: %v", err)
			}
		})
	}
}

// A wake (no thread, not the user) to an archived thread is refused: its subscriptions
// went with the archive, so only a race gets here.
func TestArchivedRefusesAWake(t *testing.T) {
	e := newEnv(t)
	s := e.stopped("archived")
	e.archive(s.ID)
	_, err := e.m.Send(e.ctx(), s.ID, Message{Text: "wake", Origin: OriginWake, WakeTitle: "t"})
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "a wake does not unarchive it") {
		t.Fatalf("err = %v", err)
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.ArchivedAt.IsZero() {
		t.Error("the wake unarchived it")
	}
}

// A message or a wake that is not the user's does not end a snooze: the thread starts,
// answers and stays snoozed with its time. The user's message ends it.
func TestSnoozeHoldsAMessage(t *testing.T) {
	tests := []struct {
		name string
		msg  func(l family) Message
		held bool
	}{
		{"an unrelated thread's message", func(l family) Message { return Message{Text: "do it", ByThreadID: l.other.ID} }, true},
		{"its creator's message", func(l family) Message { return Message{Text: "do it", ByThreadID: l.lead.ID} }, true},
		{"a wake", func(family) Message { return Message{Text: "wake", Origin: OriginWake, WakeTitle: "t"} }, true},
		{"the user's message", func(family) Message { return Message{Text: "do it"} }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			l := e.family()
			snoozed := e.snoozeFor(l.worker.ID)
			if _, err := e.m.Send(e.ctx(), l.worker.ID, tt.msg(l)); err != nil {
				t.Fatal(err)
			}
			got := e.waitFor(l.worker.ID, "the answer", func(s Thread) bool {
				return s.State == StateConnected && s.Status != StatusBusy && s.Status != StatusUnknown
			})
			if tt.held {
				if !got.SnoozedUntil.Equal(snoozed.SnoozedUntil) {
					t.Errorf("snoozed until %v after the message, want %v", got.SnoozedUntil, snoozed.SnoozedUntil)
				}
				e.restart()
				// Persisted at millisecond precision.
				if got, _ := e.m.Get(e.ctx(), l.worker.ID); got.SnoozedUntil.UnixMilli() != snoozed.SnoozedUntil.UnixMilli() {
					t.Errorf("after restart snoozed until %v, want %v", got.SnoozedUntil, snoozed.SnoozedUntil)
				}
				return
			}
			if got.Snoozed() {
				t.Errorf("the user's message left it snoozed until %v", got.SnoozedUntil)
			}
		})
	}
}

// Ending a snooze any other way than a message is the user's, or its creator's: a thread
// that did not create it is refused and the snooze stays.
func TestSnoozeRefusesThreadsThatDidNotCreateIt(t *testing.T) {
	dismiss := func(e *env, id, by string) (Thread, error) {
		return e.m.Snooze(AskedBy(e.ctx(), by), id, time.Time{})
	}
	pin := func(e *env, id, by string) (Thread, error) {
		return e.m.Pin(AskedBy(e.ctx(), by), id, true)
	}
	tests := []struct {
		name string
		by   func(l family) string
		act  func(e *env, id, by string) (Thread, error)
		ok   bool
	}{
		{"the user dismisses", func(family) string { return "" }, dismiss, true},
		{"its creator dismisses", func(l family) string { return l.lead.ID }, dismiss, true},
		{"an unrelated thread dismisses", func(l family) string { return l.other.ID }, dismiss, false},
		{"the thread itself dismisses", func(l family) string { return l.worker.ID }, dismiss, false},
		{"the user pins", func(family) string { return "" }, pin, true},
		{"an unrelated thread pins", func(l family) string { return l.other.ID }, pin, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			l := e.family()
			snoozed := e.snoozeFor(l.worker.ID)
			got, err := tt.act(e, l.worker.ID, tt.by(l))
			if tt.ok {
				if err != nil || got.Snoozed() {
					t.Errorf("= %v, %v; want unsnoozed", got.SnoozedUntil, err)
				}
				return
			}
			if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "only the user ends a snooze") {
				t.Fatalf("err = %v", err)
			}
			if got, _ := e.m.Get(e.ctx(), l.worker.ID); !got.SnoozedUntil.Equal(snoozed.SnoozedUntil) || got.Pinned {
				t.Errorf("after the refusal = until %v pinned %v; want the snooze kept", got.SnoozedUntil, got.Pinned)
			}
		})
	}
	// Unpinning never unsnoozes, so it is never refused.
	e := newEnv(t)
	l := e.family()
	e.snoozeFor(l.worker.ID)
	if _, err := e.m.Pin(AskedBy(e.ctx(), l.other.ID), l.worker.ID, false); err != nil {
		t.Errorf("unpin: %v", err)
	}
}

// A snoozed thread a thread's message started asks the user (a permission); answering it
// is not the user picking it back up: the snooze holds through the ask and its answer,
// with its time unchanged.
func TestSnoozeHoldsThroughAnAsk(t *testing.T) {
	e := newFixtureEnv(t, "write-allow")
	asker := e.stopped("asker")
	b := e.stopped("snoozed")
	snoozed := e.snoozeFor(b.ID)
	if _, err := e.m.Send(e.ctx(), b.ID, Message{Text: "write", ByThreadID: asker.ID}); err != nil {
		t.Fatal(err)
	}
	ask := e.asking(b.ID)
	if ask.Status != StatusNeedsAttention || !ask.SnoozedUntil.Equal(snoozed.SnoozedUntil) {
		t.Fatalf("asking = %s %q until %v; want needs attention, still snoozed until %v", ask.Status, ask.StatusReason, ask.SnoozedUntil, snoozed.SnoozedUntil)
	}
	e.allow(ask)
	got := e.waitFor(b.ID, "the turn's end", func(s Thread) bool {
		return s.PendingRequestID == "" && s.Status != StatusBusy && !strings.HasPrefix(s.StatusReason, "permission:")
	})
	if !got.SnoozedUntil.Equal(snoozed.SnoozedUntil) {
		t.Errorf("after the answer snoozed until %v, want %v", got.SnoozedUntil, snoozed.SnoozedUntil)
	}
}

// The snooze's time arriving while a thread's message keeps it working ends the snooze
// as it always did: cleared, with no "snooze ended" attention (it is working).
func TestSnoozeEndsWhileWorking(t *testing.T) {
	clk := newTestClock()
	e := newFixtureEnvAt(t, hangFixture(t), nil, clk.opts())
	asker := e.stopped("asker")
	b := e.stopped("snoozed")
	e.snoozeFor(b.ID)
	if _, err := e.m.Send(e.ctx(), b.ID, Message{Text: "go", ByThreadID: asker.ID}); err != nil {
		t.Fatal(err)
	}
	busy := e.waitFor(b.ID, "busy", func(s Thread) bool { return s.State == StateConnected && s.Status == StatusBusy })
	if !busy.Snoozed() {
		t.Fatal("the thread's message ended the snooze")
	}
	clk.advance(2 * time.Hour)
	got := e.waitFor(b.ID, "the snooze's end", func(s Thread) bool { return !s.Snoozed() })
	if got.Status != StatusBusy || got.StatusReason == ReasonSnoozeEnded {
		t.Errorf("woken while working = %s %q; want still busy, no attention", got.Status, got.StatusReason)
	}
}

// A setup retry unarchives: refused on an archived thread a thread did not create. Like a
// message it never ends a thread's snooze.
func TestRetrySetupHolds(t *testing.T) {
	tests := []struct {
		name string
		put  func(rec *record)
		by   string
		ok   bool
		want func(Thread) bool
	}{
		{"a thread on an archived thread", func(rec *record) { rec.s.ArchivedAt = time.Now() }, "s-other", false, nil},
		{"the user on an archived thread", func(rec *record) { rec.s.ArchivedAt = time.Now() }, "", true,
			func(s Thread) bool { return s.ArchivedAt.IsZero() }},
		{"a thread on a snoozed thread", func(rec *record) { rec.s.SnoozedUntil = time.Now().Add(time.Hour) }, "s-other", true,
			func(s Thread) bool { return s.Snoozed() }},
		{"the user on a snoozed thread", func(rec *record) { rec.s.SnoozedUntil = time.Now().Add(time.Hour) }, "", true,
			func(s Thread) bool { return !s.Snoozed() }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, flaky, _ := flakyEnv(t)
			s := failedOnR2(t, e, flaky)
			e.m.update(s.ID, true, tt.put)
			flaky.heal()
			got, err := e.m.RetrySetup(AskedBy(e.ctx(), tt.by), s.ID)
			if !tt.ok {
				if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "is archived") {
					t.Fatalf("err = %v", err)
				}
				if cur, _ := e.m.Get(e.ctx(), s.ID); cur.ArchivedAt.IsZero() || cur.Setup.Phase != SetupFailed {
					t.Errorf("after the refusal = %+v", cur)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !tt.want(got) {
				t.Errorf("after the retry = archived %v snoozed %v", got.ArchivedAt, got.SnoozedUntil)
			}
			e.waitFor(s.ID, "the setup", func(s Thread) bool { return s.Setup == nil || s.Setup.Phase == SetupDone })
		})
	}
}
