package textsearch

import (
	"strings"
	"unicode/utf8"
)

// Range is a match within a Line's Text: code points (Go runes; JavaScript's
// Array.from(text) indices), End exclusive.
type Range struct{ Start, End int }

// Line is one line of a file with a match.
type Line struct {
	// Number is 1-based.
	Number int
	// Text is the line without its line break, valid UTF-8 (each byte that is not becomes
	// U+FFFD), cut to a window of at most Limits.LineChars code points around the first
	// match when longer.
	Text string
	// Ranges are every match in Text, in order; a match the window cuts is clipped to it.
	Ranges []Range
	// CutStart and CutEnd: Text begins after the line's start, or ends before its end.
	CutStart, CutEnd bool
}

// cutContext is how many code points before the first match a cut line keeps (at most a
// third of the window, so the match is always in it).
const cutContext = 40

// makeLine converts one of ripgrep's lines (raw bytes, its line break included) and its
// submatches (byte offsets into raw) to a Line of at most maxChars code points.
func makeLine(number int, raw []byte, subs []submatch, maxChars int) Line {
	raw = trimBreak(raw)
	// cp[i] is the code point index at byte i; cp[len(raw)] is the count. A byte that does
	// not start a valid rune is one U+FFFD, so offsets map one to one.
	cp := make([]int, len(raw)+1)
	var b strings.Builder
	b.Grow(len(raw))
	n := 0
	for i := 0; i < len(raw); {
		r, size := utf8.DecodeRune(raw[i:])
		for k := range size {
			cp[i+k] = n
		}
		if r == utf8.RuneError && size == 1 {
			b.WriteRune(utf8.RuneError)
		} else {
			b.Write(raw[i : i+size])
		}
		n++
		i += size
	}
	cp[len(raw)] = n
	at := func(off int) int { return cp[min(max(off, 0), len(raw))] }
	ranges := make([]Range, 0, len(subs))
	for _, s := range subs {
		// A match inside a rune (never from ripgrep, but cheap to guard) covers the rune.
		start, end := at(s.Start), at(s.End)
		if s.End > s.Start && s.End <= len(raw) && end == at(s.End-1) {
			end++
		}
		ranges = append(ranges, Range{start, max(end, start)})
	}
	text := b.String()
	if n <= maxChars {
		return Line{Number: number, Text: text, Ranges: ranges}
	}
	first := 0
	if len(ranges) > 0 {
		first = ranges[0].Start
	}
	from := max(first-min(cutContext, maxChars/3), 0)
	from = max(min(from, n-maxChars), 0)
	to := from + maxChars
	runes := []rune(text)
	kept := ranges[:0]
	for _, r := range ranges {
		empty := r.Start == r.End
		if (empty && (r.Start < from || r.Start > to)) || (!empty && (r.Start >= to || r.End <= from)) {
			continue
		}
		kept = append(kept, Range{max(r.Start, from) - from, min(r.End, to) - from})
	}
	return Line{Number: number, Text: string(runes[from:to]), Ranges: kept, CutStart: from > 0, CutEnd: to < n}
}

// trimBreak drops a trailing "\n" or "\r\n".
func trimBreak(b []byte) []byte {
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
		if len(b) > 0 && b[len(b)-1] == '\r' {
			b = b[:len(b)-1]
		}
	}
	return b
}
