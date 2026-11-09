package ui

import (
	"strings"
	"testing"
)

func TestStripANSI(t *testing.T) {
	tests := []struct{ name, in, want string }{
		{"plain", "hello", "hello"},
		{"empty", "", ""},
		{"colour and reset", "\x1b[31mred\x1b[0m done", "red done"},
		{"bold bright", "\x1b[1;92mok\x1b[m", "ok"},
		{"256 and truecolor", "\x1b[38;5;208ma\x1b[48;2;1;2;3mb", "ab"},
		{"cursor and erase", "\x1b[2K\x1b[1Gline\x1b[?25l", "line"},
		{"private mode with intermediates", "\x1b[>4;1m\x1b[1 qx", "x"},
		{"osc title by BEL", "\x1b]0;title\x07after", "after"},
		{"osc link by ST", "\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\", "link"},
		{"charset", "\x1b(Bplain", "plain"},
		{"two-byte", "\x1bMup\x1b7", "up"},
		{"lone ESC at the end", "end\x1b", "end"},
		{"cut CSI at the end", "end\x1b[3", "end"},
		{"cut CSI before a newline", "a\x1b[3\nb", "a\nb"},
		{"unterminated OSC", "a\x1b]0;no end", "a"},
		{"utf-8 kept", "✓ \x1b[32mpass\x1b[0m ✗", "✓ pass ✗"},
		{"tab and CR kept", "a\tb\r\n", "a\tb\r\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := StripANSI(tt.in); got != tt.want {
				t.Errorf("StripANSI(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestANSILog(t *testing.T) {
	n := NewANSILog("l", "\x1b[31mfail\x1b[0m\n")
	if !n.Log.ANSI || n.Log.Text == "" {
		t.Fatalf("NewANSILog: %+v", n.Log)
	}
	if err := (View{Nodes: []Node{n}}).Validate(); err != nil {
		t.Fatal(err)
	}
	// Escapes count toward the log's bytes like any text.
	big := View{Nodes: []Node{NewANSILog("l", strings.Repeat("\x1b[31mx", MaxLogText/6+1))}}
	if err := big.Validate(); err == nil || !strings.Contains(err.Error(), "bytes of log text") {
		t.Errorf("big ANSI log: %v", err)
	}
}

func FuzzStripANSI(f *testing.F) {
	for _, s := range []string{"\x1b[31mx\x1b[0m", "\x1b]0;t\x07y", "a\x1b", "\x1b[", "\x1b(B", "plain"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		got := StripANSI(s)
		if strings.IndexByte(got, 0x1b) >= 0 {
			t.Fatalf("StripANSI(%q) = %q keeps an ESC", s, got)
		}
		if len(got) > len(s) {
			t.Fatalf("StripANSI grew %q", s)
		}
		if StripANSI(got) != got {
			t.Fatalf("StripANSI is not idempotent on %q", s)
		}
	})
}
