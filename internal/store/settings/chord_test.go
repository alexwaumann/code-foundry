package settings

import (
	"context"
	"maps"
	"os"
	"strings"
	"testing"
)

// The commands as they are now: dictation.toggle has no default chord, pane.collapse has
// cmd+shift+m (until 2026-11-03 dictation.toggle's default).
var chordCmds = []CommandInfo{
	{Name: "dictation.toggle", Title: "Dictate", Category: "Dictation"},
	{Name: "pane.collapse", Title: "Collapse Pane", Category: "Pane", Keybindings: []string{"cmd+shift+m"}},
}

// A file that binds dictation.toggle to its old default reads as unset: no "already bound"
// issue, pane.collapse keeps cmd+shift+m, and the next save leaves it out. Any other chord,
// and the same chord on another command, stays.
func TestDecodeRetiredChords(t *testing.T) {
	const key = "keybindings.dictation.toggle"
	tests := []struct {
		name     string
		in       string
		want     map[string]string
		dictate  string // dictation.toggle's effective chord
		collapse string // pane.collapse's
	}{
		{name: "cmd+shift+m is cleared", in: "[keybindings]\n\"dictation.toggle\" = \"cmd+shift+m\"\n",
			want: map[string]string{}, collapse: "cmd+shift+m"},
		{name: "another spelling of it is cleared", in: "[keybindings]\n\"dictation.toggle\" = \"Shift+Cmd+M\"\n",
			want: map[string]string{}, collapse: "cmd+shift+m"},
		{name: "symbols and aliases", in: "[keybindings]\n\"dictation.toggle\" = \"⇧+⌘+m\"\n",
			want: map[string]string{}, collapse: "cmd+shift+m"},
		{name: "an unquoted dotted key", in: "[keybindings]\ndictation.toggle = \"command+shift+m\"\n",
			want: map[string]string{}, collapse: "cmd+shift+m"},
		{name: "other settings stay", in: "[keybindings]\n\"dictation.toggle\" = \"cmd+shift+m\"\n\"thread.new\" = \"cmd+j\"\n",
			want: map[string]string{"keybindings.thread.new": "cmd+j"}, collapse: "cmd+shift+m"},
		{name: "another chord stays", in: "[keybindings]\n\"dictation.toggle\" = \"cmd+shift+d\"\n",
			want: map[string]string{key: "cmd+shift+d"}, dictate: "cmd+shift+d", collapse: "cmd+shift+m"},
		{name: "cmd+m is another chord", in: "[keybindings]\n\"dictation.toggle\" = \"cmd+alt+m\"\n",
			want: map[string]string{key: "cmd+alt+m"}, dictate: "cmd+alt+m", collapse: "cmd+shift+m"},
		{name: "none stays", in: "[keybindings]\n\"dictation.toggle\" = \"none\"\n",
			want: map[string]string{key: "none"}, dictate: "none", collapse: "cmd+shift+m"},
		{name: "an unparsable chord stays, to be reported", in: "[keybindings]\n\"dictation.toggle\" = \"cmd+shift+\"\n",
			want: map[string]string{key: "cmd+shift+"}, collapse: "cmd+shift+m"},
		{name: "cmd+shift+m on another command stays", in: "[keybindings]\n\"pane.collapse\" = \"none\"\n\"thread.new\" = \"cmd+shift+m\"\n",
			want: map[string]string{"keybindings.pane.collapse": "none", "keybindings.thread.new": "cmd+shift+m"}, collapse: "none"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := decode([]byte(tt.in))
			if err != nil || !maps.Equal(raw, tt.want) {
				t.Fatalf("decode = %v, %v; want %v", raw, err, tt.want)
			}
			r := resolve(raw, append(chordCmds, testCmds...))
			for _, is := range r.issues {
				if strings.Contains(is.Message, "already bound") {
					t.Errorf("issue %+v", is)
				}
			}
			if got := r.values[key]; got != tt.dictate {
				t.Errorf("dictation.toggle = %q, want %q", got, tt.dictate)
			}
			if got := r.values["keybindings.pane.collapse"]; got != tt.collapse {
				t.Errorf("pane.collapse = %q, want %q", got, tt.collapse)
			}
			keep, _ := r.fileValues(raw)
			out := string(render(keep, r.issues))
			if bound := strings.Contains(out, "\n\"dictation.toggle\" = "); bound != (tt.want[key] != "") {
				t.Errorf("rendered file binds dictation.toggle: %v, want %v:\n%s", bound, tt.want[key] != "", out)
			}
		})
	}
}

// Through the store: the old chord is gone from the file the next time settings are
// written, the user's other values kept.
func TestStoreWritesWithoutTheRetiredChord(t *testing.T) {
	s, _, path := openTest(t, "[keybindings]\n\"dictation.toggle\" = \"cmd+shift+m\"\n\"thread.new\" = \"cmd+j\"\n")
	s.SetCommands(append(chordCmds, testCmds...))
	if snap := s.Snapshot(); snap.Values["keybindings.dictation.toggle"] != "" || len(snap.Issues) != 0 {
		t.Fatalf("on load: dictation.toggle = %q, issues %v", snap.Values["keybindings.dictation.toggle"], snap.Issues)
	}
	if _, err := s.Update(context.Background(), map[string]string{KeyFontSize: "14"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := string(data)
	if strings.Contains(out, "\n\"dictation.toggle\" = ") || !strings.Contains(out, "\"thread.new\" = \"cmd+j\"") || !strings.Contains(out, "\nfont_size = 14\n") {
		t.Errorf("written file:\n%s", out)
	}
}
