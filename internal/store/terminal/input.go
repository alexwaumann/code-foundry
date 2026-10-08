package terminal

import (
	"io"
	"sync"
)

// maxInputBacklog bounds user input queued for a PTY whose program is not reading.
const maxInputBacklog = 1 << 20

// inputQueue serializes writes to the PTY master on its own goroutine, so neither API
// callers nor the actor (which queues emulator query replies from inside VTWrite) ever
// block on a program that is not reading its input. Order is preserved across both.
type inputQueue struct {
	mu      sync.Mutex
	q       [][]byte
	pending int
	closed  bool
	wake    chan struct{}
}

func newInputQueue() *inputQueue {
	return &inputQueue{wake: make(chan struct{}, 1)}
}

// push queues a copy of data. If bounded is true and the backlog would exceed
// maxInputBacklog, it returns ErrInputBacklog. Emulator replies are pushed unbounded:
// they are tiny and dropping them would confuse the program.
func (iq *inputQueue) push(data []byte, bounded bool) error {
	if len(data) == 0 {
		return nil
	}
	iq.mu.Lock()
	defer iq.mu.Unlock()
	if iq.closed {
		return ErrExited
	}
	if bounded && iq.pending+len(data) > maxInputBacklog {
		return ErrInputBacklog
	}
	iq.q = append(iq.q, append([]byte(nil), data...))
	iq.pending += len(data)
	select {
	case iq.wake <- struct{}{}:
	default:
	}
	return nil
}

// close stops accepting input and wakes the writer so it exits.
func (iq *inputQueue) close() {
	iq.mu.Lock()
	iq.closed = true
	iq.q = nil
	iq.pending = 0
	iq.mu.Unlock()
	select {
	case iq.wake <- struct{}{}:
	default:
	}
}

// run writes queued input to w until close is called or a write fails.
func (iq *inputQueue) run(w io.Writer) {
	for range iq.wake {
		iq.mu.Lock()
		batch, closed := iq.q, iq.closed
		iq.q = nil
		iq.mu.Unlock()
		if closed {
			return
		}
		for _, b := range batch {
			_, err := w.Write(b)
			iq.mu.Lock()
			if !iq.closed {
				iq.pending -= len(b)
			}
			iq.mu.Unlock()
			if err != nil {
				iq.close()
				return
			}
		}
	}
}
