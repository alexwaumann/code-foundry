package claudestream

import (
	"bufio"
	"bytes"
	"errors"
	"io"
)

// DefaultMaxLine bounds one stdout line. Lines carry whole tool results (a Read of a
// large file, a long Bash output) and can be several megabytes; longer ones are
// skipped, never buffered whole.
const DefaultMaxLine = 64 << 20

// readChunk is how much the reader asks for at a time.
const readChunk = 64 << 10

// Splitter cuts a byte stream into lines like the transcript tailer does
// (internal/store/session lineSplitter): empty lines are dropped and a line longer
// than Max is skipped to its newline.
type Splitter struct {
	// Max is the longest line kept; 0 means DefaultMaxLine.
	Max     int
	partial []byte
	skip    bool
	// Skipped counts the lines dropped for length.
	Skipped int
}

// Split appends the complete non-empty lines in data to lines, each a copy.
func (s *Splitter) Split(lines [][]byte, data []byte) [][]byte {
	limit := s.Max
	if limit <= 0 {
		limit = DefaultMaxLine
	}
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			if !s.skip {
				s.partial = append(s.partial, data...)
				if len(s.partial) > limit {
					s.partial, s.skip = nil, true
					s.Skipped++
				}
			}
			return lines
		}
		if s.skip {
			s.skip = false
		} else {
			line := append(s.partial, data[:i]...)
			s.partial = nil
			if len(line) > limit {
				s.Skipped++
			} else if len(bytes.TrimSpace(line)) > 0 {
				lines = append(lines, line)
			}
		}
		data = data[i+1:]
	}
	return lines
}

// Rest returns a final line without its newline (the stream ended mid-line), if any.
func (s *Splitter) Rest() []byte {
	if s.skip || len(bytes.TrimSpace(s.partial)) == 0 {
		return nil
	}
	return s.partial
}

// ReadLines reads r to EOF and calls fn with each line in order. It returns nil at
// EOF and the read error otherwise.
func ReadLines(r io.Reader, max int, fn func(line []byte)) error {
	sp := Splitter{Max: max}
	br := bufio.NewReaderSize(r, readChunk)
	buf := make([]byte, readChunk)
	var lines [][]byte
	for {
		n, err := br.Read(buf)
		if n > 0 {
			lines = sp.Split(lines[:0], buf[:n])
			for _, l := range lines {
				fn(l)
			}
		}
		if errors.Is(err, io.EOF) {
			if rest := sp.Rest(); rest != nil {
				fn(rest)
			}
			return nil
		}
		if err != nil {
			return err
		}
	}
}
