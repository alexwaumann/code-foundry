package textsearch

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// ripgrep's --json messages, as far as text search reads them. A path or line that is
// not valid UTF-8 comes as {"bytes": base64} instead of {"text": ...}.
type rgMessage struct {
	Type string `json:"type"`
	Data struct {
		Path         rgText     `json:"path"`
		Lines        rgText     `json:"lines"`
		LineNumber   int        `json:"line_number"`
		Submatches   []submatch `json:"submatches"`
		BinaryOffset *int64     `json:"binary_offset"`
		Stats        *struct {
			MatchedLines int `json:"matched_lines"`
		} `json:"stats"`
	} `json:"data"`
}

type rgText struct {
	Text  *string `json:"text"`
	Bytes []byte  `json:"bytes"` // encoding/json decodes the base64
}

func (t rgText) raw() []byte {
	if t.Text != nil {
		return []byte(*t.Text)
	}
	return t.Bytes
}

// submatch is one match in a line: byte offsets into the line.
type submatch struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// matchPrefix starts every match message: ripgrep writes "type" first.
var matchPrefix = []byte(`{"type":"match"`)

const (
	// readBuffer is the JSON reader's buffer; a longer message is read in pieces.
	readBuffer = 64 << 10
	// maxMessage bounds one JSON message kept to decode (a line of a minified file can be
	// megabytes). A longer one is dropped: its line is not shown, the file's count holds it.
	maxMessage = 32 << 20
	// maxStderr bounds what is kept of ripgrep's stderr (per-file errors, for the log).
	maxStderr = 16 << 10
	// waitDelay bounds how long Wait waits for ripgrep's pipes after a kill.
	waitDelay = 2 * time.Second
)

// chunk is a run of one source's files, in search order, searched by one ripgrep.
type chunk struct {
	source int
	dir    string
	files  []fsx.FileEntry
	// first is the search-order index of files[0].
	first int
}

// chunkResult is a chunk's files with a match, in search order.
type chunkResult struct {
	files []File
	// err: ripgrep could not run, or ctx ended before it finished (files then holds the
	// files it had finished).
	err error
	// launched: the chunk took a slot of the pipeline (it is released when read).
	launched bool
}

// fileState is one file while ripgrep reports it.
type fileState struct {
	order   int
	file    File
	matched int
}

// runChunk runs ripgrep over one chunk and collects its files: at most limits.FileLines
// lines each, binary files dropped, at most limits.TotalLines lines over all (the files
// latest in order go first; the search cannot send more). pids, when set, hears the
// process id.
func runChunk(ctx context.Context, bin string, args []string, ch chunk, limits Limits, pids func(int)) chunkResult {
	paths := make([]string, len(ch.files))
	index := make(map[string]int, len(ch.files))
	for i, f := range ch.files {
		paths[i] = f.Path
		index[f.Path] = i
	}
	cmd := exec.CommandContext(ctx, bin, append(append(slices.Clip(args), "--"), paths...)...)
	cmd.Dir = ch.dir
	cmd.Env = append(os.Environ(), "RIPGREP_CONFIG_PATH=") // a user's rg config must not change what runs
	cmd.WaitDelay = waitDelay
	stderr := &capped{max: maxStderr}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return chunkResult{err: fmt.Errorf("ripgrep: %w", err)}
	}
	if err := cmd.Start(); err != nil {
		return chunkResult{err: fmt.Errorf("ripgrep: %w", err)}
	}
	if pids != nil {
		pids(cmd.Process.Pid)
	}
	p := &parser{ch: ch, index: index, limits: limits, open: map[string]*fileState{}}
	readErr := p.read(stdout)
	if readErr != nil {
		_ = cmd.Process.Kill()
	}
	waitErr := cmd.Wait()
	res := chunkResult{files: p.result()}
	switch {
	case ctx.Err() != nil:
		res.err = ctx.Err()
	case readErr != nil:
		res.err = fmt.Errorf("ripgrep output: %w", readErr)
	case waitErr != nil:
		var exit *exec.ExitError
		if !errors.As(waitErr, &exit) {
			res.err = fmt.Errorf("ripgrep: %w", waitErr)
			break
		}
		// 1 is "no match". 2 is "an error happened", here a file that went away or could
		// not be read since it was listed: the search goes on without it.
		if code := exit.ExitCode(); code != 1 && code != 2 {
			res.err = fmt.Errorf("ripgrep exited %d: %s", code, stderr.String())
		}
	}
	return res
}

// parser reads one ripgrep's JSON output.
type parser struct {
	ch     chunk
	index  map[string]int
	limits Limits
	// open are the files begun and not ended, by path; current is the one begun last
	// (ripgrep writes each file's messages together).
	open    map[string]*fileState
	current *fileState
	// done are the finished files kept, rows their lines.
	done []*fileState
	rows int
	buf  []byte
}

func (p *parser) read(r io.Reader) error {
	br := bufio.NewReaderSize(r, readBuffer)
	for {
		frag, err := br.ReadSlice('\n')
		switch {
		case err == nil:
			if len(p.buf) == 0 {
				p.message(frag)
			} else {
				p.buf = append(p.buf, frag...)
				p.message(p.buf)
				p.buf = p.buf[:0]
			}
		case errors.Is(err, bufio.ErrBufferFull):
			if len(p.buf) == 0 && p.skippable(frag) || len(p.buf)+len(frag) > maxMessage {
				p.buf = p.buf[:0]
				if err := discardLine(br); err != nil {
					return eof(err)
				}
				continue
			}
			p.buf = append(p.buf, frag...)
		default:
			if len(frag) > 0 || len(p.buf) > 0 {
				p.message(append(p.buf, frag...))
				p.buf = p.buf[:0]
			}
			return eof(err)
		}
	}
}

// eof is nil for the end of the output.
func eof(err error) error {
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// discardLine reads up to and including the next '\n'.
func discardLine(br *bufio.Reader) error {
	for {
		_, err := br.ReadSlice('\n')
		if !errors.Is(err, bufio.ErrBufferFull) {
			return err
		}
	}
}

// skippable: a match message for the current file, which already has every line it can
// send. Its count comes from the file's end message, so it need not be decoded.
func (p *parser) skippable(msg []byte) bool {
	return p.current != nil && len(p.current.file.Lines) >= p.limits.FileLines && bytes.HasPrefix(msg, matchPrefix)
}

func (p *parser) message(msg []byte) {
	if p.skippable(msg) {
		return
	}
	var m rgMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		return
	}
	path := string(m.Data.Path.raw())
	switch m.Type {
	case "begin":
		i, ok := p.index[path]
		if !ok { // not a file of the list (never expected: --max-depth 0 keeps ripgrep to them)
			p.current = nil
			return
		}
		f := p.ch.files[i]
		st := &fileState{order: p.ch.first + i, file: File{Source: p.ch.source, Path: f.Path, Ignored: f.Ignored}}
		p.open[path], p.current = st, st
	case "match":
		st := p.open[path]
		if st == nil || len(st.file.Lines) >= p.limits.FileLines {
			return
		}
		st.file.Lines = append(st.file.Lines, makeLine(m.Data.LineNumber, m.Data.Lines.raw(), m.Data.Submatches, p.limits.LineChars))
	case "end":
		st := p.open[path]
		if st == nil {
			return
		}
		delete(p.open, path)
		if p.current == st {
			p.current = nil
		}
		// A binary file (a NUL byte): ripgrep searches a file named on its command line
		// anyway; text search leaves it out, as ripgrep does with the files it walks.
		if m.Data.BinaryOffset != nil || len(st.file.Lines) == 0 {
			return
		}
		if m.Data.Stats != nil {
			st.matched = m.Data.Stats.MatchedLines
		}
		st.matched = max(st.matched, len(st.file.Lines))
		st.file.LineCount = min(st.matched, p.limits.CountLines)
		st.file.LineCountCapped = st.matched > p.limits.CountLines
		p.keep(st)
	}
}

// keep adds a finished file, then drops the files latest in order while the rest still
// hold TotalLines rows: the search sends files in order and stops at TotalLines, so those
// could never be sent, and a chunk's memory stays bounded.
func (p *parser) keep(st *fileState) {
	p.done = append(p.done, st)
	p.rows += len(st.file.Lines)
	for p.rows > p.limits.TotalLines && len(p.done) > 1 {
		last := 0
		for i, d := range p.done {
			if d.order > p.done[last].order {
				last = i
			}
		}
		n := len(p.done[last].file.Lines)
		if p.rows-n < p.limits.TotalLines {
			return
		}
		p.rows -= n
		p.done = slices.Delete(p.done, last, last+1)
	}
}

// result is the kept files in search order.
func (p *parser) result() []File {
	slices.SortFunc(p.done, func(a, b *fileState) int { return cmp.Compare(a.order, b.order) })
	out := make([]File, len(p.done))
	for i, d := range p.done {
		out[i] = d.file
	}
	return out
}

// capped keeps the first max bytes written to it.
type capped struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room := c.max - len(c.b); room > 0 {
		c.b = append(c.b, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

func (c *capped) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.b)
}

// rgArgs are ripgrep's arguments for q, before "--" and the paths.
func rgArgs(q Query, limits Limits) []string {
	args := []string{
		"--json",
		"--no-config",
		// Only the paths given: a listed symlink to a folder is not walked.
		"--max-depth", "0",
		// One more than counted, to know a file has more.
		"--max-count", strconv.Itoa(limits.CountLines + 1),
	}
	if q.CaseSensitive() {
		args = append(args, "--case-sensitive")
	} else {
		args = append(args, "--ignore-case")
	}
	if !q.Regex {
		args = append(args, "--fixed-strings")
	}
	if q.WholeWord {
		args = append(args, "--word-regexp")
	}
	// One argument, so a query starting with "-" is never read as a flag.
	return append(args, "--regexp="+q.Text)
}
