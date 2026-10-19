package thread

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestResumeNoteText(t *testing.T) {
	const tail = ", not rejected by anyone; your last tool call may have run partially, so check its effects before repeating it."
	tests := []struct {
		name   string
		note   ResumeNote
		budget float64
		want   string
	}{
		{"none", ResumeNote{}, 1, ""},
		{"unknown cause", ResumeNote{Cause: "later"}, 1, ""},
		{"budget raised", ResumeNote{Cause: ResumeBudget, BudgetUSD: 0.5}, 1,
			"[code-foundry] Your previous turn was stopped by Code Foundry at its $0.50 spending limit (now $1.00)" + tail},
		{"budget unchanged", ResumeNote{Cause: ResumeBudget, BudgetUSD: 0.5}, 0.5,
			"[code-foundry] Your previous turn was stopped by Code Foundry at its $0.50 spending limit" + tail},
		{"budget removed", ResumeNote{Cause: ResumeBudget, BudgetUSD: 0.02}, 0,
			"[code-foundry] Your previous turn was stopped by Code Foundry at its $0.02 spending limit (now no limit)" + tail},
		{"interrupt by a named thread", ResumeNote{Cause: ResumeInterrupt, By: "s-1a2b", ByName: "Orchestrate the fixes"}, 0,
			`[code-foundry] Your previous turn was interrupted by thread "Orchestrate the fixes" (s-1a2b) through Code Foundry` + tail},
		{"interrupt by an unnamed thread", ResumeNote{Cause: ResumeInterrupt, By: "s-1a2b"}, 0,
			"[code-foundry] Your previous turn was interrupted by thread s-1a2b through Code Foundry" + tail},
		{"restart", ResumeNote{Cause: ResumeRestart}, 3,
			"[code-foundry] Your previous turn was stopped because the Code Foundry app restarted" + tail},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.note.Text(tt.budget); got != tt.want {
				t.Errorf("Text = %q\nwant   %q", got, tt.want)
			}
		})
	}
}

func TestResumeNoteColumn(t *testing.T) {
	at := time.Date(2026, 10, 19, 10, 38, 3, 167e6, time.UTC)
	tests := []struct {
		name string
		col  string
		want ResumeNote
	}{
		{"empty", "", ResumeNote{}},
		{"malformed", "{budget", ResumeNote{}},
		{"budget", resumeNoteJSON(ResumeNote{Cause: ResumeBudget, BudgetUSD: 0.5, At: at}), ResumeNote{Cause: ResumeBudget, BudgetUSD: 0.5, At: at}},
		{"interrupt", resumeNoteJSON(ResumeNote{Cause: ResumeInterrupt, By: "s-1", ByName: "Lead", At: at}), ResumeNote{Cause: ResumeInterrupt, By: "s-1", ByName: "Lead", At: at}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseResumeNote(tt.col)
			if got.Cause != tt.want.Cause || got.BudgetUSD != tt.want.BudgetUSD || got.By != tt.want.By || got.ByName != tt.want.ByName || !got.At.Equal(tt.want.At) {
				t.Errorf("parse(%q) = %+v, want %+v", tt.col, got, tt.want)
			}
		})
	}
	if got := resumeNoteJSON(ResumeNote{}); got != "" {
		t.Errorf("no note = %q, want empty", got)
	}
}

// waitUserText waits for a user message on the fake's stdin whose text has prefix.
func (e *env) waitUserText(prefix string) string {
	e.t.Helper()
	return userTextOf(e.waitSent("a message starting "+prefix, func(m map[string]any) bool {
		return strings.HasPrefix(userTextOf(m), prefix)
	}))
}

// The budget stop leaves a note that survives a restart; the next message, whoever
// sends it, starts with it (the budget raised since), its item keeps it, and it is
// cleared, for good, once sent.
func TestResumeNoteBudget(t *testing.T) {
	e := newFixtureEnv(t, "interrupt-pending")
	s := e.create(CreateOptions{BudgetUSD: 0.001, InitialPrompt: "write hello.txt"})
	e.waitFor(s.ID, "the permission prompt", func(s Thread) bool { return strings.HasPrefix(s.StatusReason, "permission:") })
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.writeTranscript(cid, userLine("write hello.txt"), usageLine("r1", "2026-10-17T00:00:00Z", cid, "claude-sonnet-5-5", 1000, 0, 0, 0, "", ""))
	got := e.waitFor(s.ID, "the budget note", func(s Thread) bool { return s.ResumeNote.Pending() })
	if got.ResumeNote.Cause != ResumeBudget || got.ResumeNote.BudgetUSD != 0.001 {
		t.Fatalf("note = %+v", got.ResumeNote)
	}
	e.waitItems(s.ID, "the turn end", hasTurnEnd)
	if _, err := e.m.SetBudget(e.ctx(), s.ID, 1); err != nil {
		t.Fatal(err)
	}

	// At the prompt when the daemon stops: the budget note stays, persisted.
	e.restart()
	if after, _ := e.m.Get(e.ctx(), s.ID); after.ResumeNote.Cause != ResumeBudget || after.ResumeNote.BudgetUSD != 0.001 {
		t.Fatalf("after restart: note = %+v", after.ResumeNote)
	}

	want := "[code-foundry] Your previous turn was stopped by Code Foundry at its $0.001 spending limit (now $1.00), not rejected by anyone;"
	it, err := e.m.Send(e.ctx(), s.ID, Message{Text: "continue", Origin: OriginWake, WakeTitle: "t", WakeJSON: "{}"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(it.ResumeNote, want) || it.Text != "continue" {
		t.Errorf("item = %q / %q", it.ResumeNote, it.Text)
	}
	if text := e.waitUserText(want); !strings.HasSuffix(text, "repeating it.\n\ncontinue") {
		t.Errorf("Claude got %q", text)
	}
	e.waitFor(s.ID, "the note cleared", func(s Thread) bool { return !s.ResumeNote.Pending() })
	// The item's note is persisted with it.
	items := e.waitItems(s.ID, "the item", func(items []Item) bool {
		for _, x := range items {
			if x.ID == it.ID {
				return true
			}
		}
		return false
	})
	for _, x := range items {
		if x.ID == it.ID && x.ResumeNote != it.ResumeNote {
			t.Errorf("item note = %q", x.ResumeNote)
		}
	}
	// The clear is persisted (the turn it started still runs: a restart now would
	// leave a restart note, TestResumeNoteRestart).
	rows, err := loadThreads(e.ctx(), e.m.opts.DB)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.ID == s.ID && r.ResumeNote.Pending() {
			t.Errorf("saved note after the send: %+v", r.ResumeNote)
		}
	}
	saved, err := loadItems(e.ctx(), e.m.opts.DB, s.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range saved {
		if x.ID == it.ID && x.ResumeNote != it.ResumeNote {
			t.Errorf("saved item note = %q", x.ResumeNote)
		}
	}
}

// Another thread's interrupt of a running turn leaves a note naming it; the user's
// (no by), a thread's own, or one of an idle thread does not.
func TestResumeNoteInterrupt(t *testing.T) {
	e := newFixtureEnv(t, "interrupt-pending")
	lead := e.connected(CreateOptions{Name: "Lead"})
	s := e.create(CreateOptions{InitialPrompt: "write hello.txt"})
	e.waitFor(s.ID, "the permission prompt", func(s Thread) bool { return strings.HasPrefix(s.StatusReason, "permission:") })
	if err := e.m.Interrupt(e.ctx(), s.ID, lead.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := e.m.Get(e.ctx(), s.ID)
	if n := got.ResumeNote; n.Cause != ResumeInterrupt || n.By != lead.ID || n.ByName != "Lead" {
		t.Fatalf("note = %+v", n)
	}
	e.waitItems(s.ID, "the turn end", hasTurnEnd)
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "go on"}); err != nil {
		t.Fatal(err)
	}
	e.waitUserText(`[code-foundry] Your previous turn was interrupted by thread "Lead" (` + lead.ID + ") through Code Foundry")

	tests := []struct {
		name    string
		by      string
		midTurn bool
		want    bool
	}{
		{"the user", "", true, false},
		{"itself", s.ID, true, false},
		{"another thread, idle", lead.ID, false, false},
		{"another thread that is gone", "s-gone", true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e.m.update(s.ID, false, func(r *record) { r.s.ResumeNote = ResumeNote{} })
			e.m.noteInterrupt(s.ID, tt.by, tt.midTurn)
			n, _ := e.m.Get(context.Background(), s.ID)
			if n.ResumeNote.Pending() != tt.want {
				t.Errorf("note = %+v, want pending %v", n.ResumeNote, tt.want)
			}
			if tt.want && n.ResumeNote.ByName != "" {
				t.Errorf("a gone thread's name = %q", n.ResumeNote.ByName)
			}
		})
	}
}

func TestMidTurn(t *testing.T) {
	tests := []struct {
		name string
		s    Thread
		want bool
	}{
		{"busy", Thread{Status: StatusBusy}, true},
		{"asking", Thread{Status: StatusNeedsAttention, StatusReason: "permission: Write a.txt", PendingRequestID: "r1"}, true},
		{"asking, as loaded", Thread{Status: StatusNeedsAttention, StatusReason: "question: Which one?"}, true},
		{"finished", Thread{Status: StatusNeedsAttention, StatusReason: "finished"}, false},
		{"budget reached", Thread{Status: StatusNeedsAttention, StatusReason: ReasonBudgetReached}, false},
		{"idle", Thread{Status: StatusIdle}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := midTurn(tt.s); got != tt.want {
				t.Errorf("midTurn = %v, want %v", got, tt.want)
			}
		})
	}
}

// A turn the daemon's stop cuts off, or one that died with the daemon, leaves a
// restart note; a thread at its prompt gets none.
func TestResumeNoteRestart(t *testing.T) {
	e := newFixtureEnv(t, "interrupt-pending")
	idle := e.connected(CreateOptions{})
	s := e.create(CreateOptions{InitialPrompt: "write hello.txt"})
	e.waitFor(s.ID, "the permission prompt", func(s Thread) bool { return strings.HasPrefix(s.StatusReason, "permission:") })
	e.restart()
	if got, _ := e.m.Get(e.ctx(), s.ID); got.ResumeNote.Cause != ResumeRestart {
		t.Errorf("stopped mid-turn: note = %+v", got.ResumeNote)
	}
	if got, _ := e.m.Get(e.ctx(), idle.ID); got.ResumeNote.Pending() {
		t.Errorf("stopped at its prompt: note = %+v", got.ResumeNote)
	}

	// The daemon died: the row still says connected and busy.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	row, _ := e.m.Get(ctx, idle.ID)
	row.State, row.Status, row.StatusReason = StateConnected, StatusBusy, "working"
	if err := saveThread(ctx, e.m.opts.DB, row); err != nil {
		t.Fatal(err)
	}
	e.open()
	if got, _ := e.m.Get(e.ctx(), idle.ID); got.ResumeNote.Cause != ResumeRestart || got.Status != StatusError {
		t.Errorf("died mid-turn: note = %+v, status %s", got.ResumeNote, got.Status)
	}
}
