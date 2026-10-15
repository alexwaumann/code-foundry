package action

import (
	"strings"
	"sync"
)

// tailBuffer keeps the last limit bytes written to it. A background run's stdout and
// stderr both write here (exec copies each pipe on its own goroutine).
type tailBuffer struct {
	mu    sync.Mutex
	limit int
	buf   []byte
	total int64
}

func newTailBuffer(limit int) *tailBuffer { return &tailBuffer{limit: limit} }

// Write implements io.Writer. It never fails.
func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.total += int64(len(p))
	if len(p) >= t.limit {
		t.buf = append(t.buf[:0], p[len(p)-t.limit:]...)
		return len(p), nil
	}
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.limit; over > 0 {
		n := copy(t.buf, t.buf[over:])
		t.buf = t.buf[:n]
	}
	return len(p), nil
}

// text returns what is kept as valid UTF-8 (a cut rune or binary output becomes
// U+FFFD) and whether earlier output was dropped.
func (t *tailBuffer) text() (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.ToValidUTF8(string(t.buf), "�"), t.total > int64(len(t.buf))
}
