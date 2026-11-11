// Package shot brokers screenshots of plugin surfaces between whoever asks
// (PluginService.ShotSurface: the CLI's plugin surface --shot) and the app's host, which
// draws them (docs/notes/plugin-surface-shot-daemon.md). The host holds one capturer
// stream (UiService.WatchShots) and answers each request by its id (UiService.PublishShot);
// the broker numbers requests, waits for the answer with a timeout and caps its size. It
// owns no process and imports no store: with no capturer, a shot fails at once.
package shot

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The viewport's bounds and default, in CSS pixels (plugin surface --width, --height).
const (
	DefaultWidth  = 420
	DefaultHeight = 900
	MinWidth      = 280
	MaxWidth      = 1600
	MinHeight     = 200
	MaxHeight     = 4000
)

// DefaultTimeout is how long a shot waits for the app's answer: drawing a surface in a
// hidden window and snapshotting it takes well under a second once the view is there.
const DefaultTimeout = 15 * time.Second

// MaxPNG caps a published PNG: a 1600 by 4000 viewport at 2x is 12.8 M pixels, a few MiB
// as PNG even when busy.
const MaxPNG = 32 << 20

// queueLen is the capturer's backlog. A shot past it fails rather than waiting.
const queueLen = 8

// Errors a shot or a publish ends in.
var (
	ErrNoCapturer = errors.New("the app is not open (code-foundry gui)")
	ErrTimeout    = errors.New("the app did not answer in time")
	ErrGone       = errors.New("the app closed before it answered")
	ErrBusy       = errors.New("the app has too many screenshots to take; try again")
	ErrUnknownID  = errors.New("no screenshot is waiting on this id (it timed out or was never asked)")
	ErrTooLarge   = fmt.Errorf("the PNG is over %d MiB", MaxPNG>>20)
	ErrNotPNG     = errors.New("the bytes are not a PNG")
	ErrEmpty      = errors.New("an answer needs a PNG or an error")
)

// CaptureError is the app's own reason it could not draw a shot.
type CaptureError struct{ Reason string }

func (e *CaptureError) Error() string { return e.Reason }

// Result is a shot as the app drew it.
type Result struct {
	PNG []byte
	// ContentHeight is the view's content height in CSS pixels.
	ContentHeight int
}

// pngMagic starts every PNG.
var pngMagic = []byte("\x89PNG\r\n\x1a\n")

type capturer struct {
	reqs chan *v1.ShotRequest
	// gone closes when the capturer disconnects or is replaced.
	gone chan struct{}
}

type waiter struct {
	by  *capturer
	res chan answer
}

type answer struct {
	res Result
	err error
}

// Broker hands shot requests to the one capturer and their answers back. The zero value
// is not usable; use New.
type Broker struct {
	timeout time.Duration
	maxPNG  int

	mu      sync.Mutex
	cap     *capturer
	waiting map[string]*waiter
}

// Option configures a Broker.
type Option func(*Broker)

// WithTimeout sets how long Shoot waits for the answer (tests).
func WithTimeout(d time.Duration) Option { return func(b *Broker) { b.timeout = d } }

// WithMaxPNG sets the size cap on a PNG (tests).
func WithMaxPNG(n int) Option { return func(b *Broker) { b.maxPNG = n } }

// New returns a broker with no capturer.
func New(opts ...Option) *Broker {
	b := &Broker{timeout: DefaultTimeout, maxPNG: MaxPNG, waiting: map[string]*waiter{}}
	for _, o := range opts {
		o(b)
	}
	return b
}

// Connect makes the caller the capturer, replacing (and ending) any before it: reqs
// carries the requests to draw, gone closes when another capturer replaces this one, and
// disconnect, which the caller must call when it stops, fails the requests it still owes.
func (b *Broker) Connect() (reqs <-chan *v1.ShotRequest, gone <-chan struct{}, disconnect func()) {
	c := &capturer{reqs: make(chan *v1.ShotRequest, queueLen), gone: make(chan struct{})}
	b.mu.Lock()
	if b.cap != nil {
		close(b.cap.gone)
	}
	b.cap = c
	b.mu.Unlock()
	var once sync.Once
	return c.reqs, c.gone, func() {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			if b.cap == c {
				b.cap = nil
				close(c.gone)
			}
		})
	}
}

// Connected reports whether a capturer is connected.
func (b *Broker) Connected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.cap != nil
}

// Shoot asks the capturer for req (its id is set here) and waits for the answer: the PNG,
// the app's *CaptureError, ErrNoCapturer, ErrBusy, ErrTimeout, ErrGone, or ctx's error.
func (b *Broker) Shoot(ctx context.Context, req *v1.ShotRequest) (Result, error) {
	id, err := newID()
	if err != nil {
		return Result{}, err
	}
	req.Id = id
	w := &waiter{res: make(chan answer, 1)}
	b.mu.Lock()
	if b.cap == nil {
		b.mu.Unlock()
		return Result{}, ErrNoCapturer
	}
	w.by = b.cap
	select {
	case b.cap.reqs <- req:
	default:
		b.mu.Unlock()
		return Result{}, ErrBusy
	}
	b.waiting[id] = w
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.waiting, id)
		b.mu.Unlock()
	}()

	t := time.NewTimer(b.timeout)
	defer t.Stop()
	select {
	case a := <-w.res:
		return a.res, a.err
	case <-w.by.gone:
		// An answer that raced the disconnect still counts.
		select {
		case a := <-w.res:
			return a.res, a.err
		default:
			return Result{}, ErrGone
		}
	case <-t.C:
		return Result{}, ErrTimeout
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

// Publish answers the request id with a PNG or the app's reason it has none. An oversize
// or invalid PNG fails both the publish and the shot waiting on it.
func (b *Broker) Publish(id string, png []byte, reason string, contentHeight int) error {
	b.mu.Lock()
	w, ok := b.waiting[id]
	if ok {
		delete(b.waiting, id)
	}
	b.mu.Unlock()
	if !ok {
		return ErrUnknownID
	}
	if reason != "" {
		w.res <- answer{err: &CaptureError{Reason: reason}}
		return nil
	}
	var a answer
	switch {
	case len(png) == 0:
		a.err = ErrEmpty
	case len(png) > b.maxPNG:
		a.err = ErrTooLarge
	case !bytes.HasPrefix(png, pngMagic):
		a.err = ErrNotPNG
	default:
		a.res = Result{PNG: png, ContentHeight: max(contentHeight, 0)}
	}
	w.res <- a
	return a.err
}

func newID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("shot id: %w", err)
	}
	return "shot-" + hex.EncodeToString(buf[:]), nil
}
