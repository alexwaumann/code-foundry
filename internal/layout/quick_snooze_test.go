package layout

import "testing"

// A snooze ends the thread's quick terminal with its other terminals and keeps it in the set
// (docs/notes/shell-model.md, "Moving a thread ... Snoozing"): an open one is drawn closed and
// marked fresh with the command it ran; opening the thread's tab opens it again and asks the
// caller for a fresh shell (Result.FreshQuick). A closed one stays closed. SetQuick settles a
// fresh mark either way, keeps the "Run again" line, and drops it only when asked.
func TestQuickTerminalAcrossASnooze(t *testing.T) {
	apply := func(t *testing.T, st *State, op Op) (*State, Result) {
		t.Helper()
		next, res, err := Apply(st, op, &SeqIDs{})
		if err != nil {
			t.Fatalf("%s: %v", op.OpName(), err)
		}
		return next, res
	}
	quick := func(st *State) Quick {
		if ts := st.Threads["th-a"]; ts != nil && ts.Quick != nil {
			return *ts.Quick
		}
		return Quick{}
	}
	opened := func(t *testing.T, open bool) *State {
		t.Helper()
		st, _ := apply(t, NewState("sp-a", "A"), &OpenThread{Thread: "th-a", Focus: true})
		st, _ = apply(t, st, &SetQuick{Thread: "th-a", Open: open, Height: 200})
		return st
	}

	t.Run("open: back with the thread", func(t *testing.T) {
		st := opened(t, true)
		st, _ = apply(t, st, &SnoozeThread{Thread: "th-a", QuickRan: "npm run dev"})
		if got, want := quick(st), (Quick{Height: 200, Fresh: true, Ran: "npm run dev"}); got != want {
			t.Fatalf("after the snooze: %+v, want %+v", got, want)
		}
		if threadTabID(st, "th-a") != "" {
			t.Fatal("the snooze left the thread's tab open")
		}
		st, res := apply(t, st, &OpenThread{Thread: "th-a", Focus: true})
		if res.FreshQuick != "th-a" {
			t.Errorf("FreshQuick = %q, want th-a", res.FreshQuick)
		}
		if got, want := quick(st), (Quick{Open: true, Height: 200, Ran: "npm run dev"}); got != want {
			t.Errorf("after opening: %+v, want %+v", got, want)
		}
		// Open again (focused where it is): nothing more to start.
		if _, res := apply(t, st, &OpenThread{Thread: "th-a", Focus: true}); res.FreshQuick != "" {
			t.Errorf("a second open asked for another shell: %q", res.FreshQuick)
		}
		// A height drag and a close keep the line; ForgetRan drops it.
		st, _ = apply(t, st, &SetQuick{Thread: "th-a", Open: true, Height: 300})
		st, _ = apply(t, st, &SetQuick{Thread: "th-a", Open: false})
		if got := quick(st).Ran; got != "npm run dev" {
			t.Errorf("ran after a drag and a close = %q, want it kept", got)
		}
		st, _ = apply(t, st, &SetQuick{Thread: "th-a", Open: true, ForgetRan: true})
		if got, want := quick(st), (Quick{Open: true, Height: 300}); got != want {
			t.Errorf("after ForgetRan: %+v, want %+v", got, want)
		}
	})

	t.Run("closed: stays closed", func(t *testing.T) {
		st := opened(t, false)
		st, _ = apply(t, st, &SnoozeThread{Thread: "th-a", QuickRan: "ls"})
		if got, want := quick(st), (Quick{Height: 200}); got != want {
			t.Fatalf("after the snooze: %+v, want %+v", got, want)
		}
		st, res := apply(t, st, &OpenThread{Thread: "th-a", Focus: true})
		if res.FreshQuick != "" || quick(st).Open {
			t.Errorf("a closed quick terminal came back: %q %+v", res.FreshQuick, quick(st))
		}
	})

	t.Run("opened before the thread: no second shell", func(t *testing.T) {
		st := opened(t, true)
		st, _ = apply(t, st, &SnoozeThread{Thread: "th-a"})
		// terminal.quick from the CLI, without taking the user there: it starts the shell itself.
		st, _ = apply(t, st, &SetQuick{Thread: "th-a", Open: true})
		if q := quick(st); !q.Open || q.Fresh {
			t.Fatalf("after set_quick: %+v, want open and no longer fresh", q)
		}
		if _, res := apply(t, st, &OpenThread{Thread: "th-a", Focus: true}); res.FreshQuick != "" {
			t.Errorf("opening asked for a second shell: %q", res.FreshQuick)
		}
	})

	t.Run("closed by the user while snoozed", func(t *testing.T) {
		st := opened(t, true)
		st, _ = apply(t, st, &SnoozeThread{Thread: "th-a"})
		st, _ = apply(t, st, &SetQuick{Thread: "th-a", Open: false})
		if _, res := apply(t, st, &OpenThread{Thread: "th-a", Focus: true}); res.FreshQuick != "" {
			t.Errorf("a quick terminal closed on purpose came back: %q", res.FreshQuick)
		}
	})
}
