package session

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
)

// Close sequence. Escape interrupts a running turn (and leaves vim INSERT mode).
// Then Ctrl-C twice: the first clears pending input and arms "Press Ctrl-C again to
// exit", the second exits Claude gracefully (code 0). This is Claude's own exit path
// and works in every input mode. Typing "/exit" does not: with editorMode "vim", Escape
// leaves Claude in NORMAL mode, where "/exit" becomes vim motions and the following
// Enter submits whatever is left as a prompt (observed; see the 2a notes). The pair is
// repeated until the process exits or CloseTimeout passes; then the terminal is killed.
const (
	keyEscape = "\x1b"
	keyCtrlC  = "\x03"

	closeAfterEscape = 300 * time.Millisecond
	closeCtrlCGap    = 150 * time.Millisecond
	closeRepeat      = 2 * time.Second
)

// Startup timing. The first prompt is not typed: it is claude's positional argument
// (launch.argv), which Claude submits itself once its UI is up.
const (
	trustKeyGap        = 300 * time.Millisecond // between dialog keystrokes
	maxTrustKeys       = 12
	screenCheckGap     = 100 * time.Millisecond // ScreenText at most this often while STARTING
	activityPersistGap = 30 * time.Second
	screenTextTimeout  = 2 * time.Second
)

// mailbox is an unbounded FIFO of observer events. push never blocks, so the terminal
// actor never waits on a session.
type mailbox struct {
	mu  sync.Mutex
	q   []terminal.ObserveEvent
	sig chan struct{}
}

func (b *mailbox) push(ev terminal.ObserveEvent) {
	b.mu.Lock()
	b.q = append(b.q, ev)
	b.mu.Unlock()
	select {
	case b.sig <- struct{}{}:
	default:
	}
}

func (b *mailbox) drain() []terminal.ObserveEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	q := b.q
	b.q = nil
	return q
}

// runner owns one connected terminal of a session. All fields below are touched only
// by run (the goroutine), except mb (observer side), closeReq, cdReq, stopReq and done.
type runner struct {
	m      *Manager
	id     string
	cwd    string
	launch launch
	mb     mailbox

	closeReq chan struct{}
	cdReq    chan cdRequest // RunIn; capacity 1, latest wins
	stopReq  chan struct{}
	done     chan struct{}

	// ---- run goroutine only (term/det/tail are set by attach before run starts) ----
	term  terminal.Terminal
	det   StatusDetector
	tail  *tailer
	state State

	trustKeys    int
	lastTrustKey time.Time
	lastScreen   time.Time

	// pendingCd is a RunIn move waiting for the prompt; cdSending one typed and
	// waiting for cdTimer to press Enter (runin.go).
	pendingCd *cdRequest
	cdSending cdRequest
	cdTimer   *time.Timer
	// awaitFirstPrompt: spawned with a positional prompt that has not shown up in the
	// transcript (nor made Claude busy) yet. atPromptSince: when AtPrompt last became
	// true; zero while it is false.
	awaitFirstPrompt bool
	atPromptSince    time.Time

	closing    bool
	closeStep  int
	closeTimer *time.Timer
	closeBy    time.Time
	killed     bool

	status, pubStatus Status
	reason, pubReason string
	debounce          *time.Timer

	activity, pubActivity, savedActivity time.Time

	namingSeen bool
	finished   bool

	// viewers is the terminal's Attach subscriber count (from the observer). While
	// someone is attached, whatever Claude produces is seen: see acknowledge.
	viewers int
}

func newRunner(m *Manager, id, cwd string, l launch) *runner {
	return &runner{
		m: m, id: id, cwd: cwd, launch: l,
		mb:       mailbox{sig: make(chan struct{}, 1)},
		closeReq: make(chan struct{}, 1),
		cdReq:    make(chan cdRequest, 1),
		stopReq:  make(chan struct{}, 1),
		done:     make(chan struct{}),
		state:    StateStarting,
	}
}

// observe is the terminal Observer. It runs on the terminal actor and must not block.
func (r *runner) observe(_ string, ev terminal.ObserveEvent) { r.mb.push(ev) }

// attach binds the runner to its terminal. Called once, before run.
func (r *runner) attach(t terminal.Terminal) {
	r.term = t
	terms := r.m.opts.Terminals
	r.det = r.m.opts.NewDetector(func() (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), screenTextTimeout)
		defer cancel()
		return terms.ScreenText(ctx, t.ID)
	})
	r.tail = newTailer(r.m.opts.Paths, r.cwd)
	r.tail.follow(r.launch.claudeID(), r.launch.resume != "" && !r.launch.fork)
	now := r.m.opts.Now()
	r.activity, r.pubActivity, r.savedActivity = now, now, now
}

func (r *runner) requestClose() {
	select {
	case r.closeReq <- struct{}{}:
	default:
	}
}

func (r *runner) stop() {
	select {
	case r.stopReq <- struct{}{}:
	default:
	}
}

func (r *runner) log() *slogger { return &slogger{r} }

func (r *runner) run() {
	defer close(r.done)
	defer r.tail.close()
	opts := r.m.opts
	tick := time.NewTicker(opts.Tick)
	defer tick.Stop()
	startup := time.NewTimer(opts.StartTimeout)
	defer startup.Stop()

	for !r.finished {
		select {
		case <-r.mb.sig:
			for _, ev := range r.mb.drain() {
				r.onEvent(ev)
				if r.finished {
					return
				}
			}
			if r.state == StateStarting {
				r.checkStartup(false)
			}
			r.checkStatus()
			r.tryCd()
		case <-r.tail.events():
			r.pollTranscript()
		case err := <-r.tail.errors():
			r.log().debug("transcript watcher", "err", err)
		case now := <-tick.C:
			r.onTick(now)
		case <-startup.C:
			if r.state == StateStarting {
				r.connect("startup timeout")
			}
		case <-r.closeReq:
			r.beginClose()
		case req := <-r.cdReq:
			r.onCdRequest(req)
		case <-timerC(r.cdTimer):
			r.sendCd()
		case <-timerC(r.closeTimer):
			r.closeNext()
		case <-timerC(r.debounce):
			r.debounce = nil
			r.publishStatus()
		case <-r.stopReq:
			r.finish(func(s *Session) {
				s.State, s.DisconnectReason, s.TerminalID = StateDisconnected, ReasonDaemonStopped, ""
			})
		}
	}
}

// timerC returns t's channel, or nil (blocks forever) for a nil timer.
func timerC(t *time.Timer) <-chan time.Time {
	if t == nil {
		return nil
	}
	return t.C
}

func (r *runner) write(s string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := r.m.opts.Terminals.Write(ctx, r.term.ID, []byte(s)); err != nil && !errors.Is(err, terminal.ErrExited) {
		r.log().warn("write to session terminal", "err", err)
	}
}

func (r *runner) onEvent(ev terminal.ObserveEvent) {
	switch {
	case ev.Output != nil:
		r.activity = r.m.opts.Now()
		r.det.Output(ev.Output)
		r.acknowledgeIfViewed()
	case ev.Attached != nil:
		prev := r.viewers
		r.viewers = *ev.Attached
		if r.viewers > prev {
			r.acknowledge()
		}
	case ev.Input != nil:
		if in, ok := r.det.(interface{ Input([]byte) }); ok {
			in.Input(ev.Input)
		}
	case ev.AltScreen != nil:
		if *ev.AltScreen && r.state == StateStarting && !r.trustVisible() {
			r.connect("alt screen")
		}
	case ev.Title != nil:
		if *ev.Title != "" && r.state == StateStarting && !r.trustVisible() {
			r.connect("title set")
		}
	case ev.Exited != nil:
		r.onExit(ev.Exited.Code)
	}
}

// acknowledge tells the detector that the user has seen everything Claude produced so
// far, which clears "finished" attention (a detector may implement Acknowledge(), as
// internal/claudestatus does). The rule: acknowledge when a viewer attaches to the
// session's terminal, and after every Output chunk and transcript line fed to the
// detector while at least one viewer is attached. Dialog attention is unaffected: it
// lasts until the dialog is gone from the screen.
func (r *runner) acknowledge() {
	if a, ok := r.det.(interface{ Acknowledge() }); ok {
		a.Acknowledge()
	}
}

func (r *runner) acknowledgeIfViewed() {
	if r.viewers > 0 {
		r.acknowledge()
	}
}

// trustVisible reports whether the trust dialog is on screen right now.
func (r *runner) trustVisible() bool {
	screen, err := r.screen()
	return err == nil && parseTrustDialog(screen).Visible
}

func (r *runner) screen() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), screenTextTimeout)
	defer cancel()
	return r.m.opts.Terminals.ScreenText(ctx, r.term.ID)
}

// checkStartup answers the trust dialog if it is on screen (fallback for when the
// pre-written trust did not take). Claude preselects "No, exit": send Down until
// "Yes, I trust this folder" is selected, then Enter.
func (r *runner) checkStartup(force bool) {
	now := time.Now()
	if !force && now.Sub(r.lastScreen) < screenCheckGap {
		return
	}
	r.lastScreen = now
	screen, err := r.screen()
	if err != nil {
		return
	}
	d := parseTrustDialog(screen)
	if !d.Visible || now.Sub(r.lastTrustKey) < trustKeyGap {
		return
	}
	if r.trustKeys >= maxTrustKeys {
		if r.trustKeys == maxTrustKeys {
			r.trustKeys++
			r.m.update(r.id, true, func(rec *record) { rec.s.LastError = "could not accept Claude's folder trust dialog" })
		}
		return
	}
	r.trustKeys++
	r.lastTrustKey = now
	if d.YesSelected {
		r.log().info("accepting folder trust dialog")
		r.write(keyEnter)
	} else {
		r.write(keyDown)
	}
}

// connect moves STARTING -> CONNECTED.
func (r *runner) connect(why string) {
	r.state = StateConnected
	r.m.update(r.id, true, func(rec *record) {
		if rec.s.State == StateStarting {
			rec.s.State = StateConnected
		}
		rec.s.LastActivityAt = r.activity
	})
	r.pubActivity = r.activity
	r.log().info("session connected", "why", why, "after", time.Since(r.term.StartedAt).Round(time.Millisecond).String())
}

func (r *runner) onTick(now time.Time) {
	r.det.Tick(now)
	if r.state == StateStarting {
		r.checkStartup(true)
	}
	// Follow /clear: Claude moves to a new session id and transcript file.
	if id := pidSessionID(r.m.opts.Paths, r.term.Pid); id != "" && id != r.tail.id {
		r.log().info("claude switched session id", "from", r.tail.id, "to", id)
		r.tail.follow(id, false)
	}
	r.pollTranscript()
	r.checkStatus()
	r.tryCd()
	if r.activity.After(r.pubActivity) && now.Sub(r.pubActivity) >= r.m.opts.ActivityPublish {
		persist := now.Sub(r.savedActivity) >= activityPersistGap
		r.pubActivity = r.activity
		if persist {
			r.savedActivity = r.activity
		}
		r.m.update(r.id, persist, func(rec *record) { rec.s.LastActivityAt = r.activity })
	}
}

func (r *runner) pollTranscript() {
	lines, discovered := r.tail.poll()
	if discovered {
		cid := r.tail.id
		r.log().info("transcript discovered", "claude_session_id", cid, "path", r.tail.path)
		r.m.update(r.id, true, func(rec *record) { rec.s.ClaudeSessionID = cid })
		if r.tail.skipped > 0 {
			r.backfillLinks(r.tail.path, r.tail.skipped)
		}
	}
	var links []LinkedPullRequest
	for _, line := range lines {
		r.det.Transcript(line)
		if !r.namingSeen {
			if msg, ok := firstUserText(line); ok {
				r.namingSeen = true
				r.awaitFirstPrompt = false
				r.m.startNaming(r.id, msg)
			}
		}
		if l, ok := parsePRLink(line); ok {
			links = append(links, l)
		}
	}
	if len(links) > 0 {
		r.m.linkPullRequests(r.id, links)
	}
	if len(lines) > 0 {
		// The turn-end record trails the last output chunk by ~120 ms and counts as
		// new work for the detector; a viewer has seen it too.
		r.acknowledgeIfViewed()
		r.checkStatus()
	}
}

// backfillLinks reads the pr-link records in the part of a resumed transcript the
// tailer skipped (the history is not news for status, but its links are: a thread
// reconnected after linking pull requests, or one that linked them before this
// existed). It runs once per discovered file, before any new line, so first-seen
// order holds.
func (r *runner) backfillLinks(path string, limit int64) {
	start := time.Now()
	links, err := scanPRLinks(path, limit)
	if err != nil {
		r.log().warn("backfill linked pull requests", "path", path, "err", err)
	}
	n := r.m.linkPullRequests(r.id, links)
	r.log().debug("backfilled linked pull requests", "records", len(links), "new", n,
		"bytes", limit, "took", time.Since(start).Round(time.Millisecond).String())
}

// checkStatus schedules a debounced publish when the detector's answer changed.
func (r *runner) checkStatus() {
	r.status, r.reason = r.det.Status()
	if (r.status != r.pubStatus || r.reason != r.pubReason) && r.debounce == nil {
		r.debounce = time.NewTimer(r.m.opts.StatusDebounce)
	}
}

func (r *runner) publishStatus() {
	r.status, r.reason = r.det.Status()
	if r.status == r.pubStatus && r.reason == r.pubReason {
		return
	}
	r.pubStatus, r.pubReason, r.pubActivity = r.status, r.reason, r.activity
	r.m.update(r.id, false, func(rec *record) {
		rec.s.Status, rec.s.StatusReason, rec.s.LastActivityAt = r.status, r.reason, r.activity
	})
}

func (r *runner) beginClose() {
	if r.closing {
		return
	}
	r.closing = true
	r.state = StateClosing
	r.closeBy = time.Now().Add(r.m.opts.CloseTimeout)
	r.m.update(r.id, true, func(rec *record) { rec.s.State = StateClosing })
	r.log().info("closing session")
	r.write(keyEscape)
	r.closeStep = 1
	r.closeTimer = time.NewTimer(closeAfterEscape)
}

func (r *runner) closeNext() {
	r.closeTimer = nil
	if time.Now().After(r.closeBy) {
		if !r.killed {
			r.killed = true
			r.log().warn("claude did not exit gracefully; killing", "timeout", r.m.opts.CloseTimeout.String())
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			if err := r.m.opts.Terminals.Kill(ctx, r.term.ID); err != nil {
				r.log().warn("kill session terminal", "err", err)
			}
			cancel()
		}
		return
	}
	switch r.closeStep {
	case 1:
		r.write(keyCtrlC)
		r.closeStep = 2
		r.closeTimer = time.NewTimer(closeCtrlCGap)
	case 2:
		r.write(keyCtrlC)
		r.closeStep = 1
		r.closeTimer = time.NewTimer(min(closeRepeat, time.Until(r.closeBy)+time.Millisecond))
	}
}

// onExit records how the process ended and removes its terminal.
func (r *runner) onExit(code int) {
	reason := ReasonExited
	switch {
	case r.closing:
		reason = ReasonClosed
	case code != 0:
		reason = ReasonCrashed
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	if err := r.m.opts.Terminals.Remove(ctx, r.term.ID); err != nil && !errors.Is(err, terminal.ErrNotFound) {
		r.log().warn("remove exited session terminal", "err", err)
	}
	cancel()
	r.log().info("session disconnected", "reason", reason, "exit_code", code)
	r.finish(func(s *Session) {
		s.State, s.DisconnectReason, s.ExitCode, s.TerminalID = StateDisconnected, reason, code, ""
	})
}

// finish detaches the runner, applying the final state.
func (r *runner) finish(fn func(*Session)) {
	r.finished = true
	for _, t := range []*time.Timer{r.closeTimer, r.debounce, r.cdTimer} {
		if t != nil {
			t.Stop()
		}
	}
	r.m.detach(r, func(s *Session) {
		fn(s)
		// Under m.mu, which RunIn holds while it queues: nothing can be queued after.
		if owed := r.unsentCd(); owed != nil {
			// The process is gone; the next reconnect resumes in the requested member.
			s.WorktreePath, s.RepoID = owed.path, owed.repoID
		}
		s.PendingWorktreePath = ""
		s.Status, s.StatusReason = StatusUnknown, ""
		if r.activity.After(s.LastActivityAt) {
			s.LastActivityAt = r.activity
		}
	})
}

// slogger prefixes runner logs with the session and terminal ids.
type slogger struct{ r *runner }

func (l *slogger) args(kv []any) []any {
	return append([]any{"session", l.r.id, "terminal", l.r.term.ID}, kv...)
}
func (l *slogger) debug(msg string, kv ...any) { l.r.m.log.Debug(msg, l.args(kv)...) }
func (l *slogger) info(msg string, kv ...any)  { l.r.m.log.Info(msg, l.args(kv)...) }
func (l *slogger) warn(msg string, kv ...any)  { l.r.m.log.Warn(msg, l.args(kv)...) }
