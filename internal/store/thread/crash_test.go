package thread

import (
	"strings"
	"testing"
)

// A child whose process dies mid-turn with no one asking (e4-2, e5-3): error "crashed",
// not "interrupted"; its subscriber's wake says no one stopped it; its next message
// starts with the crash note.
func TestCrashedChildWake(t *testing.T) {
	for _, code := range []int{-1, 1} {
		t.Run(map[int]string{-1: "killed", 1: "exit 1"}[code], func(t *testing.T) {
			e := newFixtureEnvAt(t, hangFixture(t), nil)
			parent := e.stopped("Orchestrator")
			kid := e.create(CreateOptions{Name: "Tests", InitialPrompt: "go", CreatedBy: parent.ID, Notify: true})
			e.waitFor(kid.ID, "busy", func(s Thread) bool { return s.Status == StatusBusy && s.State == StateConnected })
			e.exit(kid.ID, code)
			got := e.waitFor(kid.ID, "crashed", stopped)
			if got.Status != StatusError || got.StatusReason != ReasonCrashed || got.ResumeNote.Cause != ResumeCrash {
				t.Fatalf("after the crash: %v %q, note %+v", got.Status, got.StatusReason, got.ResumeNote)
			}
			items := e.waitItems(parent.ID, "the wake", func(items []Item) bool { return len(wakes(items)) == 1 })
			w := wakes(items)[0]
			if want := `Thread "Tests" (` + kid.ID + `) crashed: its process died (not stopped by anyone).`; !strings.HasPrefix(w.WakeTitle, want) {
				t.Errorf("wake title %q, want it to start %q", w.WakeTitle, want)
			}
			if !strings.Contains(w.WakeJSON, `"status_reason": "crashed"`) {
				t.Errorf("wake JSON: %s", w.WakeJSON)
			}
			if _, err := e.m.Send(e.ctx(), kid.ID, Message{Text: "continue"}); err != nil {
				t.Fatal(err)
			}
			text := e.waitUserText("[code-foundry] Your previous turn ended because its process died (not stopped by anyone)")
			if !strings.HasSuffix(text, "\n\ncontinue") {
				t.Errorf("message = %q", text)
			}
		})
	}
}

// The other ends of a busy turn stay "interrupted": a close (archive is its own reason)
// and the daemon's stop; a process that dies at its prompt keeps its status.
func TestNotCrashed(t *testing.T) {
	t.Run("closed", func(t *testing.T) {
		e, s := busySetup.start(t)
		if err := e.m.Close(e.ctx(), s.ID); err != nil {
			t.Fatal(err)
		}
		if got := e.waitFor(s.ID, "closed", stopped); got.StatusReason != ReasonInterrupted || got.ResumeNote.Pending() {
			t.Errorf("closed busy: %q, note %+v", got.StatusReason, got.ResumeNote)
		}
	})
	t.Run("daemon stopped", func(t *testing.T) {
		e, s := busySetup.start(t)
		e.restart()
		if got, _ := e.m.Get(e.ctx(), s.ID); got.StatusReason != ReasonInterrupted || got.ResumeNote.Cause != ResumeRestart {
			t.Errorf("stopped busy: %q, note %+v", got.StatusReason, got.ResumeNote)
		}
	})
	t.Run("died at its prompt", func(t *testing.T) {
		e, s := finishedSetup.start(t)
		e.exit(s.ID, -1)
		if got := e.waitFor(s.ID, "stopped", stopped); got.Status != StatusNeedsAttention || got.ResumeNote.Pending() {
			t.Errorf("died idle: %v %q, note %+v", got.Status, got.StatusReason, got.ResumeNote)
		}
	})
}
