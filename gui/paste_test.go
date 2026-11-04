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
		// What the spoken commands leave: a phrase may be nothing but a line break.
		{"a line break alone", []string{"One.", "\n", "Two."}, "One.\nTwo."},
		{"a paragraph alone", []string{"One.", "\n\n", "Two."}, "One.\n\nTwo."},
		{"a break ending a phrase", []string{"One\n ", " two"}, "One\ntwo"},
		{"a break starting a phrase", []string{"One", "\ntwo"}, "One\ntwo"},
		{"a break ending the text", []string{"One", "\n"}, "One\n"},
		{"a symbol alone", []string{"Done", ",", "thanks"}, "Done, thanks"},
		{"a quote opened in one phrase, closed in the next", []string{`He said "`, `hello`, `" and left`}, `He said "hello" and left`},
		{"a closed quote keeps its space", []string{`"yes"`, "then"}, `"yes" then`},
		{"a second quote opens after a space", []string{`"yes"`, `"no"`}, `"yes" "no"`},
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

func TestNeedsLeadingSpace(t *testing.T) {
	tests := []struct {
		name     string
		previous rune
		text     string
		want     bool
	}{
		{"a lowercase letter", 'a', "in progress", true},
		{"a capital", 'Z', "in progress", true},
		{"a letter beyond ASCII", 'é', "in progress", true},
		{"a digit", '7', "in progress", true},
		{"a full stop", '.', "in progress", true},
		{"a comma", ',', "in progress", true},
		{"a semicolon", ';', "in progress", true},
		{"a colon", ':', "in progress", true},
		{"an exclamation mark", '!', "in progress", true},
		{"a question mark", '?', "in progress", true},
		{"an ellipsis", '…', "in progress", true},
		{"a closing parenthesis", ')', "in progress", true},
		{"a closing bracket", ']', "in progress", true},
		{"a closing brace", '}', "in progress", true},
		{"a closing quote", '”', "in progress", true},
		{"a closing single quote", '’', "in progress", true},
		{"a closing guillemet", '»', "in progress", true},

		{"a space", ' ', "in progress", false},
		{"a newline", '\n', "in progress", false},
		{"a tab", '\t', "in progress", false},
		{"an opening parenthesis", '(', "in progress", false},
		{"an opening bracket", '[', "in progress", false},
		{"an opening brace", '{', "in progress", false},
		{"an opening quote", '“', "in progress", false},
		{"an at sign", '@', "in progress", false},
		{"a dollar", '$', "in progress", false},
		{"a hash", '#', "in progress", false},
		{"a slash", '/', "in progress", false},
		{"a hyphen", '-', "in progress", false},
		{"a straight quote, which could be either", '"', "in progress", false},

		{"no text", 'a', "", false},
		{"text starting with a space", 'a', " spaced", false},
		{"text starting with a line", 'a', "\nspaced", false},
		{"text starting with a comma", 'a', ", then more", false},
		{"text starting with a full stop", 'a', ".", false},
		{"text starting with a closing bracket", 'a', ") done", false},
		{"text starting with a closing quote", 'a', "” he said", false},
		{"text starting with an opening bracket", 'a', "(aside)", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := needsLeadingSpace(tt.previous, tt.text); got != tt.want {
				t.Errorf("got %v", got)
			}
		})
	}
}

func TestSmartSpaced(t *testing.T) {
	tests := []struct {
		name     string
		previous rune
		known    bool
		want     string
	}{
		{"a letter", 'a', true, " Text."},
		{"whitespace", ' ', true, "Text."},
		{"an app that does not say", 0, false, "Text."},
		{"not known wins over what is there", 'a', false, "Text."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := smartSpaced("Text.", tt.previous, tt.known); got != tt.want {
				t.Errorf("got %q", got)
			}
		})
	}
}

func TestJoinContinuation(t *testing.T) {
	tests := []struct {
		name, previous, next, want string
	}{
		{"mid-sentence, a sentence word comes down", "Because if I don't do that,", "And if you see it.", " and if you see it."},
		{"after a sentence, a capital goes up", "And if you see it.", "well, that works.", " Well, that works."},
		{"after a question", "Is it?", "yes.", " Yes."},
		{"after an exclamation", "Stop!", "now.", " Now."},
		{"a sentence ended inside a quote", `He said "stop."`, "then left.", " Then left."},
		{"a sentence ended inside brackets", "(As it was.)", "and is.", " And is."},
		{"a sentence ended inside a curly quote", "He said “stop.”", "then left.", " Then left."},
		{"trailing space: no second one", "Already spaced. ", "Next sentence.", "Next sentence."},
		{"a trailing line", "One\n", "two", "two"},
		{"closing punctuation takes no space", "Hello", ", world.", ", world."},
		{"a next that opens with a space", "Hello", " world", " world"},
		{"after an opening bracket", "See (", "and more", "and more"},
		{"a name stays a name", "Open", "GitHub next.", " GitHub next."},
		{"so does another", "Message", "Slack now.", " Slack now."},
		{"a capital after a sentence stays", "Done.", "Next.", " Next."},
		{"no letter", "Total", "42", " 42"},
		{"nothing before", "", "Next.", "Next."},
		{"nothing to add", "Done.", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := joinContinuation(tt.previous, tt.next); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestEndsSentence(t *testing.T) {
	tests := []struct {
		text string
		want bool
	}{
		{"Done.", true}, {"Done?", true}, {"Done!", true}, {"Done. ", true}, {"Done.\n", true},
		{`"Done."`, true}, {"(Done.)", true}, {"'Done!'", true}, {"[Done?]", true}, {"{Done.}", true},
		{"“Done.”", true}, {"‘Done.’", true}, {"«Done.»", true},
		{"Done", false}, {"Done,", false}, {"Done:", false}, {"Done;", false}, {"", false}, {`"`, false},
	}
	for _, tt := range tests {
		t.Run(tt.text, func(t *testing.T) {
			if got := endsSentence(tt.text); got != tt.want {
				t.Errorf("got %v", got)
			}
		})
	}
}

func TestSetInitialCase(t *testing.T) {
	tests := []struct {
		name, text string
		uppercase  bool
		want       string
	}{
		{"up", "well then", true, "Well then"},
		{"up past punctuation", "“well then", true, "“Well then"},
		{"up, a letter beyond ASCII", "été", true, "Été"},
		{"up, already", "Well", true, "Well"},
		{"down, a sentence word", "And more", false, "and more"},
		{"down past punctuation", "(And more)", false, "(and more)"},
		{"down, a word with no space after", "And", false, "and"},
		{"down, a name is left", "Slack now", false, "Slack now"},
		{"down, a word that only starts like one", "Andrew said", false, "Andrew said"},
		{"down, an apostrophe keeps the word whole", "If's and but's", false, "If's and but's"},
		{"down, already", "and more", false, "and more"},
		{"no letters", "42", true, "42"},
		{"nothing", "", false, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := setInitialCase(tt.text, tt.uppercase); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSentenceInitialWord(t *testing.T) {
	for _, w := range []string{"A", "An", "And", "As", "Because", "But", "For", "If", "Nor", "Or", "So", "The", "Then", "Though", "To", "When", "While", "Yet"} {
		if !sentenceInitialWord(w + " more") {
			t.Errorf("%s", w)
		}
	}
	for _, w := range []string{"", "I", "GitHub", "Slack", "Android"} {
		if sentenceInitialWord(w) {
			t.Errorf("%q", w)
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
