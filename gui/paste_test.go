package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakePasteHost records the calls it gets, waits included.
type fakePasteHost struct {
	calls      []string
	writeErr   error
	postErr    error
	restored   bool
	restoreErr error
}

func (f *fakePasteHost) Save() (int, int) {
	f.calls = append(f.calls, "save")
	return 2, 1
}

func (f *fakePasteHost) Write(string) (int64, error) {
	f.calls = append(f.calls, "write")
	return 7, f.writeErr
}

func (f *fakePasteHost) Post() error {
	f.calls = append(f.calls, "post")
	return f.postErr
}

func (f *fakePasteHost) Restore(count int64) (bool, error) {
	if count != 7 {
		f.calls = append(f.calls, "restore with the wrong count")
	}
	f.calls = append(f.calls, "restore")
	return f.restored, f.restoreErr
}

func TestPasteText(t *testing.T) {
	boom := errors.New("boom")
	tests := []struct {
		name      string
		host      fakePasteHost
		wantCalls []string
		wantErr   string
		wantSaid  string
	}{
		{
			name:      "pastes, waits, restores",
			host:      fakePasteHost{restored: true},
			wantCalls: []string{"save", "write", "wait 50ms", "post", "wait 100ms", "wait 500ms", "restore"},
			wantSaid:  "clipboard restored",
		},
		{
			name:      "something else wrote to the clipboard",
			host:      fakePasteHost{},
			wantCalls: []string{"save", "write", "wait 50ms", "post", "wait 100ms", "wait 500ms", "restore"},
			wantSaid:  "clipboard left alone",
		},
		{
			name:      "a failed restore is said",
			host:      fakePasteHost{restoreErr: boom},
			wantCalls: []string{"save", "write", "wait 50ms", "post", "wait 100ms", "wait 500ms", "restore"},
			wantSaid:  "clipboard not restored: boom",
		},
		{
			name:      "a failed write still gives the clipboard back",
			host:      fakePasteHost{writeErr: boom, restored: true},
			wantCalls: []string{"save", "write", "restore"},
			wantErr:   "write clipboard: boom",
			wantSaid:  "clipboard restored",
		},
		{
			name:      "a failed post gives the clipboard back at once",
			host:      fakePasteHost{postErr: boom, restored: true},
			wantCalls: []string{"save", "write", "wait 50ms", "post", "restore"},
			wantErr:   "post Cmd+V: boom",
			wantSaid:  "clipboard restored",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := tt.host
			var said []string
			wait := func(d time.Duration) { host.calls = append(host.calls, "wait "+d.String()) }
			err := pasteText(&host, "text", wait, func(s string) { said = append(said, s) })
			if !reflect.DeepEqual(host.calls, tt.wantCalls) {
				t.Errorf("calls\n got %v\nwant %v", host.calls, tt.wantCalls)
			}
			if got := errText(err); got != tt.wantErr {
				t.Errorf("err = %q, want %q", got, tt.wantErr)
			}
			if !strings.Contains(strings.Join(said, "\n"), tt.wantSaid) {
				t.Errorf("said %q, want it to include %q", said, tt.wantSaid)
			}
		})
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func TestDecidePaste(t *testing.T) {
	app := frontApp{PID: 7, Name: "Notes"}
	other := frontApp{PID: 9, Name: "Mail"}
	tests := []struct {
		name  string
		facts pasteFacts
		want  pasteAction
	}{
		{"same app", pasteFacts{Text: "hi", Pressed: app, Front: app, Trusted: true}, pasteKeys},
		{"nothing said", pasteFacts{Pressed: app, Front: app, Trusted: true}, pasteNothing},
		{"nothing said in a password field", pasteFacts{Pressed: app, Front: app, Secure: true}, pasteNothing},
		{"another app in front", pasteFacts{Text: "hi", Pressed: app, Front: other, Trusted: true}, pasteClipboard},
		{"secure input", pasteFacts{Text: "hi", Pressed: app, Front: app, Secure: true, Trusted: true}, pasteClipboard},
		{"the grant went", pasteFacts{Text: "hi", Pressed: app, Front: app}, pasteClipboard},
		{"no app at the press", pasteFacts{Text: "hi", Trusted: true}, pasteClipboard},
		{"the clipboard race", pasteFacts{Text: "hi", Pressed: app, Front: app, Trusted: true, Race: true}, pasteTyped},
		{"the race, but another app in front", pasteFacts{Text: "hi", Pressed: app, Front: other, Trusted: true, Race: true}, pasteClipboard},
		{"the race, but secure input", pasteFacts{Text: "hi", Pressed: app, Front: app, Secure: true, Trusted: true, Race: true}, pasteClipboard},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := decidePaste(tt.facts); got != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
}

func TestJoinPhrases(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want string
	}{
		{"none", nil, ""},
		{"blank", []string{"", "  "}, ""},
		{"one", []string{" Hello there. "}, "Hello there."},
		{"two", []string{"First one.", "Second one."}, "First one. Second one."},
		{"leading spaces", []string{" First,", " and then."}, "First, and then."},
		{"blank in the middle", []string{"One.", " ", "Two."}, "One. Two."},
		{"closing punctuation", []string{"Well", ", then"}, "Well, then"},
		{"after an opening bracket", []string{"Call (", "me"}, "Call (me"},
		{"not ASCII", []string{"café", "“quoted”", "…"}, "café “quoted”…"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := joinPhrases(tt.in); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

// makeChromium lays out a Chromium framework inside bundle.
func makeChromium(t *testing.T, bundle string, versions ...string) {
	t.Helper()
	for _, v := range versions {
		if err := os.MkdirAll(filepath.Join(bundle, "Contents", "Frameworks", "Chrome Framework.framework", "Versions", v), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestHasClipboardRace(t *testing.T) {
	bundle := func(versions ...string) string {
		dir := t.TempDir()
		makeChromium(t, dir, versions...)
		return dir
	}
	tests := []struct {
		name   string
		bundle string
		want   bool
	}{
		{"no bundle", "", false},
		{"no frameworks", bundle(), false},
		{"155", bundle("155.0.7000.12"), true},
		{"156", bundle("156.1.2.3", "Current"), true},
		{"154", bundle("154.0.1.2"), false},
		{"157", bundle("157.0.1.2"), false},
		{"a staged update counts", bundle("157.0.1.2", "156.0.1.2"), true},
		{"Electron", bundle("A"), false},
		{"three parts", bundle("155.0.1"), false},
		{"not a number", bundle("155.x.1.2"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hasClipboardRace(tt.bundle); got != tt.want {
				t.Errorf("got %t, want %t", got, tt.want)
			}
		})
	}
}
