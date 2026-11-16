package settings

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	terminalNewKey = "keybindings.terminal.new"
	terminalNewID  = "terminal.new-none-2026-11"
)

// terminal.new = "none" left from before the shell's keymap is cleared once: on load it
// reads as unset (New Terminal on cmd+t, no issue) and the next save leaves it out. Once
// the file no longer holds it, the user's own choice stands, "none" included. Each step
// opens the store anew (a restart), sets the file by hand, or saves from the app.
func TestOnceClearTerminalNewNone(t *testing.T) {
	type step struct {
		open   bool              // (re)open the store on the file as it is
		file   string            // write this [keybindings] table by hand first, then reload
		update map[string]string // save from the app
		want   string            // terminal.new's value after the step
		done   bool              // the clear is recorded in the marker file
	}
	tests := []struct {
		name   string
		marker string // the marker file before the first open; "" for none
		file   string // the [keybindings] table before the first open
		steps  []step
	}{
		{name: "none is cleared, and the next save leaves it out", file: `"terminal.new" = "none"`, steps: []step{
			{open: true, want: "cmd+t"},
			{update: map[string]string{KeyFontSize: "14"}, want: "cmd+t", done: true},
			{open: true, want: "cmd+t", done: true},
		}},
		{name: "any spelling of none", file: `"terminal.new" = " NONE "`, steps: []step{
			{open: true, want: "cmd+t"},
		}},
		{name: "an unquoted dotted key", file: `terminal.new = "none"`, steps: []step{
			{open: true, want: "cmd+t"},
		}},
		{name: "a restart before any save clears it again", file: `"terminal.new" = "none"`, steps: []step{
			{open: true, want: "cmd+t"},
			{open: true, want: "cmd+t"},
		}},
		{name: "unbinding it after the clear sticks", file: `"terminal.new" = "none"`, steps: []step{
			{open: true, want: "cmd+t"},
			{update: map[string]string{terminalNewKey: "none"}, want: "none", done: true},
			{open: true, want: "none", done: true},
		}},
		{name: "rebinding it after the clear sticks", file: `"terminal.new" = "none"`, steps: []step{
			{open: true, want: "cmd+t"},
			{update: map[string]string{terminalNewKey: "cmd+y"}, want: "cmd+y", done: true},
			{open: true, want: "cmd+y", done: true},
		}},
		{name: "a hand edit to another chord ends it", file: `"terminal.new" = "none"`, steps: []step{
			{open: true, want: "cmd+t"},
			{file: `"terminal.new" = "cmd+y"`, want: "cmd+y", done: true},
			{file: `"terminal.new" = "none"`, want: "none", done: true},
			{open: true, want: "none", done: true},
		}},
		{name: "another chord stays, and later none is the user's", file: `"terminal.new" = "cmd+y"`, steps: []step{
			{open: true, want: "cmd+y", done: true},
			{file: `"terminal.new" = "none"`, want: "none", done: true},
			{open: true, want: "none", done: true},
		}},
		{name: "no override: done at once", file: `"thread.new" = "cmd+j"`, steps: []step{
			{open: true, want: "cmd+t", done: true},
			{file: `"terminal.new" = "none"`, want: "none", done: true},
		}},
		{name: "already done: none stays", marker: terminalNewID + "\n", file: `"terminal.new" = "none"`, steps: []step{
			{open: true, want: "none", done: true},
		}},
		{name: "an unknown marker line is kept", marker: "some.later-clear\n", file: `"terminal.new" = "none"`, steps: []step{
			{open: true, want: "cmd+t"},
			{update: map[string]string{KeyFontSize: "14"}, want: "cmd+t", done: true},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), FileName)
			marker := path + ClearedSuffix
			if err := os.WriteFile(path, []byte("[keybindings]\n"+tt.file+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if tt.marker != "" {
				if err := os.WriteFile(marker, []byte(tt.marker), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			var s *Store
			for i, st := range tt.steps {
				switch {
				case st.open:
					if s != nil {
						_ = s.Close()
					}
					s = reopen(t, path)
				case st.file != "":
					if err := os.WriteFile(path, []byte("[keybindings]\n"+st.file+"\n"), 0o600); err != nil {
						t.Fatal(err)
					}
					s.reload()
				case st.update != nil:
					if _, err := s.Update(context.Background(), st.update); err != nil {
						t.Fatalf("step %d: %v", i, err)
					}
				}
				snap := s.Snapshot()
				if got := snap.Values[terminalNewKey]; got != st.want {
					t.Errorf("step %d: terminal.new = %q, want %q", i, got, st.want)
				}
				if len(snap.Issues) != 0 {
					t.Errorf("step %d: issues %v", i, snap.Issues)
				}
				data, _ := os.ReadFile(marker)
				if done := strings.Contains(string(data), terminalNewID+"\n"); done != st.done {
					t.Errorf("step %d: marker %q, want done %v", i, data, st.done)
				}
				if tt.marker != "" && !strings.Contains(string(data), tt.marker) {
					t.Errorf("step %d: marker %q lost %q", i, data, tt.marker)
				}
			}
			_ = s.Close()
		})
	}
}

// reopen opens a store on path with the test commands, as the daemon does at start.
func reopen(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(context.Background(), Options{Path: path, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	s.SetCommands(testCmds)
	return s
}

// The save after the clear leaves only terminal.new out: the user's other values,
// keybindings and unknown keys are all written back.
func TestOnceClearKeepsTheRestOfTheFile(t *testing.T) {
	in := "[keybindings]\n\"terminal.new\" = \"none\"\n\"thread.new\" = \"cmd+j\"\n\n[appearance]\nfont_size = 15\n\n[mystery]\nanswer = 42\n"
	s, _, path := openTest(t, in)
	s.SetCommands(testCmds)
	if _, err := s.Update(context.Background(), map[string]string{KeyDensity: "compact"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := string(data)
	if strings.Contains(out, "\n\"terminal.new\" = ") {
		t.Errorf("the save kept terminal.new:\n%s", out)
	}
	for _, l := range []string{"\n\"thread.new\" = \"cmd+j\"\n", "\nfont_size = 15\n", "\ndensity = \"compact\"\n", "\n[mystery]\n", "\nanswer = 42\n"} {
		if !strings.Contains(out, l) {
			t.Errorf("the save lost %q:\n%s", l, out)
		}
	}
}
