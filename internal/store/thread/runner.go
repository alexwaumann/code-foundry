package thread

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

// activityPersistGap is the minimum interval between saves of last_activity_at alone.
const activityPersistGap = 30 * time.Second

// runner owns one connected thread: its claude process over stdio (stream.go), the
// transcript tailer, status publishing, RunIn and close. All fields below are touched
// only by run (the goroutine), except closeReq, cdReq, stopReq and done, and st's
// documented exceptions. startedFor is set once, at newRunner.
type runner struct {
	m      *Manager
	id     string
	cwd    string
	launch launch
	// startedFor is the move this process was started for (launch.move at spawn).
	startedFor *moveJob

	// closeReq carries the disconnect reason of a close the daemon asks for ("": closed).
	closeReq chan string
	cdReq    chan cdRequest // RunIn and Move (queueMove); capacity 1, latest wins
	stopReq  chan struct{}
	idleReq  chan idleCheck // stopIdle; capacity 1 (lifecycle.go)
	done     chan struct{}
	// ready is closed once Claude first answered the handshake (lifecycle.go running).
	ready chan struct{}
	// dirsStale: the thread's project set changed since this process started
	// (members.go); maybeRestart restarts it for the new --add-dir list once it is quiet.
	// Set by changeMembers under Manager.mu, so a set change whose note never reached the
	// runner still restarts it at the next idle.
	dirsStale atomic.Bool
	// notes are timeline lines from outside the run goroutine that could not go through a
	// command (members.go noteFailed), added by the next maybeRestart.
	notesMu sync.Mutex
	notes   []string

	// ---- run goroutine only (st and tail are set by spawnStream before run starts) ----
	st    *streamState
	tail  *tailer
	state State

	// pendingCd is a move RunIn or Move queued, waiting for the prompt (runin.go).
	// atPromptSince: when Claude was last seen arriving at its prompt; zero while it is
	// not there.
	pendingCd     *cdRequest
	atPromptSince time.Time
	// moveRestart: a queued move waits for this restart (Claude asked for the folder's
	// trust, which it reads at start; move.go); respawn gives the new process the move's
	// folders and clears it.
	moveRestart *moveJob
	// echo: Claude accepted a set_cwd and writes its echo, a command with an empty result
	// and no turn (setcwd_echo.go); onStreamEvent drops it.
	echo cdEcho

	// reseedPending: a reseed waits to stop the process (reseed.go). seed is the prefix
	// of this fresh session's first message, until it went out (sendMessage).
	reseedPending bool
	seed          string
	// memNote is the app memory's refresh the next message of a resumed conversation
	// starts with, until it went out; memHash is the hash the row takes then (memory.go).
	memNote, memHash string

	closing bool
	// puttingAway: the end of a turn began this close (putaway.go): the status stays as
	// it began, so a turn Claude starts on the way out (a background task ended) raises
	// no attention.
	puttingAway bool
	// disconnectAs is the disconnect reason a close the daemon began itself records
	// instead of ReasonClosed (ReasonIdle); empty for a Close.
	disconnectAs string
	// startedAt is when the running process was spawned (the idle stop's grace).
	startedAt time.Time
	// startFailed: the process did not come up (no handshake); the thread ends with
	// status error ReasonStartFailed.
	startFailed bool
	// crashed: the process died on its own mid-turn (maybeExited): a busy thread ends
	// error ReasonCrashed, not ReasonInterrupted (disconnectedStatus).
	crashed bool
	// reportedAtStop: the daemon's stop cut a turn that had already filed its final
	// report (shutdown, reportCoversTurn): the thread ends finished, not interrupted.
	reportedAtStop bool
	readyClosed    bool
	// retrying: Thread.Retry is set (onAPIRetry), so clearRetry has something to clear.
	retrying bool
	// closeStatus/closeReason are the status when the close began: the close interrupts
	// a running turn, so the reading at exit no longer says it was busy (see finish).
	closeStatus Status
	closeReason string
	closeStep   int
	closeTimer  *time.Timer
	killed      bool

	status, pubStatus Status
	reason, pubReason string
	// ask, pubAsk: the request id the reason describes (Thread.PendingRequestID).
	ask, pubAsk string
	// tool, pubTool: the running tool call's line (Thread.BusyTool, busytool.go).
	tool, pubTool string
	// handled, pubHandled: the log's handled ordinal (Thread.HandledThrough, handled.go).
	handled, pubHandled int64
	// turn, pubTurn: when the latest turn started (Thread.TurnStartedAt, turn.go).
	turn, pubTurn time.Time
	debounce      *time.Timer

	activity, pubActivity, savedActivity time.Time

	namingSeen bool
	finished   bool

	// usage holds the thread's folds: one per transcript file and one per subagent run
	// (usage_runs.go). Each is complete from byte zero: a file read from its start, or
	// history rescanned on the first discovery (rescan). usageSeen: that discovery
	// happened. usageOff: the rescan failed, so some fold is partial and must not
	// replace the thread's usage; the next discovery (reconnect, restart) rescans.
	usage     *threadUsage
	usageSeen bool
	usageOff  bool
	// agentsPubAt: when the runs were last published (agents_runner.go throttle).
	agentsPubAt time.Time
	// bgShells are the thread's own background shells running in its process (bgshells.go).
	bgShells shellSet
	// wakePending: a background end at the prompt; Claude's own turn is due (wake.go).
	// wakePub is the value last published on the row.
	wakePending, wakePub bool
	wakeTimer            *time.Timer

	// viewers is the number of item watchers (Store.WatchItems). While someone watches
	// and presence is attended, whatever Claude produces is seen: see acknowledge.
	viewers int
}

func newRunner(m *Manager, id, cwd string, l launch) *runner {
	return &runner{
		m: m, id: id, cwd: cwd, launch: l, startedFor: l.move,
		closeReq: make(chan string, 1),
		cdReq:    make(chan cdRequest, 1),
		stopReq:  make(chan struct{}, 1),
		idleReq:  make(chan idleCheck, 1),
		done:     make(chan struct{}),
		ready:    make(chan struct{}),
		state:    StateStarting,
		usage:    newThreadUsage(time.Time{}, m.opts.Now, m.opts.AgentIdleClose),
	}
}

func (r *runner) requestClose() { r.requestCloseAs("") }

// requestCloseAs asks for a graceful close recorded as reason (Thread.DisconnectReason);
// a close already asked for or begun keeps its own.
func (r *runner) requestCloseAs(reason string) {
	select {
	case r.closeReq <- reason:
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

// timerC returns t's channel, or nil (blocks forever) for a nil timer.
func timerC(t *time.Timer) <-chan time.Time {
	if t == nil {
		return nil
	}
	return t.C
}

// acknowledge tells the status that the user has seen everything Claude produced so
// far, which clears "finished" attention. The rule: acknowledge when a viewer starts
// watching the thread's items, on every result while at least one viewer watches, and
// when presence becomes attended while one watches, each only while presence is
// attended (attended.go); and when the user answers a request, always. Pending
// requests are unaffected: they last until answered or withdrawn. A thread with no
// runner is acknowledged by the store instead (Manager.seenStoppedLocked).
func (r *runner) acknowledge() { r.st.sd.Acknowledge() }

func (r *runner) acknowledgeIfViewed() {
	if r.viewers > 0 && r.m.attended() {
		r.acknowledge()
	}
}

func (r *runner) onTick(now time.Time) {
	// Follow /clear: Claude moves to a new session id and transcript file.
	if id := pidSessionID(r.m.opts.Paths, r.pid()); id != "" && id != r.tail.id {
		r.log().info("claude switched session id", "from", r.tail.id, "to", id)
		r.tail.follow(id, false)
	}
	r.pollTranscript()
	r.checkStatus()
	r.tryCd()
	// Safety net for runs whose closing record never comes (tryCd keeps atPromptSince).
	r.usage.closeIdle(!r.atPromptSince.IsZero())
	r.publishUsage()
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
		r.m.discoverTranscript(r.id, cid)
		if !r.usageSeen {
			// The thread's first file in this runner: anything it used before (earlier
			// transcripts, this one's skipped history, their runs) is folded from byte
			// zero. A new conversation or a fork has nothing before.
			r.usageSeen = true
			if s, ok := r.m.Snapshot().Thread(r.id); ok && (r.tail.skipped > 0 || len(s.Transcripts) > 1 || len(s.AgentRuns) > 0) {
				r.rescan(s, cid, r.tail.path, r.tail.skipped)
			}
		}
		// After /clear the tailer follows a new file, read from its start.
		r.usage.file(cid, r.tail.path)
	}
	var f *fileUsage
	if len(lines) > 0 {
		f = r.usage.file(r.tail.id, r.tail.path)
	}
	var links []LinkedPullRequest
	for _, line := range lines {
		r.usage.transcriptLine(f, line)
		if !r.namingSeen {
			if msg, ok := firstUserText(line); ok {
				r.namingSeen = true
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
	// Runs after the thread's lines: a run's closing result has been applied, so its
	// final drain comes now.
	r.usage.poll()
	r.publishUsage()
}

// publishUsage replaces the thread's usage and runs when a fold or a run changed: at
// most once per poll with a new API response, a run opening or closing, or a run's
// lifecycle changing (streaming repeats of a counted request change nothing); a run's
// progress alone at most once per agentPublishGap. The thread log's runs follow. While
// the usage is off (a failed rescan) only the runs' records are published.
func (r *runner) publishUsage() {
	u := r.usage
	now := r.m.opts.Now()
	due := u.progressed && now.Sub(r.agentsPubAt) >= agentPublishGap
	if !u.changed && !due {
		return
	}
	var runs []AgentRun
	if r.usageOff {
		runs = u.runList()
		r.m.setAgentRuns(r.id, runs)
	} else {
		up := u.snapshot()
		runs = up.runs
		r.m.setUsage(r.id, up)
		r.checkBudget() // budget.go
	}
	u.progressed, r.agentsPubAt = false, now
	r.st.log.setAgents(runs)
}

// rescan folds every source of the thread from byte zero into a fresh threadUsage that
// becomes the live one: each transcript in s.Transcripts (the current one, cid at
// path, only up to limit, the history its tailer skipped; it reads on from there),
// then the runs under them. A transcript or run Claude has since deleted keeps its
// last saved fold. The result replaces whatever was persisted. The pr-link records of
// the current file's skipped history are merged in too (a thread reconnected after
// linking pull requests); first-seen order holds since this runs before any new line.
func (r *runner) rescan(s Thread, cid, path string, limit int64) {
	start := time.Now()
	u := newThreadUsage(r.usage.notBefore, r.usage.now, r.usage.idleClose)
	u.watchDir = r.usage.watchDir
	var saved map[string][]UsageBucket
	loadSaved := func() map[string][]UsageBucket {
		if saved == nil {
			all, err := loadSourceUsage(context.Background(), r.m.opts.DB, r.id)
			if err != nil {
				r.log().warn("load saved usage", "err", err)
			}
			saved = all[r.id]
			if saved == nil {
				saved = map[string][]UsageBucket{}
			}
		}
		return saved
	}
	var links []LinkedPullRequest
	var bytesRead int64
	for _, tc := range s.Transcripts {
		p, current := path, tc == cid
		if !current {
			var ok bool
			if p, ok = r.m.opts.Paths.transcriptPath(r.cwd, tc); !ok {
				f := u.file(tc, p)
				f.fold = seededFold(loadSaved()[transcriptSource(tc)])
				f.fold.notBefore = u.notBefore
				u.markDirty(transcriptSource(tc))
				continue
			}
		}
		f := u.file(tc, p)
		u.markDirty(transcriptSource(tc))
		n := int64(0)
		if current {
			if n = limit; n <= 0 {
				continue // nothing skipped: the tailer reads it from the start
			}
		}
		err := scanLines(p, n, func(line []byte) {
			bytesRead += int64(len(line)) + 1
			if current {
				if l, ok := parsePRLink(line); ok {
					links = append(links, l)
				}
			}
			u.transcriptLine(f, line)
		})
		if err != nil && u.err == nil {
			u.err = fmt.Errorf("rescan %s: %w", p, err)
		}
	}
	if !slices.Contains(s.Transcripts, cid) {
		u.file(cid, path)
	}
	u.settle()
	r.carryRuns(u, s.AgentRuns)
	for id := range u.runs {
		u.markDirty(runSource(id))
	}
	n := r.m.linkPullRequests(r.id, links)
	r.usage.closeAll()
	r.usage, r.usageOff = u, u.err != nil
	if r.usageOff {
		r.log().warn("usage rescan incomplete; keeping the saved usage until the next discovery", "err", u.err)
	} else {
		r.m.setUsage(r.id, u.snapshot())
	}
	r.log().debug("rescanned thread usage", "transcripts", len(s.Transcripts), "runs", len(u.runs),
		"open_runs", len(u.openRuns()), "links", len(links), "new_links", n, "bytes", bytesRead,
		"took", time.Since(start).Round(time.Millisecond).String())
}

// checkStatus schedules a debounced publish when the status or the running tool
// changed.
func (r *runner) checkStatus() {
	r.readStatus()
	if (r.status != r.pubStatus || r.reason != r.pubReason || r.ask != r.pubAsk || r.tool != r.pubTool || r.handled != r.pubHandled || !r.turn.Equal(r.pubTurn)) && r.debounce == nil {
		r.debounce = time.NewTimer(r.m.opts.StatusDebounce)
	}
}

// publishStatus publishes and persists the status. Persisting every change
// (debounced, a handful per turn) is what lets a thread that is waiting on the user
// still say so after the daemon dies without a clean shutdown. A new request that
// reads like the one before it (the same reason) is a change too: PendingRequestID.
// The running tool alone (BusyTool, a few per turn) is published without a save: it is
// not persisted. A new turn start is saved.
func (r *runner) publishStatus() {
	r.readStatus()
	if r.status == r.pubStatus && r.reason == r.pubReason && r.ask == r.pubAsk {
		if r.tool != r.pubTool || r.handled != r.pubHandled || !r.turn.Equal(r.pubTurn) {
			// A turn that ended with the status it had (finished, then finished again)
			// still publishes its handled ordinal: a forward's wake waits on it.
			save := !r.turn.Equal(r.pubTurn)
			r.pubTool, r.pubHandled, r.pubTurn = r.tool, r.handled, r.turn
			r.m.update(r.id, save, func(rec *record) {
				rec.s.BusyTool = busyToolFor(rec.s.Status, rec.s.StatusReason, r.tool)
				rec.s.HandledThrough = r.handled
				rec.s.TurnStartedAt = r.turn
			})
		}
		return
	}
	r.pubStatus, r.pubReason, r.pubAsk, r.pubTool, r.pubActivity, r.pubHandled, r.pubTurn = r.status, r.reason, r.ask, r.tool, r.activity, r.handled, r.turn
	now := r.m.opts.Now()
	r.m.update(r.id, true, func(rec *record) {
		rec.s.setStatus(r.status, r.reason, now)
		rec.s.PendingRequestID = r.ask
		rec.s.BusyTool = r.tool
		rec.s.LastActivityAt = r.activity
		rec.s.HandledThrough = r.handled
		rec.s.TurnStartedAt = r.turn
	})
}

// readStatus reads the status, its request and the running tool from the stream.
func (r *runner) readStatus() {
	r.status, r.reason = r.st.sd.Status()
	if r.puttingAway {
		r.status, r.reason = r.closeStatus, r.closeReason
	}
	r.ask = r.st.sd.asking()
	r.tool = busyToolFor(r.status, r.reason, r.st.proj.busy.line(r.cwd))
	r.handled = r.st.proj.w.log.handledThrough()
	r.turn = r.st.proj.w.log.turnStarted()
}

// finish detaches the runner, applying the final state. Every disconnect of a live
// process goes through here (exit, crash, close, idle stop, daemon stop): the thread
// keeps the slash commands and MCP status Claude last reported (threadcache_db.go) and the
// status it had at that moment, read fresh (the published one may lag by the
// debounce), or as it was when a close began; disconnectedStatus turns busy
// into interrupted.
func (r *runner) finish(fn func(*Thread)) {
	r.finished = true
	for _, t := range []*time.Timer{r.closeTimer, r.debounce} {
		if t != nil {
			t.Stop()
		}
	}
	st, reason := r.st.sd.Status()
	if r.closing {
		st, reason = r.closeStatus, r.closeReason
	}
	st, reason = disconnectedStatus(st, reason, r.crashed)
	if r.reportedAtStop && st == StatusError {
		st, reason = StatusNeedsAttention, "finished"
	}
	if r.startFailed {
		st, reason = StatusError, ReasonStartFailed
	}
	now := r.m.opts.Now()
	// Whether the conversation it leaves can continue, off m.mu: a miss globs
	// (transcriptmissing.go).
	cur, _ := r.m.Snapshot().Thread(r.id)
	gone := r.m.transcriptGone(cur)
	var lostMove *moveJob
	r.m.detach(r, func(s *Thread) {
		fn(s)
		s.TranscriptMissing = gone && s.ClaudeSessionID == cur.ClaudeSessionID && s.needsTranscript()
		// Under m.mu, which RunIn and Move (queueMove) hold while they queue: nothing can
		// be queued after.
		if owed := r.unsentCd(); owed != nil && owed.move != nil {
			// A Move moves only through set_cwd, which relocates the transcript: without
			// the process it does not happen (move.go).
			lostMove = owed.move
		} else if owed != nil {
			// The process is gone; the next reconnect resumes in the requested member.
			*s = s.movedTo(owed.projectID, owed.path)
		}
		s.PendingWorktreePath = ""
		s.EffortPending = false // the next spawn uses the row's effort
		s.Retry = nil           // the process is gone, so is the request it retried
		s.BackgroundShellsRunning, s.BackgroundShells = 0, nil
		s.WakePending = false
		s.PendingRequestID = "" // its requests ended with it
		s.BusyTool = ""         // and its tool calls
		if s.ReseedPending {
			// The reseed's stop (or any end meanwhile): the next start is fresh (reseed.go).
			s.ReseedPending = false
			s.resetContext()
		}
		s.setStatus(st, reason, now)
		// The turn the process end closed (closeOpenTurn) is over too.
		s.HandledThrough = max(s.HandledThrough, r.st.proj.w.log.handledThrough())
		s.TurnStartedAt = r.st.proj.w.log.turnStarted()
		if r.activity.After(s.LastActivityAt) {
			s.LastActivityAt = r.activity
		}
	})
	if lostMove != nil {
		err := fmt.Errorf("%w: Claude stopped before the thread could move", ErrFailedPrecondition)
		r.m.wg.Add(1) // this runner is still counted: no race with Shutdown's Wait
		go func() {
			defer r.m.wg.Done()
			r.m.failMove(context.Background(), r.id, lostMove, err, false)
		}()
	}
}

// slogger prefixes runner logs with the thread id.
type slogger struct{ r *runner }

func (l *slogger) args(kv []any) []any         { return append([]any{"thread", l.r.id}, kv...) }
func (l *slogger) debug(msg string, kv ...any) { l.r.m.log.Debug(msg, l.args(kv)...) }
func (l *slogger) info(msg string, kv ...any)  { l.r.m.log.Info(msg, l.args(kv)...) }
func (l *slogger) warn(msg string, kv ...any)  { l.r.m.log.Warn(msg, l.args(kv)...) }
