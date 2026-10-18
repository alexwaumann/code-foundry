package plugin

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Defaults for a plugin's log.
const (
	// DefaultLogMaxBytes is the log file's size before it rotates to <name>.log.1.
	DefaultLogMaxBytes = 1 << 20
	// DefaultLogTail is how many lines are kept in memory for Logs and FollowLogs.
	DefaultLogTail = 1000
	// maxLogLine bounds one line (longer ones are cut).
	maxLogLine = 8 << 10
)

// logBuffer is a plugin's log: a file with one rotation and an in-memory tail with
// sequence numbers that followers subscribe to. It lives as long as the plugin is
// known, across restarts.
type logBuffer struct {
	path     string
	maxBytes int64
	tailCap  int
	now      func() time.Time

	mu    sync.Mutex
	file  *os.File
	size  int64
	lines []LogLine
	seq   uint64
	subs  map[chan LogLine]struct{}
}

func newLogBuffer(path string, maxBytes int64, tailCap int, now func() time.Time) *logBuffer {
	return &logBuffer{path: path, maxBytes: maxBytes, tailCap: tailCap, now: now, subs: map[chan LogLine]struct{}{}}
}

// add records one line. Errors writing the file are dropped (the tail still has it).
func (b *logBuffer) add(source, level, text string) {
	text = strings.TrimRight(text, "\r\n")
	if len(text) > maxLogLine {
		text = text[:maxLogLine] + "…"
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	l := LogLine{Seq: b.seq, Time: b.now(), Source: source, Level: level, Text: text}
	b.lines = append(b.lines, l)
	if over := len(b.lines) - b.tailCap; over > 0 {
		b.lines = append(b.lines[:0], b.lines[over:]...)
	}
	b.write(l)
	for ch := range b.subs {
		select {
		case ch <- l:
		default: // a slow follower misses lines; it sees the gap in Seq
		}
	}
}

// formatLine is the file's line format.
func formatLine(l LogLine) string {
	tag := l.Source
	if l.Level != "" {
		tag += " " + l.Level
	}
	return fmt.Sprintf("%s %s %s\n", l.Time.UTC().Format("2006-01-02T15:04:05.000Z"), tag, l.Text)
}

// write appends l to the file, rotating first when it would pass maxBytes. b.mu held.
func (b *logBuffer) write(l LogLine) {
	s := formatLine(l)
	if b.file == nil {
		if err := os.MkdirAll(filepath.Dir(b.path), 0o700); err != nil {
			return
		}
		f, err := os.OpenFile(b.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return
		}
		b.file = f
		if fi, err := f.Stat(); err == nil {
			b.size = fi.Size()
		}
	}
	if b.size > 0 && b.size+int64(len(s)) > b.maxBytes {
		_ = b.file.Close()
		b.file = nil
		_ = os.Rename(b.path, b.path+".1")
		f, err := os.OpenFile(b.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return
		}
		b.file, b.size = f, 0
	}
	n, _ := b.file.WriteString(s)
	b.size += int64(n)
}

// tail returns the last n lines (all kept when n <= 0).
func (b *logBuffer) tail(n int) []LogLine {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.tailLocked(n)
}

func (b *logBuffer) tailLocked(n int) []LogLine {
	if n <= 0 || n > len(b.lines) {
		n = len(b.lines)
	}
	return append([]LogLine(nil), b.lines[len(b.lines)-n:]...)
}

// subscribe returns the last n lines and a channel of the lines after them. cancel
// stops the subscription and closes the channel.
func (b *logBuffer) subscribe(n int) ([]LogLine, <-chan LogLine, func()) {
	ch := make(chan LogLine, 256)
	b.mu.Lock()
	tail := b.tailLocked(n)
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	var once sync.Once
	return tail, ch, func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subs, ch)
			close(ch)
			b.mu.Unlock()
		})
	}
}

func (b *logBuffer) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.file != nil {
		_ = b.file.Close()
		b.file = nil
	}
}
