package textsearch

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestCaseSensitive(t *testing.T) {
	tests := []struct {
		q    Query
		want bool
	}{
		{Query{Text: "func home"}, false},
		{Query{Text: "func Home"}, true},
		{Query{Text: "élan"}, false},
		{Query{Text: "Élan"}, true},
		{Query{Text: "home", MatchCase: true}, true},
		{Query{Text: "123 -_."}, false},
		// A literal backslash-letter is text: its upper case counts.
		{Query{Text: `\W`}, true},
		// In a regular expression an escape is not text.
		{Query{Text: `\Wfoo\S+`, Regex: true}, false},
		{Query{Text: `\p{Lu}x`, Regex: true}, false},
		{Query{Text: `\x{41}b`, Regex: true}, false},
		{Query{Text: `foo\\Bar`, Regex: true}, true}, // \\ is a backslash; Bar is text
		{Query{Text: `[A-Z]`, Regex: true}, true},
		{Query{Text: `foo\`, Regex: true}, false},
	}
	for _, tt := range tests {
		if got := tt.q.CaseSensitive(); got != tt.want {
			t.Errorf("%+v: CaseSensitive = %v, want %v", tt.q, got, tt.want)
		}
	}
}

func TestQueryCheck(t *testing.T) {
	tests := []struct {
		text string
		want string // "" valid
	}{
		{"", ""},
		{"  spaces  count ", ""},
		{strings.Repeat("é", MaxQueryChars), ""},
		{strings.Repeat("é", MaxQueryChars+1), "at most 500"},
		{"a\nb", "more than one line"},
		{"a\rb", "more than one line"},
		{"a\x00b", "NUL"},
		{"a\xffb", "not valid UTF-8"},
	}
	for _, tt := range tests {
		err := Query{Text: tt.text}.check()
		switch {
		case tt.want == "" && err != nil:
			t.Errorf("%q: %v, want valid", tt.text, err)
		case tt.want != "" && (err == nil || !strings.Contains(err.Error(), tt.want) || !errors.Is(err, ErrInvalidQuery)):
			t.Errorf("%q: %v, want ErrInvalidQuery with %q", tt.text, err, tt.want)
		}
	}
}

func TestRegexError(t *testing.T) {
	tests := []struct {
		pattern, stderr, want string
	}{
		{"(foo", "rg: regex parse error:\n    (?:(foo)\n    ^\nerror: unclosed group\n", "invalid regular expression: unclosed group"},
		{`foo\`, "rg: regex parse error:\n    (?:foo\\)\n    ^\nerror: unclosed group\n", `invalid regular expression: it ends with a lone \ (write \\ for a backslash)`},
		{`foo\\`, "rg: regex parse error:\n x\nerror: something\n", "invalid regular expression: something"},
		{"a{99999999}", "rg: compiled regex exceeds size limit of 104857600\n", "invalid regular expression: compiled regex exceeds size limit of 104857600"},
		{"x", "", "invalid regular expression: ripgrep refused it"},
	}
	for _, tt := range tests {
		err := regexError(tt.pattern, tt.stderr)
		if err.Error() != tt.want || !errors.Is(err, ErrInvalidQuery) {
			t.Errorf("%q: %q, want %q", tt.pattern, err, tt.want)
		}
	}
}

func TestMakeLine(t *testing.T) {
	// A 50-character window keeps 16 characters (a third) before the first match.
	long := strings.Repeat("a", 100) + "NEEDLE" + strings.Repeat("b", 100)
	tests := []struct {
		name     string
		raw      string
		subs     []submatch
		maxChars int
		want     Line
	}{
		{
			name: "ascii, line break dropped", raw: "foo bar foo\n", subs: []submatch{{0, 3}, {8, 11}}, maxChars: 100,
			want: Line{Number: 7, Text: "foo bar foo", Ranges: []Range{{0, 3}, {8, 11}}},
		},
		{
			name: "crlf", raw: "foo\r\n", subs: []submatch{{0, 3}}, maxChars: 100,
			want: Line{Number: 7, Text: "foo", Ranges: []Range{{0, 3}}},
		},
		{
			// é is two bytes, 😀 four (two UTF-16 units: code points, not UTF-16).
			name: "non-ascii offsets are code points", raw: "héllo 😀 wörld\n", subs: []submatch{{7, 11}, {12, 18}}, maxChars: 100,
			want: Line{Number: 7, Text: "héllo 😀 wörld", Ranges: []Range{{6, 7}, {8, 13}}},
		},
		{
			name: "invalid bytes are one U+FFFD each", raw: "x\xff\xfeFOO\n", subs: []submatch{{3, 6}}, maxChars: 100,
			want: Line{Number: 7, Text: "x��FOO", Ranges: []Range{{3, 6}}},
		},
		{
			name: "empty match", raw: "abc", subs: []submatch{{0, 0}}, maxChars: 100,
			want: Line{Number: 7, Text: "abc", Ranges: []Range{{0, 0}}},
		},
		{
			name: "cut around the first match", raw: long, subs: []submatch{{100, 106}}, maxChars: 50,
			want: Line{Number: 7, Text: strings.Repeat("a", 16) + "NEEDLE" + strings.Repeat("b", 28), Ranges: []Range{{16, 22}}, CutStart: true, CutEnd: true},
		},
		{
			name: "cut at the start", raw: "NEEDLE" + strings.Repeat("b", 100), subs: []submatch{{0, 6}, {90, 100}}, maxChars: 50,
			want: Line{Number: 7, Text: "NEEDLE" + strings.Repeat("b", 44), Ranges: []Range{{0, 6}}, CutEnd: true},
		},
		{
			name: "cut at the end keeps the window full", raw: strings.Repeat("a", 100) + "NEEDLE", subs: []submatch{{100, 106}}, maxChars: 50,
			want: Line{Number: 7, Text: strings.Repeat("a", 44) + "NEEDLE", Ranges: []Range{{44, 50}}, CutStart: true},
		},
		{
			name: "a match the window cuts is clipped", raw: strings.Repeat("a", 30) + strings.Repeat("N", 40), subs: []submatch{{30, 70}}, maxChars: 20,
			want: Line{Number: 7, Text: "aaaaaa" + strings.Repeat("N", 14), Ranges: []Range{{6, 20}}, CutStart: true, CutEnd: true},
		},
		{
			name: "cut counts code points", raw: strings.Repeat("é", 60) + "x" + strings.Repeat("é", 60), subs: []submatch{{120, 121}}, maxChars: 50,
			want: Line{Number: 7, Text: strings.Repeat("é", 16) + "x" + strings.Repeat("é", 33), Ranges: []Range{{16, 17}}, CutStart: true, CutEnd: true},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := makeLine(7, []byte(tt.raw), tt.subs, tt.maxChars)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("makeLine\n got %+v\nwant %+v", got, tt.want)
			}
		})
	}
}
