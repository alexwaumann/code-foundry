package thread

import (
	"context"
	"slices"
	"testing"
)

func TestPendingFirstColumn(t *testing.T) {
	full := &PendingFirst{Text: "fix it", Composer: "fix <cf-file>", Prompt: "fix ./a.go", ItemID: "u-1",
		Attachments: []firstAttachment{{Path: "/tmp/a.png", Size: 3}, {Path: "/tmp/b.pdf", Size: 9, PDF: true, Pages: 40, Exact: true}}}
	tests := []struct {
		name string
		p    *PendingFirst
		col  string // "" to check the round trip only
	}{
		{"none", nil, ""},
		{"text only", &PendingFirst{Text: "go", Prompt: "go"}, `{"text":"go","prompt":"go"}`},
		{"everything", full, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			col := pendingFirstJSON(tt.p)
			if tt.col != "" && col != tt.col {
				t.Errorf("column = %s, want %s", col, tt.col)
			}
			got := parsePendingFirst(col)
			if (got == nil) != (tt.p == nil) || got != nil && (got.Text != tt.p.Text || got.Prompt != tt.p.Prompt ||
				got.Composer != tt.p.Composer || got.ItemID != tt.p.ItemID || !slices.Equal(got.Attachments, tt.p.Attachments)) {
				t.Errorf("round trip = %+v, want %+v", got, tt.p)
			}
		})
	}
	if parsePendingFirst("{nope") != nil {
		t.Error("a malformed column is a message")
	}
	// The outgoing message keeps it all, marked first.
	o := full.outgoing()
	if !o.first || o.text != full.Text || o.prompt != full.Prompt || o.itemID != "u-1" || len(o.attachments) != 2 || !o.attachments[1].pdf {
		t.Errorf("outgoing = %+v", o)
	}
}

// A first message is on the row until Claude has it, then cleared.
func TestFirstPromptClearedOnDelivery(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{InitialPrompt: "a table"})
	if s.PendingFirst == nil || s.PendingFirst.Text != "a table" {
		t.Fatalf("created: pending first %+v", s.PendingFirst)
	}
	e.sentUser("a table")
	e.waitFor(s.ID, "delivered", func(s Thread) bool { return s.PendingFirst == nil })
	rows, err := loadThreads(context.Background(), e.m.opts.DB)
	if err != nil || len(rows) != 1 || rows[0].PendingFirst != nil {
		t.Errorf("persisted pending first: %+v, %v", rows, err)
	}
}

// e10-2: a daemon stop before Claude's handshake keeps the first message; the next
// start (a send, a reconnect) delivers it first, then the message that started it.
func TestFirstPromptSurvivesStop(t *testing.T) {
	tests := []struct {
		name  string
		start func(e *env, id string)
		want  []string // what Claude gets, in order
		items []string // the user items, in order
	}{
		{"a send", func(e *env, id string) {
			if _, err := e.m.Send(e.ctx(), id, Message{Text: "continue"}); err != nil {
				e.t.Fatal(err)
			}
		}, []string{"write the tests", "continue"}, []string{"write the tests", "continue"}},
		{"a reconnect", func(e *env, id string) {
			if _, err := e.m.Reconnect(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
		}, []string{"write the tests"}, []string{"write the tests"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gate := initGate(t)
			e := newFixtureEnvAt(t, hangFixture(t), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path})
			t.Cleanup(gate.open)
			s := e.create(CreateOptions{InitialPrompt: "write the tests"})
			if got := e.snapshot(s.ID); got.State != StateStarting {
				t.Fatalf("not starting: %+v", got)
			}
			e.restart()
			got, _ := e.m.Get(e.ctx(), s.ID)
			if got.PendingFirst == nil || got.PendingFirst.Text != "write the tests" || got.ResumeNote.Pending() {
				t.Fatalf("after the stop: pending first %+v, note %+v", got.PendingFirst, got.ResumeNote)
			}
			// Its item was written before the handshake; the row keeps its id.
			if users := userItems(e.items(s.ID).Items); !slices.Equal(users, []string{"write the tests"}) || got.PendingFirst.ItemID == "" {
				t.Fatalf("before the next start: user items %q, pending first %+v", users, got.PendingFirst)
			}
			gate.open()
			tt.start(e, s.ID)
			e.sentUser(tt.want[len(tt.want)-1])
			var order []string
			for _, m := range e.sent() {
				if txt := userTextOf(m); txt != "" {
					order = append(order, txt)
				}
			}
			if !slices.Equal(order, tt.want) {
				t.Errorf("Claude got %q, want %q", order, tt.want)
			}
			e.waitFor(s.ID, "delivered", func(s Thread) bool { return s.PendingFirst == nil })
			if got := userItems(e.items(s.ID).Items); !slices.Equal(got, tt.items) {
				t.Errorf("user items %q, want %q", got, tt.items)
			}
		})
	}
}

// Only the daemon's stop keeps it: a close while starting ends it, as before.
func TestFirstPromptGoesWithAClose(t *testing.T) {
	gate := initGate(t)
	e := newFixtureEnvAt(t, hangFixture(t), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path})
	t.Cleanup(gate.open)
	s := e.create(CreateOptions{InitialPrompt: "write the tests"})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.waitFor(s.ID, "closed", stopped); got.PendingFirst != nil {
		t.Errorf("closed while starting: pending first %+v", got.PendingFirst)
	}
}

// A message queued behind the first one writes its item; the next start does not write
// it again.
func TestFirstPromptQueuedItemOnce(t *testing.T) {
	gate := initGate(t)
	e := newFixtureEnvAt(t, hangFixture(t), []string{"CF_FAKE_CLAUDE_INIT_GATE=" + gate.path})
	t.Cleanup(gate.open)
	s := e.create(CreateOptions{InitialPrompt: "first"})
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "second"}); err != nil {
		t.Fatal(err)
	}
	if got := e.snapshot(s.ID); got.PendingFirst == nil || got.PendingFirst.ItemID == "" {
		t.Fatalf("queued behind it: pending first %+v", got.PendingFirst)
	}
	e.restart()
	gate.open()
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "third"}); err != nil {
		t.Fatal(err)
	}
	e.sentUser("third")
	if got := userItems(e.items(s.ID).Items); !slices.Equal(got, []string{"first", "second", "third"}) {
		t.Errorf("user items %q", got)
	}
}
