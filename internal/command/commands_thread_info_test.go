package command_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/layout/layouttest"
)

// thread.info keeps a thread's info card shown or hidden in the layout, per thread
// (docs/notes/shell-model.md, "Thread info is per thread").
func TestThreadInfo(t *testing.T) {
	const a = "s-aaaa00000001"
	fixture := func(t *testing.T, values map[string]string) layoutFixture {
		t.Helper()
		f := layoutFixture{reg: command.NewRegistry(), store: layouttest.New(nil), thread: &commandtest.Thread{}}
		deps := command.LayoutDeps{Layout: f.store, Thread: f.thread}
		if values != nil {
			deps.Settings = valuesSettings{values: values}
		}
		if err := command.RegisterLayout(f.reg, deps); err != nil {
			t.Fatal(err)
		}
		f.store.Put(seeded())
		return f
	}
	info := func(f layoutFixture, thread string) *bool {
		if ts := f.state().Threads[thread]; ts != nil {
			return ts.Info
		}
		return nil
	}
	answer := func(t *testing.T, res command.Result) command.ThreadInfoResult {
		t.Helper()
		var out command.ThreadInfoResult
		b, err := json.Marshal(res.JSON)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	tests := []struct {
		name     string
		settings map[string]string
		args     map[string]string
		want     bool
	}{
		{"a toggle of a thread never toggled hides it (the setting's default: shown)", nil, nil, false},
		{"with the setting on, likewise", map[string]string{"layout.thread_info": "true"}, nil, false},
		{"with the setting off, a toggle shows it", map[string]string{"layout.thread_info": "false"}, nil, true},
		{"--open shows it", nil, map[string]string{"open": "true"}, true},
		{"--close hides it", map[string]string{"layout.thread_info": "false"}, map[string]string{"close": "true"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := fixture(t, tt.settings)
			// The focused tab's thread (A, in p-left) by default.
			got := answer(t, f.must(t, fromApp, "thread.info", tt.args))
			if got.ThreadID != a || got.Open != tt.want {
				t.Errorf("answer %+v; want thread %s open %v", got, a, tt.want)
			}
			if v := info(f, a); v == nil || *v != tt.want {
				t.Errorf("stored %v; want %v", v, tt.want)
			}
		})
	}

	t.Run("a second toggle undoes the first, and other threads keep theirs", func(t *testing.T) {
		f := fixture(t, nil)
		f.must(t, fromApp, "thread.info", nil)
		f.must(t, fromCLI, "thread.info", map[string]string{"id": "s-bbbb00000002", "open": "true"})
		f.must(t, fromApp, "thread.info", nil)
		if v := info(f, a); v == nil || !*v {
			t.Errorf("A: %v; want shown again", v)
		}
		if v := info(f, "s-bbbb00000002"); v == nil || !*v {
			t.Errorf("B: %v; want shown", v)
		}
	})

	t.Run("refusals", func(t *testing.T) {
		f := fixture(t, nil)
		if _, err := f.run(t, fromApp, "thread.info", map[string]string{"open": "true", "close": "true"}); !errors.Is(err, command.ErrInvalidArgs) {
			t.Errorf("--open --close: %v", err)
		}
		// From a thread, the user's focus is not its to act on.
		if _, err := f.run(t, fromThread, "thread.info", nil); !errors.Is(err, command.ErrInvalidArgs) {
			t.Errorf("from a thread without --id: %v", err)
		}
		// From the user's CLI, the focused tab belongs to no thread: the Pull Requests page.
		f.must(t, fromApp, "tab.focus", map[string]string{"tab": "t-prs"})
		if _, err := f.run(t, fromCLI, "thread.info", nil); !errors.Is(err, command.ErrInvalidArgs) {
			t.Errorf("no thread focused: %v", err)
		}
	})
}
