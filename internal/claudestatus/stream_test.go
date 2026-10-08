package claudestatus

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

// recSink records scanner callbacks as strings.
type recSink struct{ got []string }

func (r *recSink) osc(p []byte)            { r.got = append(r.got, "osc:"+string(p)) }
func (r *recSink) bell()                   { r.got = append(r.got, "bel") }
func (r *recSink) decMode(m int, set bool) { r.got = append(r.got, fmt.Sprintf("mode:%d:%v", m, set)) }

func scanAll(chunks ...string) []string {
	r := &recSink{}
	s := newStreamScanner(r)
	for _, c := range chunks {
		s.scan([]byte(c))
	}
	return r.got
}

func TestStreamScanner(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{"plain text", "hello world\r\n", nil},
		{"title BEL", "\x1b]0;✳ Claude Code\x07", []string{"osc:0;✳ Claude Code"}},
		{"title ST", "\x1b]2;◐ Task\x1b\\", []string{"osc:2;◐ Task"}},
		{"bell in text", "a\x07b\x07", []string{"bel", "bel"}},
		{"bell terminating OSC is not a bell", "\x1b]0;x\x07\x07", []string{"osc:0;x", "bel"}},
		{"ghostty notify", "\x1b]777;notify;Claude Code;Claude needs your permission\x07",
			[]string{"osc:777;notify;Claude Code;Claude needs your permission"}},
		{"alt screen on/off", "\x1b[?1049h..\x1b[?1049l", []string{"mode:1049:true", "mode:1049:false"}},
		{"multiple modes", "\x1b[?1000;1006h", []string{"mode:1000:true", "mode:1006:true"}},
		{"non-private CSI ignored", "\x1b[2J\x1b[1;3H\x1b[38;2;1;2;3m", nil},
		{"kitty keyboard CSI ignored", "\x1b[>1u\x1b[<u\x1b[?u", nil},
		{"DECRQM-like ignored", "\x1b[?2026$p", nil},
		// Observed in Claude's startup output: a kitty graphics query (APC).
		{"APC skipped", "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\x\x07", []string{"bel"}},
		{"DCS skipped", "\x1bP>|xterm\x1b\\\x07", []string{"bel"}},
		{"bell inside DCS ignored", "\x1bPa\x07b\x1b\\", nil},
		{"CSI aborted by ESC", "\x1b[12\x1b]0;t\x07", []string{"osc:0;t"}},
		{"OSC aborted by ESC", "\x1b]0;t\x1b[?25h", []string{"osc:0;t", "mode:25:true"}},
		{"ESC ESC", "\x1b\x1b]0;t\x07", []string{"osc:0;t"}},
		{"charset designation", "\x1b(B\x1b]0;t\x07", []string{"osc:0;t"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := scanAll(tt.in); !slices.Equal(got, tt.want) {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

// Splitting the stream at any byte must not change what is found.
func TestStreamScannerSplits(t *testing.T) {
	in := "x\x1b]0;◐ Touch hello.txt\x07y\x1b[38;5;174m\x1b[?1049h\x07\x1b_Gq\x1b\\\x1b]777;notify;T;B\x1b\\\x1b[?2004l\x1b]9;4;1;50\x07\x07"
	want := scanAll(in)
	if len(want) != 7 {
		t.Fatalf("unsplit scan found %q", want)
	}
	for i := 0; i <= len(in); i++ {
		for j := i; j <= len(in); j++ {
			got := scanAll(in[:i], in[i:j], in[j:])
			if !slices.Equal(got, want) {
				t.Fatalf("split at %d,%d: got %q, want %q", i, j, got, want)
			}
		}
	}
}

func TestStreamScannerOSCOverflow(t *testing.T) {
	long := strings.Repeat("a", 3*maxOSC)
	got := scanAll("\x1b]52;c;"+long+"\x07", "\x1b]0;t\x07")
	if len(got) != 2 || len(got[0]) != len("osc:")+maxOSC || got[1] != "osc:0;t" {
		t.Fatalf("got %d events, first len %d", len(got), len(got[0]))
	}
}
