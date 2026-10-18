package pluginsdk

import "bytes"

// MaxLine is the longest protocol line either side accepts (4 MiB). A longer line is
// skipped to its newline, never buffered whole, and reported as an issue.
const MaxLine = 4 << 20

// splitter cuts a byte stream into newline-terminated lines. Empty lines are dropped and
// a line longer than max is skipped.
type splitter struct {
	max     int
	partial []byte
	skip    bool
	skipped int
}

// split appends the complete non-empty lines in data to lines, each a copy.
func (s *splitter) split(lines [][]byte, data []byte) [][]byte {
	limit := s.max
	if limit <= 0 {
		limit = MaxLine
	}
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			if !s.skip {
				s.partial = append(s.partial, data...)
				if len(s.partial) > limit {
					s.partial, s.skip = nil, true
					s.skipped++
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
				s.skipped++
			} else if len(bytes.TrimSpace(line)) > 0 {
				lines = append(lines, line)
			}
		}
		data = data[i+1:]
	}
	return lines
}

// rest returns a final line without its newline (the stream ended mid-line), if any.
func (s *splitter) rest() []byte {
	if s.skip || len(bytes.TrimSpace(s.partial)) == 0 {
		return nil
	}
	return s.partial
}
