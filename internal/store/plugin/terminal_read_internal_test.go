package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// readTerms is a terminal "t" of plugin p whose screen and scrollback are fixed.
type readTerms struct {
	termOwners
	screen, scrollback string
}

func (r readTerms) Text(context.Context, string) (string, error)       { return r.screen, nil }
func (r readTerms) Scrollback(context.Context, string) (string, error) { return r.scrollback, nil }

// terminal/read: the screen or, with scrollback, the history and the screen, without a
// trailing newline and with its line count; the head is cut (from a line start) at
// maxBytes, 64 KiB/256 KiB for the screen, 1 MiB with scrollback, and the JSON answer
// always fits a protocol line.
func TestTerminalRead(t *testing.T) {
	numbered := func(n int) string { // "line 000000\n…line n-1", 12 bytes a line
		var b strings.Builder
		for i := range n {
			if i > 0 {
				b.WriteByte('\n')
			}
			fmt.Fprintf(&b, "line %06d", i)
		}
		return b.String()
	}
	big := numbered(150_000) // ~1.7 MiB
	tests := []struct {
		name       string
		screen     string
		scrollback string
		params     pluginsdk.TerminalReadParams
		wantText   string // exact, or with wantPrefix/wantSuffix
		wantPrefix string
		wantSuffix string
		wantLen    int // when > 0: len(text) at most this and over this-10
		cut        bool
		lines      int
	}{
		{name: "screen", screen: "$ ls\nfoo", scrollback: "old\n$ ls\nfoo", params: pluginsdk.TerminalReadParams{}, wantText: "$ ls\nfoo", lines: 2},
		// A part-filled screen's text ends with a newline (blank rows below): dropped, so
		// the line count is the rows with text, as with scrollback.
		{name: "screen part-filled", screen: "$ ls\nfoo\n", params: pluginsdk.TerminalReadParams{}, wantText: "$ ls\nfoo", lines: 2},
		{name: "screen blank rows below", screen: "$ ls\nfoo\n\n\n", params: pluginsdk.TerminalReadParams{}, wantText: "$ ls\nfoo", lines: 2},
		{name: "screen blank row inside kept", screen: "a\n\nb\n", params: pluginsdk.TerminalReadParams{}, wantText: "a\n\nb", lines: 3},
		{name: "screen empty", screen: "\n", params: pluginsdk.TerminalReadParams{}, wantText: ""},
		{name: "scrollback trailing newline", scrollback: "old\nfoo\n", params: pluginsdk.TerminalReadParams{Scrollback: true}, wantText: "old\nfoo", lines: 2},
		{name: "scrollback oldest first", screen: "$ ls\nfoo", scrollback: "old\n$ ls\nfoo", params: pluginsdk.TerminalReadParams{Scrollback: true}, wantText: "old\n$ ls\nfoo", lines: 3},
		{name: "scrollback empty", params: pluginsdk.TerminalReadParams{Scrollback: true}, wantText: ""},
		{name: "scrollback maxBytes cuts the head at a line", scrollback: numbered(20), params: pluginsdk.TerminalReadParams{Scrollback: true, MaxBytes: 20},
			wantText: "line 000019", cut: true, lines: 1},
		{name: "scrollback default 1 MiB", scrollback: big, params: pluginsdk.TerminalReadParams{Scrollback: true},
			wantSuffix: "\nline 149999", wantLen: 1 << 20, cut: true, lines: 87381},
		{name: "scrollback at most 1 MiB", scrollback: big, params: pluginsdk.TerminalReadParams{Scrollback: true, MaxBytes: 8 << 20},
			wantSuffix: "\nline 149999", wantLen: 1 << 20, cut: true, lines: 87381},
		{name: "screen at most 256 KiB", screen: big, params: pluginsdk.TerminalReadParams{MaxBytes: 8 << 20},
			wantSuffix: "\nline 149999", wantLen: 256 << 10, cut: true, lines: 21845},
		{name: "screen default 64 KiB", screen: big, params: pluginsdk.TerminalReadParams{},
			wantSuffix: "\nline 149999", wantLen: 64 << 10, cut: true, lines: 5461},
		{name: "escaped text halves until it fits a line", scrollback: strings.Repeat("<<<<<<<<<\n", 100_000) /* 1,000,000 bytes, ~5.6 MB as JSON */, params: pluginsdk.TerminalReadParams{Scrollback: true},
			wantPrefix: "<", wantSuffix: "<\n<<<<<<<<<", wantLen: 499_999, cut: true, lines: 49999},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := &Manager{opts: Options{Terminals: readTerms{termOwners: termOwners{"t": "p"}, screen: tt.screen, scrollback: tt.scrollback}}}
			a := &actor{m: m, name: "p"}
			tt.params.TerminalID = "t"
			raw, _ := json.Marshal(tt.params)
			got, err := a.terminalRead(context.Background(), raw)
			if err != nil {
				t.Fatal(err)
			}
			res := got.(pluginsdk.TerminalReadResult)
			switch {
			case tt.wantPrefix == "" && tt.wantSuffix == "" && res.Text != tt.wantText:
				t.Errorf("text = %q, want %q", res.Text, tt.wantText)
			case !strings.HasPrefix(res.Text, tt.wantPrefix) || !strings.HasSuffix(res.Text, tt.wantSuffix):
				t.Errorf("text = %q…%q, want %q…%q", head(res.Text), tail(res.Text), tt.wantPrefix, tt.wantSuffix)
			case tt.wantLen > 0 && (len(res.Text) > tt.wantLen || len(res.Text) < tt.wantLen-10):
				t.Errorf("len(text) = %d, want about %d", len(res.Text), tt.wantLen)
			case res.Truncated != tt.cut || res.Lines != tt.lines:
				t.Errorf("truncated, lines = %v, %d; want %v, %d", res.Truncated, res.Lines, tt.cut, tt.lines)
			}
			if tt.cut && strings.HasPrefix(res.Text, "\n") {
				t.Errorf("cut text starts with a newline")
			}
			if enc, _ := json.Marshal(res); len(enc) > pluginsdk.MaxLine-1024 {
				t.Errorf("answer is %d bytes, over a protocol line", len(enc))
			}
		})
	}
}

func head(s string) string { return s[:min(len(s), 20)] }
func tail(s string) string { return s[max(0, len(s)-20):] }

func TestJSONLen(t *testing.T) {
	for _, s := range []string{"", "plain", "a\"b\\c\nd\te\rf", "<a href=x>&</a>", "é  \x01", "line one \U0001F600"} {
		enc, _ := json.Marshal(s)
		if got := jsonLen(s); got != len(enc) {
			t.Errorf("jsonLen(%q) = %d, json.Marshal is %d bytes", s, got, len(enc))
		}
	}
}
