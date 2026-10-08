package terminal

import (
	"fmt"
	"strings"
	"testing"

	ghostty "go.mitchellh.com/libghostty"
)

// vtState is everything a snapshot must reproduce, read from a libghostty terminal.
type vtState struct {
	VT        string // VT-formatted active screen incl. scrollback (text + SGR)
	Plain     string
	Unwrapped string // plain with soft wraps joined: checks wrap flags survive
	CursorX   uint16
	CursorY   uint16
	Alt       bool
	Title     string
	Modes     map[string]bool
	Scrollbak uint
}

var checkedModes = map[string]ghostty.Mode{
	"DECCKM":          ghostty.ModeDECCKM,
	"cursorVisible":   ghostty.ModeCursorVisible,
	"bracketedPaste":  ghostty.ModeBracketedPaste,
	"altScreenSave":   ghostty.ModeAltScreenSave,
	"anyMouse":        ghostty.ModeAnyMouse,
	"sgrMouse":        ghostty.ModeSGRMouse,
	"wraparound":      ghostty.ModeWraparound,
	"focusEvent":      ghostty.ModeFocusEvent,
	"keypadKeys":      ghostty.ModeKeypadKeys,
	"altScreen(1047)": ghostty.ModeAltScreen,
}

func readState(t *testing.T, term *ghostty.Terminal) vtState {
	t.Helper()
	vt, err := format(term, ghostty.WithFormatterFormat(ghostty.FormatterFormatVT))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := format(term, ghostty.WithFormatterFormat(ghostty.FormatterFormatPlain))
	if err != nil {
		t.Fatal(err)
	}
	unwrapped, err := format(term, ghostty.WithFormatterFormat(ghostty.FormatterFormatPlain), ghostty.WithFormatterUnwrap(true))
	if err != nil {
		t.Fatal(err)
	}
	s := vtState{VT: string(vt), Plain: string(plain), Unwrapped: string(unwrapped), Modes: map[string]bool{}}
	s.CursorX, _ = term.CursorX()
	s.CursorY, _ = term.CursorY()
	scr, _ := term.ActiveScreen()
	s.Alt = scr == ghostty.ScreenAlternate
	s.Title, _ = term.Title()
	s.Scrollbak, _ = term.ScrollbackRows()
	for name, m := range checkedModes {
		s.Modes[name] = modeOf(term, m)
	}
	return s
}

func newTestVT(t *testing.T, cols, rows uint16) *ghostty.Terminal {
	t.Helper()
	term, err := newVT(cols, rows, scrollbackLimits{lines: 1000, bytes: 16 << 20}, vtHooks{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(term.Close)
	return term
}

func compareStates(t *testing.T, label string, want, got vtState) {
	t.Helper()
	if got.VT != want.VT {
		t.Errorf("%s: VT dump differs\nwant %q\ngot  %q", label, want.VT, got.VT)
	}
	if got.Plain != want.Plain {
		t.Errorf("%s: plain dump differs\nwant %q\ngot  %q", label, want.Plain, got.Plain)
	}
	if got.Unwrapped != want.Unwrapped {
		t.Errorf("%s: unwrapped dump differs (soft wraps lost?)\nwant %q\ngot  %q", label, want.Unwrapped, got.Unwrapped)
	}
	if got.CursorX != want.CursorX || got.CursorY != want.CursorY {
		t.Errorf("%s: cursor = (%d,%d), want (%d,%d)", label, got.CursorX, got.CursorY, want.CursorX, want.CursorY)
	}
	if got.Alt != want.Alt {
		t.Errorf("%s: alt = %v, want %v", label, got.Alt, want.Alt)
	}
	if got.Title != want.Title {
		t.Errorf("%s: title = %q, want %q", label, got.Title, want.Title)
	}
	if got.Scrollbak != want.Scrollbak {
		t.Errorf("%s: scrollback rows = %d, want %d", label, got.Scrollbak, want.Scrollbak)
	}
	for name, v := range want.Modes {
		if got.Modes[name] != v {
			t.Errorf("%s: mode %s = %v, want %v", label, name, got.Modes[name], v)
		}
	}
}

func scrollLines(n int) string {
	var sb strings.Builder
	for i := range n {
		fmt.Fprintf(&sb, "scroll line %02d\r\n", i)
	}
	return sb.String()
}

// The demo's sequences (docs/notes/libghostty-vt-demo.go.txt) plus the edge cases the
// serializer has to handle explicitly.
var snapshotCases = []struct {
	name       string
	cols, rows uint16
	input      string
	// after is fed to both the original and the replay after the snapshot, to check that
	// the replay continues identically (continuation, saved cursor, alt-screen exit).
	after string
}{
	{name: "empty", cols: 80, rows: 24},
	{
		name: "colored text", cols: 80, rows: 24,
		input: "plain line 1\r\n\x1b[1;31mred bold\x1b[0m and \x1b[38;2;255;128;0morange\x1b[0m\r\n" +
			"\x1b[4;3:1mcurly\x1b[0m \x1b[7minverse\x1b[0m \x1b[48;5;27mbg256\x1b[0m",
		after: "!",
	},
	{
		name: "cursor position", cols: 80, rows: 24,
		input: "plain line 1\r\n\x1b[10;20Hat row10 col20\x1b[5;1Hvia io.Writer",
		after: "X",
	},
	{
		name: "pen style survives", cols: 40, rows: 10,
		input: "\x1b[1;32mgreen and still green",
		after: " more",
	},
	{
		name: "scrollback", cols: 40, rows: 10,
		input: scrollLines(40),
		after: "next\r\n",
	},
	{
		name: "scrollback then clear leaves trailing blank rows", cols: 40, rows: 10,
		input: scrollLines(30) + "\x1b[H\x1b[2Jtop line\r\nsecond",
		after: "\r\nthird",
	},
	{
		name: "soft wrapped long line", cols: 20, rows: 5,
		input: strings.Repeat("abcdefghij", 7) + "\r\n" + scrollLines(3),
		after: "tail",
	},
	{
		name: "pending wrap at right edge", cols: 10, rows: 4,
		input: "0123456789",
		after: "W",
	},
	{
		name: "wide characters", cols: 10, rows: 4,
		input: "日本語日本語x\r\nemoji 😀!",
		after: "ok",
	},
	{
		name: "modes and title", cols: 80, rows: 24,
		input: "\x1b]0;my title\x07\x1b[?2004h\x1b[?1h\x1b=\x1b[?25l\x1b[?1003h\x1b[?1006h\x1b[?1004hprompt$ ",
		after: "ls",
	},
	{
		name: "scrolling region", cols: 40, rows: 10,
		input: scrollLines(12) + "\x1b[3;8r\x1b[8;1Hinside region",
		after: "\r\nscrolls\r\nwithin\r\nregion",
	},
	{
		name: "tabstops", cols: 40, rows: 5,
		input: "\x1b[3g\x1b[5G\x1bH\x1b[15G\x1bH\r\ta\tb",
		after: "\r\n\tc\td",
	},
	{
		name: "alternate screen 1049", cols: 80, rows: 24,
		input: "plain line 1\r\n\x1b[1;31mred bold\x1b[0m\r\n" + scrollLines(30) + "shell$ " +
			"\x1b[?1049h\x1b[H\x1b[7mALT SCREEN\x1b[0m\r\nfullscreen app here\x1b[5;7H",
		after: "typed\x1b[?1049lback on primary",
	},
	{
		name: "alternate screen 1047", cols: 40, rows: 8,
		input: "primary text\x1b[?1047h\x1b[Halt text",
		after: "\x1b[?1047lafter",
	},
	{
		name: "alternate screen 47", cols: 40, rows: 8,
		input: "primary text\x1b[?47h\x1b[2;2Halt text",
		after: "\x1b[?47lafter",
	},
	{
		name: "mid CSI continuation", cols: 40, rows: 5,
		input: "before \x1b[3",
		after: "1mred\x1b[0m after",
	},
	{
		name: "mid OSC title continuation", cols: 40, rows: 5,
		input: "text\x1b]2;half a ti",
		after: "tle\x07 more",
	},
	{
		name: "mid UTF-8 continuation", cols: 40, rows: 5,
		input: "caf\xc3",
		after: "\xa9 ok",
	},
	{
		name: "palette changed", cols: 40, rows: 5,
		input: "\x1b]4;1;rgb:12/34/56\x1b\\\x1b[31mcustom red",
		after: "\x1b[0m.",
	},
}

func TestSnapshotRoundTrip(t *testing.T) {
	for _, tc := range snapshotCases {
		t.Run(tc.name, func(t *testing.T) {
			orig := newTestVT(t, tc.cols, tc.rows)
			orig.VTWrite([]byte(tc.input))

			snap, err := buildSnapshot(orig)
			if err != nil {
				t.Fatal(err)
			}
			// buildSnapshot must not disturb the live terminal.
			before := readState(t, orig)

			replay := newTestVT(t, tc.cols, tc.rows)
			replay.VTWrite(snap)
			compareStates(t, "after snapshot", before, readState(t, replay))

			if tc.after != "" {
				orig.VTWrite([]byte(tc.after))
				replay.VTWrite([]byte(tc.after))
				compareStates(t, "after continuing", readState(t, orig), readState(t, replay))
			}
			if t.Failed() {
				t.Logf("snapshot: %q", snap)
			}
		})
	}
}

func TestSnapshotDoesNotMutate(t *testing.T) {
	term := newTestVT(t, 40, 8)
	term.VTWrite([]byte(scrollLines(20) + "under\x1b[?1049h\x1b[Halt\x1b[3;3H"))
	want := readState(t, term)
	for range 3 {
		if _, err := buildSnapshot(term); err != nil {
			t.Fatal(err)
		}
	}
	compareStates(t, "after 3 snapshots", want, readState(t, term))
	// Leaving the alternate screen must still restore the cursor saved on entry.
	term.VTWrite([]byte("\x1b[?1049l"))
	if x, _ := term.CursorX(); x != 5 {
		t.Fatalf("cursor x after 1049l = %d, want 5", x)
	}
}

func TestPadRows(t *testing.T) {
	tests := []struct {
		content string
		total   uint
		want    int
	}{
		{"", 24, 23},
		{"one", 24, 23},
		{"a\r\nb", 24, 22},
		{"a\r\nb\r\nc", 3, 0},
		{"a\r\nb\r\nc\r\nd", 3, 0},
		{"\x1b[?2004h\x1b[Ha", 5, 4},
	}
	for _, tt := range tests {
		if got := padRows([]byte(tt.content), tt.total); got != tt.want {
			t.Errorf("padRows(%q, %d) = %d, want %d", tt.content, tt.total, got, tt.want)
		}
	}
}

func TestAltScreenExit(t *testing.T) {
	tests := []struct {
		m1049, m1047 bool
		want         string
	}{
		{true, false, "\x1b[?1049l"},
		{true, true, "\x1b[?1049l"},
		{false, true, "\x1b[?1047l"},
		{false, false, "\x1b[?47l"},
	}
	for _, tt := range tests {
		if got := altScreenExit(tt.m1049, tt.m1047); got != tt.want {
			t.Errorf("altScreenExit(%v,%v) = %q, want %q", tt.m1049, tt.m1047, got, tt.want)
		}
	}
}

func TestSanitizeTitle(t *testing.T) {
	tests := []struct{ in, want string }{
		{"plain", "plain"},
		{"a\x1b]0;evil\x07b", "a]0;evilb"},
		{"tab\there", "tabhere"},
		{"unicode ✳ ok", "unicode ✳ ok"},
		{"c1\u009bx", "c1x"},
	}
	for _, tt := range tests {
		if got := sanitizeTitle(tt.in); got != tt.want {
			t.Errorf("sanitizeTitle(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// BenchmarkSnapshotFullScrollback measures the worst case Attach pays: 10,000 lines of
// colored 120-column scrollback plus a full screen.
func BenchmarkSnapshotFullScrollback(b *testing.B) {
	term, err := newVT(120, 40, scrollbackLimits{lines: 10_000, bytes: 64 << 20}, vtHooks{})
	if err != nil {
		b.Fatal(err)
	}
	defer term.Close()
	line := []byte("\x1b[32mok\x1b[0m \x1b[1;34minternal/store/terminal/actor.go\x1b[0m:42 " +
		strings.Repeat("log text ", 9) + "\r\n")
	for range 10_200 {
		term.VTWrite(line)
	}
	var size int
	for b.Loop() {
		snap, err := buildSnapshot(term)
		if err != nil {
			b.Fatal(err)
		}
		size = len(snap)
	}
	sb, _ := term.ScrollbackRows()
	b.ReportMetric(float64(sb), "scrollback-rows")
	b.ReportMetric(float64(size)/(1<<20), "MiB/snapshot")
	if mu, err := term.MemoryUsage(); err == nil {
		b.ReportMetric(float64(mu.Primary.ResidentBytes)/(1<<20), "MiB-vt-resident")
	}
}
