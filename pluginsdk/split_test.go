package pluginsdk

import (
	"slices"
	"testing"
)

func TestSplitter(t *testing.T) {
	tests := []struct {
		name    string
		max     int
		chunks  []string
		want    []string
		rest    string
		skipped int
	}{
		{name: "whole lines", chunks: []string{"a\nb\n"}, want: []string{"a", "b"}},
		{name: "line across chunks", chunks: []string{`{"x":`, `1}`, "\n"}, want: []string{`{"x":1}`}},
		{name: "empty and blank lines dropped", chunks: []string{"\n \na\n\n"}, want: []string{"a"}},
		{name: "unterminated rest", chunks: []string{"a\nbc"}, want: []string{"a"}, rest: "bc"},
		{name: "oversize line skipped", max: 4, chunks: []string{"12345\nok\n"}, want: []string{"ok"}, skipped: 1},
		{name: "oversize across chunks skipped to newline", max: 4, chunks: []string{"123", "45", "67\nok\n"}, want: []string{"ok"}, skipped: 1},
		{name: "oversize rest is not returned", max: 2, chunks: []string{"ok\nabc"}, want: []string{"ok"}, skipped: 1},
		{name: "exactly max kept", max: 3, chunks: []string{"abc\n"}, want: []string{"abc"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := splitter{max: tt.max}
			var got []string
			for _, c := range tt.chunks {
				for _, l := range s.split(nil, []byte(c)) {
					got = append(got, string(l))
				}
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("lines = %q, want %q", got, tt.want)
			}
			if r := string(s.rest()); r != tt.rest {
				t.Errorf("rest = %q, want %q", r, tt.rest)
			}
			if s.skipped != tt.skipped {
				t.Errorf("skipped = %d, want %d", s.skipped, tt.skipped)
			}
		})
	}
}
