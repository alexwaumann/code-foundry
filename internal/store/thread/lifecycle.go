package thread

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// A thread's process lifecycle (docs/notes/thread-lifecycle.md). The user never starts
// or stops Claude: a message to a stopped thread starts it (Send, startStopped), and a
// thread idle at its prompt past its prompt cache expiry is stopped (stopIdle). Closing
// otherwise happens only on the way to something else: archive, snooze, remove, daemon
// stop. Settings changed while a thread is stopped go to the row, which the next spawn
// reads (claudeCommand).

// IdleCheckInterval is how often a running Manager looks for threads to stop at their
// cache expiry (Options.IdleCheckInterval's default).
const IdleCheckInterval = 30 * time.Second

// IdleGrace is how long a process stays up at least, whatever its cache says
// (Options.IdleGrace's default): a thread started without a prompt (an MCP check) or
// resumed long after its cache expired is not stopped at the next check.
const IdleGrace = 5 * time.Minute

// ReasonStartFailed is the StatusReason, with StatusError, of a thread whose Claude did
// not start (a message to a stopped thread, a handshake that never came).
const ReasonStartFailed = "did not start"

// errNotStopped: startStopped found the thread running, starting or closing (another
// caller got there first); the caller looks again.
var errNotStopped = errors.New("the thread is not stopped")

// errProcessGone: the runner a Store call was handed to is closing or has finished
// (r.call, onThreadCmd); the caller looks at the thread again and, for a message,
// starts it once the old process is gone.
var errProcessGone = fmt.Errorf("%w: the thread's process is ending", ErrFailedPrecondition)

// reserve marks a stopped record STARTING before its process exists, so a concurrent
// start waits on reserved (lifecycle) instead of starting a second one. spawn's commit
// or the start's failure releases it. Callers hold m.mu.
func (rec *record) reserve() {
	rec.s.State = StateStarting
	rec.reserved = make(chan struct{})
}

// release ends a reservation (a no-op without one). Callers hold m.mu.
func (rec *record) release() {
	if rec.reserved != nil {
		close(rec.reserved)
		rec.reserved = nil
	}
}

// lifecycle reads where a thread's process is: live (a runner that is not closing),
// closing (a runner on its way out), reserved (a start before its runner exists: the
// channel closes when it resolves), or none of them (stopped).
func (m *Manager) lifecycle(id string) (live, closing *runner, reserved <-chan struct{}, s Thread, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return nil, nil, nil, Thread{}, err
	}
	switch {
	case rec.run != nil && rec.s.State == StateClosing:
		closing = rec.run
	case rec.run != nil:
		live = rec.run
	case rec.reserved != nil:
		reserved = rec.reserved
	}
	return live, closing, reserved, rec.s, nil
}

// liveOrStopped waits out a reserved start and returns the thread's live runner, or
// nil when it has none (stopped, or closing).
func (m *Manager) liveOrStopped(ctx context.Context, id string) (*runner, Thread, error) {
	for {
		live, _, reserved, s, err := m.lifecycle(id)
		if err != nil || reserved == nil {
			return live, s, err
		}
		select {
		case <-reserved:
		case <-ctx.Done():
			return nil, s, ctx.Err()
		}
	}
}

// updateStopped applies fn to a thread that has no live process (stopped, or closing:
// a closing process is never restarted) and commits it, persisted. It reports false,
// changing nothing, when the thread is live or a start is reserved: the caller looks
// again (liveOrStopped).
func (m *Manager) updateStopped(id string, fn func(*Thread)) (Thread, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, false, err
	}
	if rec.reserved != nil || (rec.run != nil && rec.s.State != StateClosing) {
		return rec.s, false, nil
	}
	fn(&rec.s)
	m.commitLocked(rec, true)
	return rec.s, true, nil
}

// waitDone waits for a closing runner to finish.
func waitDone(ctx context.Context, r *runner) error {
	select {
	case <-r.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// startOpts says how startStopped starts a thread.
type startOpts struct {
	// first is the message Claude gets once it answered the handshake. Its item goes
	// into the timeline at once, and a failure to start is told there too (an error
	// item, status error) instead of failing the call. nil starts without a prompt.
	first *outgoing
	// backToList unarchives and unsnoozes the thread (a message, Reconnect).
	backToList bool
}

// startStopped starts claude for a stopped thread: it reserves the thread against a
// concurrent start, resumes its conversation (resumeLaunch) and spawns. With o.first it
// returns the user item, written before the spawn, and a start that fails becomes an
// error item ("Claude did not start: <reason>") and status error with a nil error; the
// thread stays stopped and the next message tries again. Without o.first a failure is
// the error (LastError has it too). errNotStopped when the thread is not stopped.
func (m *Manager) startStopped(ctx context.Context, id string, o startOpts) (Item, error) {
	m.mu.Lock()
	rec, err := m.record(id)
	switch {
	case err != nil:
		m.mu.Unlock()
		return Item{}, err
	case m.closed:
		m.mu.Unlock()
		return Item{}, ErrClosed
	case rec.run != nil || rec.reserved != nil || rec.s.State != StateDisconnected:
		m.mu.Unlock()
		return Item{}, errNotStopped
	}
	prev := rec.s
	rec.reserve()
	if o.first != nil {
		// A message starts a turn: the status the thread saved (a finished turn, a prompt
		// lost with its process, an interruption) is replaced at once, as a send to a live
		// thread does, so clients never count it as both working and waiting on the user.
		// Published with the start's own update below; a failed start sets error.
		rec.s.setStatus(StatusBusy, "working", m.opts.Now())
	}
	m.mu.Unlock()

	var log *threadLog
	if o.first != nil {
		if log, err = m.thread(ctx, id); err != nil {
			return Item{}, m.failStart(id, nil, err)
		}
	}
	// A worktree a cleanup removed is made again first (recreate.go); clients see the
	// thread STARTING meanwhile.
	var notes []string
	var l launch
	var lastErr string
	rw, launchErr := m.ensureWorktree(ctx, prev)
	if rw != nil {
		notes = append(notes, rw.note())
	}
	var remade []madeWorktree // the other members' worktrees made again
	if launchErr == nil {
		if remade, launchErr = m.ensureMembers(ctx, prev); len(remade) > 0 {
			notes = append(notes, remadeNote(remade))
		}
	}
	if launchErr == nil {
		var note string
		l, lastErr, note, launchErr = m.resumeLaunch(prev)
		if note != "" {
			notes = append(notes, note)
			m.log.Info("conversation not found; starting a new one", "thread", id, "claude_session_id", prev.ClaudeSessionID)
		}
	}
	noteLog := log
	if noteLog == nil && (rw != nil || len(remade) > 0) {
		// No message: the recreation is still told in the timeline.
		if noteLog, err = m.thread(ctx, id); err != nil {
			m.log.Warn("note the recreated worktree", "thread", id, "err", err)
		}
	}
	if noteLog != nil {
		w := itemWriter{log: noteLog, save: func(it Item) { m.saveItem(id, it) }}
		for _, note := range notes {
			w.add(Item{ID: "note-" + itemSuffix(), Kind: KindNote, Text: note})
		}
	}
	var it Item
	if log != nil {
		w := itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}
		if pf := prev.PendingFirst; pf != nil && pf.ItemID == "" {
			// The first message a stop kept goes out first (firstprompt.go): its item too.
			po := pf.outgoing()
			if _, err := recordUser(w, po); err != nil {
				return Item{}, m.failStart(id, nil, err)
			}
			m.setPendingFirstItem(id, po.itemID)
		}
		if it, err = recordUser(w, o.first); err != nil {
			return Item{}, m.failStart(id, nil, err)
		}
	}
	if launchErr != nil {
		return it, m.failStart(id, log, launchErr)
	}
	m.update(id, false, func(r *record) {
		r.s.LastError = lastErr
		if o.backToList {
			// Persisted by spawn's commit, or by failStart.
			m.unarchiveLocked(r)
			m.unsnoozeLocked(r)
		}
		if l.resume == "" {
			r.s.ClaudeSessionID = ""
			r.namingTried = r.s.namedForGood()
			r.s.FreshStart = false // a reseed's fresh start is this one (reseed.go)
		}
		r.first = o.first
	})
	if err := m.spawn(ctx, id, l); errors.Is(err, ErrClosed) {
		// The daemon is stopping: not a failure to tell in the timeline.
		return it, m.failStart(id, nil, err)
	} else if err != nil {
		return it, m.failStart(id, log, err)
	}
	if m.opts.WorktreeCreated != nil {
		// The project's on-worktree-create actions run again, as after Create.
		if rw != nil {
			m.opts.WorktreeCreated(id, rw.projectID, rw.path)
		}
		for _, w := range remade {
			m.opts.WorktreeCreated(id, w.projectID, w.path)
		}
	}
	return it, nil
}

// failStart ends a reserved start that did not spawn. With log (a message started it)
// the timeline says so and the status becomes error; the error is swallowed, since the
// message was accepted. Without, the error is returned and kept in LastError.
func (m *Manager) failStart(id string, log *threadLog, err error) error {
	msg := startFailure(id, err)
	if log != nil {
		w := itemWriter{log: log, save: func(it Item) { m.saveItem(id, it) }}
		w.add(Item{ID: "err-" + itemSuffix(), Kind: KindError, Text: msg})
		// The message's turn never ran: it ends here (turnclose.go).
		closeOpenTurn(w, m.opts.Now())
		m.log.Warn("thread failed to start", "thread", id, "err", err)
	}
	now := m.opts.Now()
	m.update(id, true, func(r *record) {
		r.release()
		r.first = nil
		r.s.State = StateDisconnected
		if log == nil {
			r.s.LastError = err.Error()
			return
		}
		r.s.DisconnectReason, r.s.LastError = ReasonSpawnFailed, msg
		r.s.setStatus(StatusError, ReasonStartFailed, now)
		r.noteStartFailed() // wakes back off (wakebackoff.go)
	})
	if log != nil {
		return nil
	}
	return err
}

// startFailure is the timeline's line for a start that failed: "Claude did not start:
// <reason>", without the store's own "thread <id>: " prefix.
func startFailure(id string, err error) string {
	return "Claude did not start: " + strings.TrimPrefix(err.Error(), "thread "+id+": ")
}

// itemSuffix is a unique tail for an item id the daemon makes outside a runner.
func itemSuffix() string {
	if u, err := newUUID(); err == nil {
		return u
	}
	return fmt.Sprint(time.Now().UnixNano())
}

// recordUser writes o's user item into the timeline under a new id, which o keeps:
// sendMessage then delivers it without a second item.
func recordUser(w itemWriter, o *outgoing) (Item, error) {
	id, err := newUUID()
	if err != nil {
		return Item{}, err
	}
	o.itemID = id
	return w.add(userItem(id, o)), nil
}

func userItem(id string, o *outgoing) Item {
	return Item{ID: id, Kind: KindUserMessage, Text: o.text, Attachments: attachmentPaths(o.attachments), ComposerText: o.composer,
		Origin: o.origin, WakeTitle: o.wakeTitle, WakeJSON: o.wakeJSON, ResumeNote: o.note}
}

// resumeLaunch is how a stopped thread starts again: claude --resume of its
// conversation when the transcript is there; else a new conversation in the same
// worktree, with why in lastErr, and note, when a conversation existed but its
// transcript is gone, for the timeline (Claude remembers nothing of it). An error when
// the worktree is gone (startStopped has recreated one a cleanup removed first, when
// the thread qualifies: recreate.go).
func (m *Manager) resumeLaunch(prev Thread) (l launch, lastErr, note string, err error) {
	if _, err := os.Stat(prev.WorktreePath); err != nil {
		return launch{}, "", "", fmt.Errorf("%w: worktree %s: %v", ErrFailedPrecondition, prev.WorktreePath, err)
	}
	if prev.FreshStart {
		// A reseed asked for a new conversation (reseed.go).
		l.newID, err = newUUID()
		return l, "", "", err
	}
	if prev.ClaudeSessionID != "" {
		if _, ok := m.opts.Paths.transcriptPath(prev.WorktreePath, prev.ClaudeSessionID); ok {
			return launch{resume: prev.ClaudeSessionID}, "", "", nil
		}
		lastErr = "transcript of " + prev.ClaudeSessionID + " not found; started a new conversation"
		note = "Started a new conversation: the previous one's transcript is gone, so Claude does not remember this thread's earlier messages."
	} else {
		lastErr = "no saved conversation to resume (no message was sent); started a new conversation"
	}
	if l.newID, err = newUUID(); err != nil {
		return launch{}, "", "", err
	}
	return l, lastErr, note, nil
}

// running returns a thread's runner once Claude answered its handshake, starting a
// stopped thread without a prompt (McpStatus with refresh, McpReconnect); IdleGrace then
// keeps the process up a while. One start at most: a process that ends before its
// handshake is an error.
func (m *Manager) running(ctx context.Context, id string) (*runner, error) {
	started := false
	for {
		live, closing, reserved, s, err := m.lifecycle(id)
		switch {
		case err != nil:
			return nil, err
		case live != nil:
			select {
			case <-live.ready:
				return live, nil
			case <-live.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		case closing != nil:
			if err := waitDone(ctx, closing); err != nil {
				return nil, err
			}
		case reserved != nil:
			select {
			case <-reserved:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		case started:
			return nil, fmt.Errorf("%w: Claude did not start: %s", ErrFailedPrecondition, nonEmpty(s.LastError, "it ended before answering"))
		default:
			if _, err := m.startStopped(ctx, id, startOpts{}); err != nil && !errors.Is(err, errNotStopped) {
				return nil, err
			} else if err == nil {
				m.log.Info("started thread without a prompt", "thread", id)
				started = true
			}
		}
	}
}

// idleCheck asks a runner whether its process may stop at now; done, when not nil, gets
// the answer (tests). Non-blocking: a check already queued answers for this one.
type idleCheck struct {
	now  time.Time
	done chan<- string
}

// requestIdleCheck hands the runner a check without waiting.
func (r *runner) requestIdleCheck(c idleCheck) bool {
	select {
	case r.idleReq <- c:
		return true
	default:
		return false
	}
}

// stopIdle asks every connected thread's runner to stop if it has been idle past its
// prompt cache expiry (runner.onIdleCheck decides, on its goroutine). New runs it every
// Options.IdleCheckInterval; threads overdue at startup have no process anyway.
func (m *Manager) stopIdle() {
	now := m.opts.Now()
	m.mu.Lock()
	var runners []*runner
	for _, rec := range m.recs {
		if rec.run != nil && rec.s.State == StateConnected {
			runners = append(runners, rec.run)
		}
	}
	m.mu.Unlock()
	for _, r := range runners {
		r.requestIdleCheck(idleCheck{now: now})
	}
}

// stopIdleLoop runs stopIdle on every tick until Shutdown cancels m.ctx. Like the
// snooze wake it compares wall-clock times, so a Mac that slept stops overdue threads
// at the first tick after it wakes.
func (m *Manager) stopIdleLoop(tick <-chan time.Time) {
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-tick:
			m.stopIdle()
		}
	}
}

// cacheTTLNow is the TTL in effect.
func (m *Manager) cacheTTLNow() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cacheTTLLocked()
}

// onIdleCheck stops the process gracefully (beginClose, disconnect reason ReasonIdle)
// when nothing holds it (idleHold), and tells c.done the hold ("" when it stopped).
func (r *runner) onIdleCheck(c idleCheck) {
	hold := r.idleHold(c.now)
	if hold == "" {
		r.log().info("stopping idle thread at its prompt cache expiry", "idle", c.now.Sub(r.lastActive()).Round(time.Second).String())
		r.disconnectAs = ReasonIdle
		r.beginClose()
	}
	if c.done != nil {
		c.done <- hold
	}
}

// lastActive is when the thread last did something: the stream's last event or send,
// or the row's last activity when that is later (the runner's activity starts at spawn).
func (r *runner) lastActive() time.Time {
	s, _ := r.m.Snapshot().Thread(r.id)
	if s.LastActivityAt.After(r.activity) {
		return s.LastActivityAt
	}
	return r.activity
}

// idleInputs is what an idle stop depends on, read by the runner (idleHold).
type idleInputs struct {
	now                 time.Time
	closing, starting   bool // a close or a (re)start is under way
	messageOnItsWay     bool // the first prompt, one queued behind the handshake, one held by an effort restart
	effortChange        bool // a wanted effort the running process does not have
	pendingRequest      bool
	atPrompt            bool
	unfinishedItem      bool
	backgroundWork      bool // the thread's own background agents and shells
	startedAt           time.Time
	cacheExpiresAt      time.Time // zero without a result
	lastActive          time.Time
	cacheTTL, idleGrace time.Duration
}

// idleHoldOf says what keeps a process up, "" when nothing does: it is closing or
// (re)starting, a message is on its way, an effort change waits, a request waits on the
// user, Claude is not idle at its prompt, background work runs, an item is unfinished,
// the process is younger than the grace, or the prompt cache has not expired (a thread
// without a result counts from its last activity). Viewers do not matter.
func idleHoldOf(in idleInputs) string {
	switch {
	case in.closing:
		return "closing"
	case in.starting:
		return "starting"
	case in.messageOnItsWay:
		return "message on its way"
	case in.effortChange:
		return "effort change"
	case in.pendingRequest:
		return "pending request"
	case !in.atPrompt:
		return "busy"
	case in.backgroundWork: // before its call, which stays unfinished while it runs
		return "background work"
	case in.unfinishedItem:
		return "unfinished item"
	case in.now.Sub(in.startedAt) < in.idleGrace:
		return "grace"
	}
	exp := in.cacheExpiresAt
	if exp.IsZero() {
		exp = in.lastActive.Add(in.cacheTTL)
	}
	if in.now.Before(exp) {
		return "cache warm"
	}
	return ""
}

// idleHold is idleHoldOf for this runner at now (run goroutine only).
func (r *runner) idleHold(now time.Time) string {
	return idleHoldOf(r.idleInputs(now))
}

// idleInputs are what an idle stop (and a reseed's: reseed.go) depends on for this
// runner at now (run goroutine only).
func (r *runner) idleInputs(now time.Time) idleInputs {
	st := r.st
	s, _ := r.m.Snapshot().Thread(r.id)
	return idleInputs{
		now:             now,
		closing:         r.closing || r.finished,
		starting:        !st.initialized || st.restart != restartNone,
		messageOnItsWay: st.first != nil || len(st.queued) > 0 || len(st.held) > 0,
		effortChange:    st.wantEffort != st.effort,
		pendingRequest:  len(st.pending) > 0 || len(st.sd.pending) > 0,
		atPrompt:        st.sd.AtPrompt(),
		unfinishedItem:  len(st.log.unfinished()) > 0,
		backgroundWork:  r.bgShells.count() > 0 || r.wakePending || s.BackgroundWork(), // wakePending: Claude's turn for a background end is due (wake.go)
		startedAt:       r.startedAt,
		cacheExpiresAt:  s.CacheExpiresAt,
		lastActive:      r.lastActive(),
		cacheTTL:        r.m.cacheTTLNow(),
		idleGrace:       r.m.opts.IdleGrace,
	}
}
