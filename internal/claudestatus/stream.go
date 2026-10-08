package claudestatus

import "bytes"

// streamScanner extracts the few things status detection needs from the raw PTY byte
// stream, without rendering it: OSC payloads (title, notifications, progress, program
// status), BEL outside of string sequences, and DEC private mode switches (alternate
// screen, bracketed paste). Everything else is skipped.
//
// It is a resumable state machine: a sequence split across chunks is completed by the
// next call. Ground-state text is skipped with bytes.IndexByte, so the cost is roughly
// proportional to the number of escape sequences, not the number of bytes.
type streamScanner struct {
	state scanState

	// csi collects the parameter bytes of a CSI sequence that started with '?'.
	csi        [16]byte
	csiLen     int
	csiPrivate bool
	csiBad     bool

	// osc collects an OSC payload up to maxOSC bytes; longer payloads are truncated.
	osc []byte

	sink scanSink
}

// scanSink receives what the scanner finds. All callbacks run synchronously inside
// scan.
type scanSink interface {
	osc(payload []byte)
	bell()
	decMode(mode int, set bool)
}

type scanState uint8

const (
	stGround    scanState = iota
	stEsc                 // after ESC
	stCSI                 // after ESC [
	stOSC                 // after ESC ]
	stOSCEsc              // ESC seen inside OSC (expecting '\')
	stString              // DCS/APC/PM/SOS: skipped until ST
	stStringEsc           // ESC seen inside a skipped string
)

// maxOSC bounds the OSC payload kept for inspection. Titles and notifications are far
// shorter; OSC 52 clipboard writes and the like are truncated (and ignored).
const maxOSC = 1024

const (
	esc = 0x1b
	bel = 0x07
)

func newStreamScanner(sink scanSink) *streamScanner {
	return &streamScanner{sink: sink, osc: make([]byte, 0, 256)}
}

func (s *streamScanner) scan(p []byte) {
	n := len(p)
	i := 0
	nextBel := -1 // index of the next BEL at or after i, n if none, -1 if not yet searched
	for i < n {
		switch s.state {
		case stGround:
			end := i
			if p[i] != esc { // sequences are often back to back
				end = indexFrom(p, i, esc)
			}
			// BELs in ground text. BEL is rare, so its position is searched once and
			// only searched again after it has been passed.
			if nextBel < i {
				nextBel = indexFrom(p, i, bel)
			}
			for nextBel < end {
				s.sink.bell()
				nextBel = indexFrom(p, nextBel+1, bel)
			}
			if end == n {
				return
			}
			i = end + 1
			s.state = stEsc

		case stEsc:
			c := p[i]
			i++
			switch c {
			case '[':
				s.state = stCSI
				s.csiLen, s.csiPrivate, s.csiBad = 0, false, false
				if i < n && p[i] != '?' {
					// Fast path: only DEC private modes are of interest; skip to the
					// final byte.
					i = s.skipCSI(p, i)
				}
			case ']':
				s.state = stOSC
				s.osc = s.osc[:0]
			case 'P', 'X', '^', '_':
				s.state = stString
			case esc:
				// ESC ESC: stay in stEsc.
			default:
				// Two-byte escape (ESC 7, ESC =, ...). For ESC ( B and friends the
				// final byte is consumed as ground text, which is harmless.
				s.state = stGround
			}

		case stCSI:
			i += s.scanCSI(p[i:])

		case stOSC:
			// An OSC ends with BEL or ESC \ (ST).
			j := indexBelOrEsc(p[i:])
			if j < 0 {
				s.appendOSC(p[i:])
				return
			}
			s.appendOSC(p[i : i+j])
			c := p[i+j]
			i += j + 1
			if c == bel {
				s.sink.osc(s.osc)
				s.state = stGround
			} else {
				s.state = stOSCEsc
			}

		case stOSCEsc:
			// ESC \ terminates; anything else aborts the OSC and starts a new escape.
			s.sink.osc(s.osc)
			if p[i] == '\\' {
				i++
				s.state = stGround
			} else {
				s.state = stEsc
			}

		case stString:
			j := bytes.IndexByte(p[i:], esc)
			if j < 0 {
				return
			}
			i += j + 1
			s.state = stStringEsc

		case stStringEsc:
			if p[i] == '\\' {
				i++
				s.state = stGround
			} else {
				s.state = stEsc
			}
		}
	}
}

// skipCSI skips a non-private CSI sequence starting at p[i] (just after "ESC [") and
// returns the index after it. If the chunk ends first, the state stays stCSI with
// csiBad set, so scanCSI finishes skipping it in the next chunk.
func (s *streamScanner) skipCSI(p []byte, i int) int {
	for ; i < len(p); i++ {
		c := p[i]
		if c >= 0x40 && c <= 0x7e {
			s.state = stGround
			return i + 1
		}
		if c == esc {
			s.state = stEsc
			return i + 1
		}
	}
	s.csiBad = true
	return i
}

// scanCSI consumes CSI bytes from p and returns how many it used. It leaves stCSI when
// it sees the final byte (or an ESC that aborts the sequence).
func (s *streamScanner) scanCSI(p []byte) int {
	for n, c := range p {
		switch {
		case c >= 0x40 && c <= 0x7e: // final byte
			s.finishCSI(c)
			s.state = stGround
			return n + 1
		case c == esc: // aborted
			s.state = stEsc
			return n + 1
		case c == '?' && s.csiLen == 0 && !s.csiPrivate && !s.csiBad:
			s.csiPrivate = true
		case (c >= '0' && c <= '9') || c == ';':
			if s.csiLen < len(s.csi) {
				s.csi[s.csiLen] = c
				s.csiLen++
			} else {
				s.csiBad = true
			}
		default:
			// Other parameter/intermediate bytes ('>', '<', '=', ' ', '$', ...).
			s.csiBad = true
		}
	}
	return len(p)
}

// indexFrom returns the index of the first c in p at or after i, or len(p).
func indexFrom(p []byte, i int, c byte) int {
	if i >= len(p) {
		return len(p)
	}
	if j := bytes.IndexByte(p[i:], c); j >= 0 {
		return i + j
	}
	return len(p)
}

func (s *streamScanner) appendOSC(b []byte) {
	if room := maxOSC - len(s.osc); room > 0 {
		if len(b) > room {
			b = b[:room]
		}
		s.osc = append(s.osc, b...)
	}
}

// finishCSI reports DEC private mode set/reset (CSI ? Pm h / CSI ? Pm l).
func (s *streamScanner) finishCSI(final byte) {
	if !s.csiPrivate || s.csiBad || (final != 'h' && final != 'l') {
		return
	}
	mode, have := 0, false
	for _, c := range s.csi[:s.csiLen] {
		if c == ';' {
			if have {
				s.sink.decMode(mode, final == 'h')
			}
			mode, have = 0, false
			continue
		}
		mode = mode*10 + int(c-'0')
		have = true
	}
	if have {
		s.sink.decMode(mode, final == 'h')
	}
}

func indexBelOrEsc(p []byte) int {
	i := bytes.IndexByte(p, bel)
	j := bytes.IndexByte(p, esc)
	switch {
	case i < 0:
		return j
	case j < 0:
		return i
	case i < j:
		return i
	default:
		return j
	}
}
