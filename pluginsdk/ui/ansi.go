package ui

import "strings"

// StripANSI returns s without terminal escape sequences: CSI (colours, cursor moves,
// erases), OSC (titles, links; ended by BEL or ESC \), the other ESC sequences and a lone
// ESC. For a log on a host without view.log.ansi, which shows them raw; with Log.ANSI the
// host strips (and colours) them itself.
func StripANSI(s string) string {
	i := strings.IndexByte(s, 0x1b)
	if i < 0 {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i >= 0 {
		b.WriteString(s[:i])
		s = s[i+escapeLen(s[i:]):]
		i = strings.IndexByte(s, 0x1b)
	}
	b.WriteString(s)
	return b.String()
}

// escapeLen is the length of the escape sequence at the start of s (s[0] is ESC); an
// unfinished one runs to the end of s.
func escapeLen(s string) int {
	if len(s) < 2 {
		return len(s)
	}
	switch s[1] {
	case '[': // CSI: parameter and intermediate bytes, then a final byte @..~
		for j := 2; j < len(s); j++ {
			if c := s[j]; c >= 0x40 && c <= 0x7e {
				return j + 1
			} else if c < 0x20 || c > 0x7e {
				return j // not a CSI byte: the sequence was cut short; keep what follows
			}
		}
		return len(s)
	case ']', 'P', '_', '^', 'X': // OSC, DCS, APC, PM, SOS: a string ended by BEL or ST
		for j := 2; j < len(s); j++ {
			if s[j] == 0x07 {
				return j + 1
			}
			if s[j] == 0x1b && j+1 < len(s) && s[j+1] == '\\' {
				return j + 2
			}
		}
		return len(s)
	}
	// nF sequences: intermediates 0x20..0x2f, then a final byte (ESC ( B selects a charset).
	j := 1
	for j < len(s) && s[j] >= 0x20 && s[j] <= 0x2f {
		j++
	}
	if j < len(s) {
		j++
	}
	return j
}

// NewANSILog returns a log node whose text's SGR colours the host shows (Log.ANSI).
func NewANSILog(key, text string) Node { return Node{Key: key, Log: &Log{Text: text, ANSI: true}} }
