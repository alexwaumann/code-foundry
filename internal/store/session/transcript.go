package session

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/fsnotify/fsnotify"
)

// Transcript discovery and tailing.
//
// Claude writes a session's transcript to <claude dir>/projects/<slug>/<session
// id>.jsonl (slug: see projectSlug). The file only appears with the first message, so
// it is often created well after spawn. The session store chooses the Claude session
// id itself (--session-id, or the id passed to --resume), so discovery waits for one
// known file instead of guessing among the newest files in a directory shared with
// other sessions in the same worktree. /clear makes Claude switch to a new session id
// and file; that rotation is followed through Claude's per-process record
// sessions/<pid>.json (see pidSessionID).

const (
	tailReadChunk = 64 << 10
	maxLineBytes  = 8 << 20 // longer lines (huge attachments) are skipped
)

// tailer follows one Claude session's transcript file. Not safe for concurrent use;
// the runner goroutine owns it.
type tailer struct {
	paths ClaudePaths
	cwd   string

	id      string // Claude session id being followed
	fromEnd bool   // skip content that existed when the file was first opened
	path    string
	f       *os.File
	off     int64
	partial []byte
	skip    bool // discarding the rest of an over-long line

	w       *fsnotify.Watcher // nil if fsnotify is unavailable; polling still works
	watched map[string]bool
}

func newTailer(paths ClaudePaths, cwd string) *tailer {
	t := &tailer{paths: paths, cwd: cwd, watched: map[string]bool{}}
	if w, err := fsnotify.NewWatcher(); err == nil {
		t.w = w
	}
	return t
}

// events is the fsnotify channel (nil when unavailable). Any event means "poll".
func (t *tailer) events() <-chan fsnotify.Event {
	if t.w == nil {
		return nil
	}
	return t.w.Events
}

func (t *tailer) errors() <-chan error {
	if t.w == nil {
		return nil
	}
	return t.w.Errors
}

// follow switches to Claude session id. fromEnd skips what is already in the file
// (resume: the history is not news).
func (t *tailer) follow(id string, fromEnd bool) {
	if id == t.id {
		return
	}
	t.closeFile()
	t.id, t.fromEnd = id, fromEnd
	t.path, t.off, t.partial, t.skip = "", 0, nil, false
}

func (t *tailer) closeFile() {
	if t.f != nil {
		_ = t.f.Close()
		t.f = nil
	}
}

func (t *tailer) close() {
	t.closeFile()
	if t.w != nil {
		_ = t.w.Close()
	}
}

// poll opens the transcript if it has appeared and returns complete new lines.
// discovered is true on the call that first finds the file for the current id.
func (t *tailer) poll() (lines [][]byte, discovered bool) {
	if t.id == "" {
		return nil, false
	}
	t.ensureWatches()
	if t.f == nil {
		p, ok := t.paths.transcriptPath(t.cwd, t.id)
		if !ok {
			return nil, false
		}
		f, err := os.Open(p)
		if err != nil {
			return nil, false
		}
		t.f, t.path, discovered = f, p, true
		if t.fromEnd {
			if fi, err := f.Stat(); err == nil {
				t.off = fi.Size()
			}
		}
		t.watch(filepath.Dir(p))
	}
	if fi, err := t.f.Stat(); err == nil && fi.Size() < t.off {
		t.off, t.partial, t.skip = 0, nil, false // truncated or replaced
	}
	buf := make([]byte, tailReadChunk)
	for {
		n, err := t.f.ReadAt(buf, t.off)
		if n > 0 {
			t.off += int64(n)
			lines = t.split(lines, buf[:n])
		}
		if err != nil || n < len(buf) {
			if err != nil && !errors.Is(err, io.EOF) {
				t.closeFile() // reopen on the next poll
			}
			return lines, discovered
		}
	}
}

func (t *tailer) split(lines [][]byte, data []byte) [][]byte {
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			if !t.skip {
				t.partial = append(t.partial, data...)
				if len(t.partial) > maxLineBytes {
					t.partial, t.skip = nil, true
				}
			}
			return lines
		}
		if t.skip {
			t.skip = false
		} else {
			line := append(t.partial, data[:i]...)
			t.partial = nil
			if len(line) > 0 {
				lines = append(lines, line)
			}
		}
		data = data[i+1:]
	}
	return lines
}

// ensureWatches watches the project dir, or the projects root until the project dir
// exists, so the file's creation is noticed without waiting for the next tick.
func (t *tailer) ensureWatches() {
	if t.w == nil {
		return
	}
	dir := t.paths.projectDir(t.cwd)
	if t.watched[dir] {
		return
	}
	if _, err := os.Stat(dir); err == nil {
		t.watch(dir)
		return
	}
	t.watch(filepath.Join(t.paths.Dir, "projects"))
}

func (t *tailer) watch(dir string) {
	if t.w == nil || t.watched[dir] {
		return
	}
	if err := t.w.Add(dir); err == nil {
		t.watched[dir] = true
	}
}

// pidSessionID reads the current Claude session id of process pid from Claude's
// per-process record (sessions/<pid>.json). Empty if unavailable.
func pidSessionID(paths ClaudePaths, pid int) string {
	data, err := os.ReadFile(paths.pidFile(pid))
	if err != nil {
		return ""
	}
	var rec struct {
		PID       int    `json:"pid"`
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(data, &rec) != nil || rec.PID != pid {
		return ""
	}
	return rec.SessionID
}

// fileExists reports whether p exists.
func fileExists(p string) bool {
	_, err := os.Stat(p)
	return !errors.Is(err, fs.ErrNotExist) && err == nil
}
