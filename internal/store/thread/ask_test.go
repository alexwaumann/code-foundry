package thread

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestAskRefusals(t *testing.T) {
	long := strings.Repeat("x", MaxAskRunes+1)
	tests := []struct {
		name               string
		question, assuming string
		orphan, gone       bool
		want               error
		says               string
	}{
		{name: "no question", assuming: "a", want: ErrInvalidArgument, says: "question is empty"},
		{name: "no assumption", question: "q", want: ErrInvalidArgument, says: "assumption is empty"},
		{name: "a long question", question: long, assuming: "a", want: ErrInvalidArgument, says: "at most"},
		{name: "no creator", question: "q", assuming: "a", orphan: true, want: ErrFailedPrecondition, says: "question tool"},
		{name: "its creator is archived", question: "q", assuming: "a", gone: true, want: ErrFailedPrecondition, says: "is gone"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			parent, kid := e.stopped("parent"), e.stopped("kid")
			if !tt.orphan {
				e.m.update(kid.ID, false, func(rec *record) { rec.s.CreatedBy = parent.ID })
			}
			if tt.gone {
				e.m.update(parent.ID, false, func(rec *record) { rec.s.ArchivedAt = time.Now() })
			}
			_, _, err := e.m.Ask(e.ctx(), kid.ID, tt.question, tt.assuming)
			if !errors.Is(err, tt.want) || !strings.Contains(err.Error(), tt.says) {
				t.Errorf("err = %v", err)
			}
		})
	}
}

// An ask reaches a stopped creator as a labelled wake, the same one again does not, and the
// thread's row says what it asked for a creator that waits.
func TestAskWakesTheCreator(t *testing.T) {
	e := newEnv(t)
	parent, kid := e.stopped("parent"), e.stopped("kid")
	e.m.update(kid.ID, false, func(rec *record) { rec.s.CreatedBy = parent.ID })
	got, repeated, err := e.m.Ask(e.ctx(), kid.ID, "Which port?\nThe spec says two.", "I use 8080")
	if err != nil || repeated || got.ID != parent.ID {
		t.Fatalf("ask = %+v %v %v", got, repeated, err)
	}
	items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	w := wakes(items)[0]
	for _, want := range []string{"asks you something and keeps working", "> Which port?\n> The spec says two.", "> I use 8080",
		"If the assumption is right, do not answer", "thread send --id " + kid.ID + " --reply none", "\n\n" + WakeReplyNote} {
		if !strings.Contains(w.Text, want) {
			t.Errorf("text lacks %q:\n%s", want, w.Text)
		}
	}
	if w.Origin != OriginWake || !strings.Contains(w.WakeJSON, `"kind": "ask"`) {
		t.Errorf("wake = %q %s", w.Origin, w.WakeJSON)
	}
	if s, _ := e.m.Snapshot().Thread(kid.ID); s.Asked == nil || s.Asked.Assuming != "I use 8080" {
		t.Errorf("asked = %+v", s.Asked)
	}
	if _, repeated, err := e.m.Ask(e.ctx(), kid.ID, "Which port?\nThe spec says two.", "I use 8080"); err != nil || !repeated {
		t.Errorf("again: %v %v", repeated, err)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(wakes(e.items(parent.ID).Items)); n != 1 {
		t.Errorf("%d wakes", n)
	}
}

func TestAskCountsAgainstTheWakeLimit(t *testing.T) {
	e := newFixtureEnvAt(t, fixturePath("text-table"), nil, func(o *Options) { o.WakeLimit = 1 })
	parent, kid := e.stopped("parent"), e.stopped("kid")
	e.m.update(kid.ID, false, func(rec *record) { rec.s.CreatedBy = parent.ID })
	if _, _, err := e.m.Ask(e.ctx(), kid.ID, "one?", "a"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.m.Ask(e.ctx(), kid.ID, "two?", "a"); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "wake limit") {
		t.Errorf("err = %v", err)
	}
}
