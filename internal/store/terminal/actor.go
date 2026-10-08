package terminal

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sync/atomic"
	"syscall"
	"time"

	ghostty "go.mitchellh.com/libghostty"

	"github.com/awaumann/code-foundry/internal/bus"
)

const (
	// readBufSize is the PTY read buffer. The actor further coalesces reads that queue
	// up while it is busy into chunks of up to maxChunk bytes.
	readBufSize = 32 << 10
	maxChunk    = 64 << 10
	// exitDrainGrace is how long to keep reading after the process exits, for output
	// still buffered in the PTY or held open by a background child.
	exitDrainGrace = 150 * time.Millisecond
	// exitHardTimeout bounds waiting for the reader after the master is closed.
	exitHardTimeout = time.Second
	// compressStep spaces incremental compression steps while a terminal stays idle.
	compressStep = 10 * time.Millisecond
)

// actor owns one terminal. Everything below the "actor goroutine only" line is touched
// exclusively by run and the closures it executes, including every libghostty call.
type actor struct {
	id     string
	cmd    *exec.Cmd
	master *os.File
	input  *inputQueue
	bus    *bus.Bus
	log    *slog.Logger
	opts   Options
	drops  *atomic.Uint64

	info atomic.Pointer[Terminal] // latest published metadata, read by Get/List
	reqs chan func()
	done chan struct{} // closed when run returns

	// ---- actor goroutine only ----
	vt         *ghostty.Terminal
	cur        Terminal
	subs       map[chan AttachEvent]struct{}
	readCh     chan []byte
	waitCh     chan *os.ProcessState
	procState  *os.ProcessState
	procExited bool
	readerDone bool
	exited     bool
	quit       bool
	titleDirty bool
	th         throttle
	pubTimer   *time.Timer
	pubC       <-chan time.Time
	graceC     <-chan time.Time
	hardC      <-chan time.Time
	killTimer  *time.Timer
	killC      <-chan time.Time
	compress   *time.Timer // idle scrollback compression; see onIdle
}

func newActor(id string, cmd *exec.Cmd, master *os.File, initial Terminal, b *bus.Bus, log *slog.Logger, opts Options, drops *atomic.Uint64) *actor {
	a := &actor{
		id:     id,
		cmd:    cmd,
		master: master,
		input:  newInputQueue(),
		bus:    b,
		log:    log,
		opts:   opts,
		drops:  drops,
		reqs:   make(chan func()),
		done:   make(chan struct{}),
		cur:    initial,
		subs:   make(map[chan AttachEvent]struct{}),
		readCh: make(chan []byte, 8),
		waitCh: make(chan *os.ProcessState, 1),
		th:     throttle{interval: opts.MetadataInterval},
	}
	info := initial
	a.info.Store(&info)
	return a
}

// run is the actor goroutine. It reports emulator setup failure on ready and returns.
func (a *actor) run(ready chan<- error) {
	defer close(a.done)
	sb := scrollbackLimits{lines: a.opts.MaxScrollbackLines, bytes: a.opts.MaxScrollbackBytes}
	vt, err := newVT(a.cur.Cols, a.cur.Rows, sb, vtHooks{
		writePty:     func(b []byte) { _ = a.input.push(b, false) },
		titleChanged: func() { a.titleDirty = true },
		size:         func() (uint16, uint16) { return a.cur.Cols, a.cur.Rows },
	})
	if err != nil {
		ready <- err
		return
	}
	a.vt = vt
	defer a.vt.Close()
	a.compress = time.NewTimer(a.opts.CompressAfter)
	defer a.compress.Stop()
	ready <- nil

	go a.input.run(a.master)
	go a.readLoop()
	go func() {
		_ = a.cmd.Wait()
		a.waitCh <- a.cmd.ProcessState
	}()

	for !a.quit {
		select {
		case chunk, ok := <-a.readCh:
			if !ok {
				a.onReaderDone()
				continue
			}
			a.onOutput(chunk)
		case fn := <-a.reqs:
			fn()
		case ps := <-a.waitCh:
			a.onProcessExit(ps)
		case <-a.graceC:
			a.graceC = nil
			_ = a.master.Close() // unblocks the reader; it then closes readCh
			a.hardC = time.After(exitHardTimeout)
		case <-a.hardC:
			a.hardC = nil
			a.log.Warn("pty reader did not stop after close; finishing anyway")
			a.finish()
		case <-a.killC:
			a.killC = nil
			if !a.exited {
				a.log.Info("process ignored SIGHUP, sending SIGKILL", "pid", a.cur.Pid)
				if err := signalGroup(a.cur.Pid, syscall.SIGKILL); err != nil {
					a.log.Warn("SIGKILL failed", "err", err)
				}
			}
		case now := <-a.pubC:
			a.pubC = nil
			a.th.fired(now)
			a.publish()
		case <-a.compress.C:
			a.onIdle()
		}
	}
}

// touch records activity that may have grown or decompressed scrollback, postponing
// compression until the terminal has been idle for CompressAfter.
func (a *actor) touch() { a.compress.Reset(a.opts.CompressAfter) }

// onIdle compresses scrollback one bounded step at a time while the terminal stays
// idle. Compressed pages are decompressed transparently when read. Measured on
// repetitive log output: 10k rows x 120 cols went from 10.2 MiB to 0.5 MiB resident.
func (a *actor) onIdle() {
	res, err := a.vt.Compress(ghostty.TerminalCompressionIncremental)
	if err != nil {
		a.log.Debug("compress scrollback", "err", err)
		return
	}
	if res == ghostty.TerminalCompressionPending {
		a.compress.Reset(compressStep)
	}
}

// readLoop copies PTY output to readCh until the master errors (EIO once the slave side
// is fully closed, or ErrClosed after Close).
func (a *actor) readLoop() {
	buf := make([]byte, readBufSize)
	for {
		n, err := a.master.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			select {
			case a.readCh <- chunk:
			case <-a.done:
				return
			}
		}
		if err != nil {
			close(a.readCh)
			return
		}
	}
}

// call runs fn on the actor goroutine and waits for it.
func (a *actor) call(ctx context.Context, fn func()) error {
	finished := make(chan struct{})
	select {
	case a.reqs <- func() { fn(); close(finished) }:
	case <-a.done:
		return ErrNotFound
	case <-ctx.Done():
		return ctx.Err()
	}
	<-finished
	return nil
}

func (a *actor) onOutput(data []byte) {
	// Coalesce whatever else the reader already queued, so fast producers become few
	// large events for subscribers instead of many small ones.
coalesce:
	for len(data) < maxChunk {
		select {
		case more, ok := <-a.readCh:
			if !ok {
				a.feed(data)
				a.onReaderDone()
				return
			}
			data = append(data, more...)
		default:
			break coalesce
		}
	}
	a.feed(data)
}

func (a *actor) feed(data []byte) {
	a.touch()
	a.vt.VTWrite(data)
	a.broadcast(AttachEvent{Output: data})
	a.checkMetadata()
}

// checkMetadata detects title and alt-screen changes after a write and schedules a
// throttled publish.
func (a *actor) checkMetadata() {
	changed := false
	if scr, err := a.vt.ActiveScreen(); err == nil {
		if alt := scr == ghostty.ScreenAlternate; alt != a.cur.AltScreen {
			a.cur.AltScreen = alt
			changed = true
		}
	}
	if a.titleDirty {
		a.titleDirty = false
		if title, err := a.vt.Title(); err == nil && title != a.cur.Title {
			a.cur.Title = title
			changed = true
		}
	}
	if !changed {
		return
	}
	now, wait := a.th.next(time.Now())
	switch {
	case now:
		a.publish()
	case a.pubC == nil:
		a.pubTimer = time.NewTimer(wait)
		a.pubC = a.pubTimer.C
	}
}

// publish stores the current metadata and announces it on the bus. Any pending
// throttled publish is folded into this one.
func (a *actor) publish() {
	if a.pubTimer != nil {
		a.pubTimer.Stop()
		a.pubTimer, a.pubC = nil, nil
	}
	info := a.cur
	a.info.Store(&info)
	bus.Publish(a.bus, TerminalUpdated{Terminal: info})
}

// broadcast fans ev out without blocking. A subscriber whose buffer is nearly full is
// sent Dropped (the last slot is reserved for it) and disconnected.
func (a *actor) broadcast(ev AttachEvent) {
	for ch := range a.subs {
		if len(ch) >= cap(ch)-1 {
			ch <- AttachEvent{Dropped: true}
			close(ch)
			delete(a.subs, ch)
			a.drops.Add(1)
			a.log.Warn("dropped slow attach subscriber")
			continue
		}
		ch <- ev
	}
}

func (a *actor) onProcessExit(ps *os.ProcessState) {
	a.waitCh = nil
	a.procExited = true
	a.procState = ps
	if a.readerDone {
		a.finish()
		return
	}
	a.graceC = time.After(exitDrainGrace)
}

func (a *actor) onReaderDone() {
	a.readCh = nil
	a.readerDone = true
	if a.procExited {
		a.finish()
	}
}

// finish marks the terminal exited once the process is gone and output is drained.
func (a *actor) finish() {
	if a.exited {
		return
	}
	a.exited = true
	a.graceC, a.hardC = nil, nil
	if a.killTimer != nil {
		a.killTimer.Stop()
		a.killTimer, a.killC = nil, nil
	}
	a.input.close()
	_ = a.master.Close()

	code := exitCode(a.procState)
	a.cur.State = StateExited
	a.cur.ExitCode = code
	a.cur.ExitedAt = a.opts.Now()
	a.broadcast(AttachEvent{Exited: &Exit{Code: code}})
	a.publish()
	a.log.Info("terminal exited", "code", code)
}

// ---- requests (run on the actor goroutine via call) ----

func (a *actor) attach() (chan AttachEvent, error) {
	a.touch()
	snap, err := buildSnapshot(a.vt)
	if err != nil {
		return nil, fmt.Errorf("snapshot %s: %w", a.id, err)
	}
	ch := make(chan AttachEvent, a.opts.SubscriberBuffer)
	ch <- AttachEvent{Snapshot: &Snapshot{Data: snap, Cols: a.cur.Cols, Rows: a.cur.Rows, AltScreen: a.cur.AltScreen}}
	if a.exited {
		ch <- AttachEvent{Exited: &Exit{Code: a.cur.ExitCode}}
	}
	a.subs[ch] = struct{}{}
	return ch, nil
}

func (a *actor) detach(ch chan AttachEvent) {
	if _, ok := a.subs[ch]; ok {
		delete(a.subs, ch)
		close(ch)
	}
}

func (a *actor) resize(cols, rows uint16) error {
	if !a.exited {
		if err := setWinsize(a.master, cols, rows); err != nil {
			return err
		}
	}
	a.touch()
	if err := a.vt.Resize(cols, rows, 0, 0); err != nil {
		return fmt.Errorf("resize vt: %w", err)
	}
	if cols == a.cur.Cols && rows == a.cur.Rows {
		return nil
	}
	a.cur.Cols, a.cur.Rows = cols, rows
	a.broadcast(AttachEvent{Resized: &Size{Cols: cols, Rows: rows}})
	a.publish()
	return nil
}

func (a *actor) kill(grace time.Duration) error {
	if a.exited {
		return nil
	}
	if err := signalGroup(a.cur.Pid, syscall.SIGHUP); err != nil {
		return fmt.Errorf("SIGHUP %d: %w", a.cur.Pid, err)
	}
	if a.killTimer == nil {
		a.killTimer = time.NewTimer(grace)
		a.killC = a.killTimer.C
	}
	return nil
}

// remove stops the actor. Only exited terminals can be removed, unless force is set
// (store shutdown), in which case the process group is hung up first.
func (a *actor) remove(force bool) error {
	if !a.exited {
		if !force {
			return ErrRunning
		}
		_ = signalGroup(a.cur.Pid, syscall.SIGHUP)
		a.input.close()
		_ = a.master.Close()
	}
	if a.killTimer != nil {
		a.killTimer.Stop()
	}
	if a.pubTimer != nil {
		a.pubTimer.Stop()
	}
	for ch := range a.subs {
		close(ch)
	}
	a.subs = nil
	a.quit = true
	return nil
}
