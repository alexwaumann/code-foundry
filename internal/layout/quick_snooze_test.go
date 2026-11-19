package layout

import "testing"

func applyOK(t *testing.T, st *State, op Op) (*State, Result) {
	t.Helper()
	next, res, err := Apply(st, op, &SeqIDs{})
	if err != nil {
		t.Fatalf("%s: %v", op.OpName(), err)
	}
	return next, res
}

func quickOf(st *State, thread string) Quick {
	if ts := st.Threads[thread]; ts != nil && ts.Quick != nil {
		return *ts.Quick
	}
	return Quick{}
}

// A snooze leaves the thread's quick terminal running and as it was
// (docs/notes/snooze-without-teardown.md): drawn with its thread's tab, it closes and comes
// back with it, open or closed, its height kept, and nothing asks for a fresh shell.
func TestQuickTerminalAcrossASnooze(t *testing.T) {
	for _, open := range []bool{true, false} {
		t.Run(map[bool]string{true: "open", false: "closed"}[open], func(t *testing.T) {
			st, _ := applyOK(t, NewState("sp-a", "A"), &OpenThread{Thread: "th-a", Focus: true})
			st, _ = applyOK(t, st, &SetQuick{Thread: "th-a", Open: open, Height: 200})
			want := Quick{Open: open, Height: 200}
			st, _ = applyOK(t, st, &SnoozeThread{Thread: "th-a"})
			if got := quickOf(st, "th-a"); got != want {
				t.Fatalf("after the snooze: %+v, want %+v", got, want)
			}
			if threadTabID(st, "th-a") != "" {
				t.Fatal("the snooze left the thread's tab open")
			}
			st, res := applyOK(t, st, &SetSnoozed{Thread: "th-a"})
			if res.FreshQuick != "" || threadTabID(st, "th-a") == "" {
				t.Fatalf("woken: FreshQuick %q, tab %q; want the tab back and no fresh shell", res.FreshQuick, threadTabID(st, "th-a"))
			}
			if got := quickOf(st, "th-a"); got != want {
				t.Errorf("after waking: %+v, want %+v", got, want)
			}
		})
	}
}

// A layout an older build's snooze left, when a snooze ended the quick terminal: an open one
// was drawn closed and marked fresh with the command it ran; opening the thread's tab after
// the wake opens it again and asks the caller for a fresh shell (Result.FreshQuick). SetQuick
// settles a fresh mark either way, keeps the "Run again" line, and drops it only when asked.
func TestQuickTerminalAfterAnOlderSnooze(t *testing.T) {
	older := func(ran string) *State {
		st := NewState("sp-a", "A")
		st.Threads = map[string]*ThreadState{"th-a": {Space: "sp-a", Snoozed: true, Quick: &Quick{Height: 200, Fresh: true, Ran: ran}}}
		return st
	}

	t.Run("back with the thread", func(t *testing.T) {
		st := older("npm run dev")
		// Opened while still snoozed: only the conversation (preview.go).
		st, res := applyOK(t, st, &OpenThread{Thread: "th-a", Focus: true})
		if res.FreshQuick != "" || !quickOf(st, "th-a").Fresh {
			t.Errorf("opened while snoozed: FreshQuick = %q, %+v; want it to wait", res.FreshQuick, quickOf(st, "th-a"))
		}
		// It wakes with its tab open: the quick terminal comes back.
		st, res = applyOK(t, st, &SetSnoozed{Thread: "th-a"})
		if res.FreshQuick != "th-a" {
			t.Errorf("FreshQuick = %q, want th-a", res.FreshQuick)
		}
		if got, want := quickOf(st, "th-a"), (Quick{Open: true, Height: 200, Ran: "npm run dev"}); got != want {
			t.Errorf("after waking: %+v, want %+v", got, want)
		}
		// Open again (focused where it is): nothing more to start.
		if _, res := applyOK(t, st, &OpenThread{Thread: "th-a", Focus: true}); res.FreshQuick != "" {
			t.Errorf("a second open asked for another shell: %q", res.FreshQuick)
		}
		// A height drag and a close keep the line; ForgetRan drops it.
		st, _ = applyOK(t, st, &SetQuick{Thread: "th-a", Open: true, Height: 300})
		st, _ = applyOK(t, st, &SetQuick{Thread: "th-a", Open: false})
		if got := quickOf(st, "th-a").Ran; got != "npm run dev" {
			t.Errorf("ran after a drag and a close = %q, want it kept", got)
		}
		st, _ = applyOK(t, st, &SetQuick{Thread: "th-a", Open: true, ForgetRan: true})
		if got, want := quickOf(st, "th-a"), (Quick{Open: true, Height: 300}); got != want {
			t.Errorf("after ForgetRan: %+v, want %+v", got, want)
		}
	})

	t.Run("woken with no tab open: back with its next open", func(t *testing.T) {
		st, res := applyOK(t, older("make"), &SetSnoozed{Thread: "th-a"})
		if res.FreshQuick != "" || !quickOf(st, "th-a").Fresh {
			t.Fatalf("woken with no tab: FreshQuick = %q, %+v", res.FreshQuick, quickOf(st, "th-a"))
		}
		if _, res := applyOK(t, st, &OpenThread{Thread: "th-a", Focus: true}); res.FreshQuick != "th-a" {
			t.Errorf("FreshQuick = %q, want th-a", res.FreshQuick)
		}
	})

	t.Run("opened before the thread: no second shell", func(t *testing.T) {
		// terminal.quick from the CLI, without taking the user there: it starts the shell itself.
		st, _ := applyOK(t, older(""), &SetQuick{Thread: "th-a", Open: true})
		if q := quickOf(st, "th-a"); !q.Open || q.Fresh {
			t.Fatalf("after set_quick: %+v, want open and no longer fresh", q)
		}
		if _, res := applyOK(t, st, &OpenThread{Thread: "th-a", Focus: true}); res.FreshQuick != "" {
			t.Errorf("opening asked for a second shell: %q", res.FreshQuick)
		}
	})

	t.Run("closed by the user while snoozed", func(t *testing.T) {
		st, _ := applyOK(t, older(""), &SetQuick{Thread: "th-a", Open: false})
		if _, res := applyOK(t, st, &OpenThread{Thread: "th-a", Focus: true}); res.FreshQuick != "" {
			t.Errorf("a quick terminal closed on purpose came back: %q", res.FreshQuick)
		}
	})
}
