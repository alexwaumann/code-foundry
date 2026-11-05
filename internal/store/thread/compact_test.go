package thread

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

func TestCompactHold(t *testing.T) {
	sd := func(busy, compacting bool) *streamStatus {
		return &streamStatus{started: true, busy: busy, compacting: compacting}
	}
	tests := []struct {
		name string
		st   *streamState
		want string
	}{
		{"at the prompt", &streamState{initialized: true, sd: sd(false, false)}, ""},
		{"before the handshake", &streamState{sd: sd(false, false)}, "is starting"},
		{"a restart under way", &streamState{initialized: true, restart: restartClosing, sd: sd(false, false)}, "is restarting"},
		{"a restart wanted", &streamState{initialized: true, wantRestart: true, sd: sd(false, false)}, "is restarting"},
		{"mid-turn", &streamState{initialized: true, sd: sd(true, false)}, "is in the middle of a turn"},
		{"compacting", &streamState{initialized: true, sd: sd(true, true)}, "is already compacting"},
		{"a pending request", &streamState{initialized: true, sd: sd(true, false), pending: map[string]*claudestream.PermissionRequest{"r": nil}}, "is waiting for an answer"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.st.compactHold(); got != tt.want {
				t.Errorf("compactHold = %q, want %q", got, tt.want)
			}
		})
	}
}

// stalled keeps the fake's first turn open: it never reaches its result.
var stalled = []string{"CF_FAKE_CLAUDE_STALL=1"}

// What Compact refuses before and in the runner: nothing reaches Claude or the timeline.
func TestCompactRefusals(t *testing.T) {
	tests := []struct {
		name    string
		fixture string
		vars    []string
		prepare func(e *env) string // the thread to compact
		want    string
		code    error
	}{
		{
			name: "unknown thread", fixture: "text-table",
			prepare: func(*env) string { return "s-nope" },
			want:    "s-nope", code: ErrNotFound,
		},
		{
			name: "no conversation yet", fixture: "text-table",
			prepare: func(e *env) string { return e.connected(CreateOptions{Name: "empty"}).ID },
			want:    "has no conversation to compact yet", code: ErrFailedPrecondition,
		},
		{
			name: "mid-turn", fixture: "text-table", vars: stalled,
			prepare: func(e *env) string {
				s := e.create(CreateOptions{InitialPrompt: "count"})
				e.waitFor(s.ID, "the turn", func(s Thread) bool { return s.State == StateConnected && s.Status == StatusBusy })
				return s.ID
			},
			want: "is in the middle of a turn", code: ErrFailedPrecondition,
		},
		{
			name: "waiting for an answer", fixture: "interrupt-pending",
			prepare: func(e *env) string {
				s := e.create(CreateOptions{InitialPrompt: "write hello.txt"})
				e.waitFor(s.ID, "the permission prompt", func(s Thread) bool { return strings.HasPrefix(s.StatusReason, "permission:") })
				return s.ID
			},
			want: "is waiting for an answer", code: ErrFailedPrecondition,
		},
		{
			name: "a setup that did not finish", fixture: "text-table",
			prepare: func(e *env) string {
				s := e.connected(CreateOptions{Name: "setup"})
				e.m.update(s.ID, false, func(rec *record) { rec.s.Setup = &Setup{Phase: SetupFailed, Error: "no disk"} })
				return s.ID
			},
			want: "did not finish its setup, so it cannot be compacted", code: ErrFailedPrecondition,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newFixtureEnvAt(t, fixturePath(tt.fixture), tt.vars)
			id := tt.prepare(e)
			before := len(e.sent())
			_, err := e.m.Compact(e.ctx(), id)
			if !errors.Is(err, tt.code) || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Compact = %v, want %v with %q", err, tt.code, tt.want)
			}
			if got := len(e.sent()); got != before {
				t.Errorf("%d more lines reached Claude", got-before)
			}
		})
	}
}

// A second press, before the first's turn ended, is refused: one /compact reaches Claude.
func TestCompactTwice(t *testing.T) {
	e := newFixtureEnvAt(t, fixturePath("text-table"), stalled)
	s := e.connected(CreateOptions{Name: "twice"})
	e.putItems(s.ID, Item{ID: "u0", Kind: KindUserMessage, Text: "earlier"})
	if _, err := e.m.Compact(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Compact(e.ctx(), s.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("second Compact = %v", err)
	}
	e.sentUser(compactCommand)
	if n := countSent(e, compactCommand); n != 1 {
		t.Errorf("%d /compact messages reached Claude", n)
	}
}

func countSent(e *env, text string) int {
	n := 0
	for _, m := range e.sent() {
		if userTextOf(m) == text {
			n++
		}
	}
	return n
}

// A /compact the app sent is in the timeline, not in the user's prompt history; one the
// user typed stays there.
func TestCompactLeavesPromptHistory(t *testing.T) {
	e := newFixtureEnv(t, "compact")
	s := e.create(CreateOptions{InitialPrompt: "a table"})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	e.waitFor(s.ID, "the turn over", turnOver)
	it, err := e.m.Compact(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if it.Kind != KindUserMessage || it.Text != compactCommand || it.SentBy != s.ID {
		t.Fatalf("item = %+v", it)
	}
	e.sentUser(compactCommand)
	e.waitItems(s.ID, "the compaction", func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindCompaction })
	})
	after := e.waitFor(s.ID, "the context down", func(s Thread) bool { return s.ContextTokens == 1885 })
	if !turnOver(after) {
		e.waitFor(s.ID, "the turn over", turnOver)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: compactCommand}); err != nil {
		t.Fatal(err)
	}
	got, err := e.m.ListPrompts(e.ctx(), PromptQuery{Scope: PromptScopeThread, ThreadID: s.ID})
	if err != nil {
		t.Fatal(err)
	}
	var texts, ids []string
	for _, p := range got {
		texts, ids = append(texts, p.Text), append(ids, p.ItemID)
	}
	if !slices.Equal(texts, []string{compactCommand, "a table"}) || slices.Contains(ids, it.ID) {
		t.Errorf("prompts = %q (%q), compact item %s", texts, ids, it.ID)
	}
}

// On a stopped thread with notes waiting, Claude gets a bare /compact: anything before it
// makes it plain text. The notes go with the next message.
func TestCompactStoppedKeepsNotes(t *testing.T) {
	entries := []string{"Use tabs"}
	e := newEnv(t, func(o *Options) { o.Memory = func() ([]string, error) { return slices.Clone(entries), nil } })
	s := e.create(CreateOptions{InitialPrompt: "a table"})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	e.resumable(s.ID)
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "stopped", stopped)
	entries = []string{"Use spaces"}
	note := ResumeNote{Cause: ResumeRestart}
	e.m.update(s.ID, true, func(rec *record) { rec.s.ResumeNote = note })

	it, err := e.m.Compact(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	e.sentUser(compactCommand)
	if it.ResumeNote != "" {
		t.Errorf("the item's note = %q", it.ResumeNote)
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.ResumeNote.Cause != note.Cause {
		t.Errorf("the resume note after compacting = %+v", got.ResumeNote)
	}

	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "go on"}); err != nil {
		t.Fatal(err)
	}
	text := userTextOf(e.waitSent("the next message", func(m map[string]any) bool { return strings.HasSuffix(userTextOf(m), "go on") }))
	if !strings.Contains(text, "Use spaces") || !strings.Contains(text, "[code-foundry]") {
		t.Errorf("the next message = %q, want the memory and the resume note", text)
	}
}
