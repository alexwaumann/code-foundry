package thread

import (
	"cmp"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// The stdio runner: a thread's claude runs as `claude -p` over stream-json
// (claudestream). The control protocol carries the conversation, permission requests,
// interrupts and mode switches; the transcript is still tailed for naming, usage, PR
// links and /clear (runner.go). See docs/notes/rendered-threads-1-daemon.md and
// docs/notes/rendered-only-daemon.md.

// Stream timing.
const (
	// streamKillGrace is how long a SIGTERMed process gets before SIGKILL.
	streamKillGrace = 2 * time.Second
	// streamDrain is how long to keep reading stdout after the process exited (a
	// grandchild may hold the pipe open).
	streamDrain = 2 * time.Second
	// streamControlTimeout bounds control requests the runner makes itself.
	streamControlTimeout = 5 * time.Second
)

// outgoing is a user message on its way to Claude.
type outgoing struct {
	text        string       // as typed: the item's text
	composer    string       // the composer's text: the item's ComposerText
	attachments []attachment // staged files
	prompt      string       // the text Claude gets (file refs rewritten, attachment lines)
	// itemID is the user item's id when the item was written before the message could
	// go out (a message to a stopped or starting thread: recordUser); sendMessage then
	// delivers it under that id without writing a second item.
	itemID string
	// origin, wakeTitle and wakeJSON: the item's Origin, WakeTitle and WakeJSON.
	origin              MessageOrigin
	wakeTitle, wakeJSON string
	// note is the resume note line the prompt starts with (the item's ResumeNote), and
	// resume the pending note it came from, cleared once the message went out
	// (resumenote.go); empty without one.
	note   string
	resume ResumeNote
	// first: the thread's pending first message (Thread.PendingFirst), cleared on the row
	// once it went out (firstprompt.go).
	first bool
}

// streamState is the runner's process half. Every field is touched only by
// the run goroutine, except the channels and proc/conn: set before run starts, and
// replaced by a restart (effort.go) under connMu, which Store calls running outside the
// goroutine read them under (connection).
type streamState struct {
	connMu sync.Mutex
	proc   *claudestream.Process
	conn   *claudestream.Conn
	// events is the current conn's event channel; nil once it ended.
	events <-chan claudestream.Event
	sd     *streamStatus
	log    *threadLog
	proj   *projector

	first *outgoing // sent once initialize succeeds
	// queued are messages that came before the handshake (queue): their items are in
	// the timeline, they go out after first.
	queued []*outgoing

	initDone chan initResult
	cmds     chan threadCmd
	viewSig  chan struct{}
	// seenSig: presence became attended while the thread is viewed (attended.go).
	seenSig chan struct{}

	// pending holds the can_use_tool requests waiting for the user, by request id.
	// They arrive on the Conn's ordered events, so a request's item lands right after
	// the tool call it asks about.
	pending     map[string]*claudestream.PermissionRequest
	initialized bool
	outputEnded bool
	exited      bool
	drainTimer  *time.Timer

	// effort is the running process's --effort, wantEffort the one asked for
	// (Store.SetEffort); a restart (effort.go) makes them equal. held are sends that
	// came during a restart, answered once the new process is up.
	effort, wantEffort string
	// wantRestart: the user asked for a restart (Store.Restart; restart.go), which
	// maybeRestart begins once the interrupted turn is over; restartInterrupted: its
	// interrupt went out. userRestart: the restart under way is the user's.
	wantRestart, restartInterrupted, userRestart bool
	// restartFrom is the effort of the process a restart replaced (onRestarted notes a
	// change).
	restartFrom  string
	restartForce *time.Timer // forceRestart's deadline (restart.go)
	restart      restartPhase
	restartTimer *time.Timer
	held         []threadCmd
	// grants: what allow-for-thread answers gave this conversation, passed again to a
	// restarted process (effort.go).
	grants grants
	// swapping (under connMu): a restart is replacing the Conn; Store calls made outside
	// the goroutine are refused meanwhile (connection).
	swapping bool
	// commandsPushed: this process pushed its slash commands (slashcommands.go).
	commandsPushed bool
}

// connection is the current Conn, for Store calls made outside the run goroutine. While
// a restart swaps it (the old process's stdin is closed, the new one has not answered
// the handshake) there is no Conn to talk to: refused.
func (st *streamState) connection() (*claudestream.Conn, error) {
	st.connMu.Lock()
	defer st.connMu.Unlock()
	if st.swapping {
		return nil, fmt.Errorf("%w: Claude is restarting; try again in a moment", ErrFailedPrecondition)
	}
	return st.conn, nil
}

func (st *streamState) setSwapping(on bool) {
	st.connMu.Lock()
	st.swapping = on
	st.connMu.Unlock()
}

// threadCmd is a Store call the runner carries out on its goroutine.
type threadCmd struct {
	// ctx is the caller's: a send held across a restart is dropped once it is done.
	ctx       context.Context
	send      *outgoing
	effort    *string // SetEffort
	restart   bool    // Restart (restart.go)
	reseed    *seed   // Reseed (reseed.go)
	wakeLimit bool    // the wake limit was reached (subscriptions_fire.go)
	requestID string
	decision  Decision
	reply     chan threadReply
}

type threadReply struct {
	item      Item
	thread    Thread // SetEffort's, Restart's
	restarted bool   // Restart's: a restart was asked of the running process
	err       error
}

// viewersChanged tells the runner the thread's viewer count changed. Non-blocking.
func (r *runner) viewersChanged() {
	select {
	case r.st.viewSig <- struct{}{}:
	default:
	}
}

// pid is the claude process id (Claude's sessions/<pid>.json follows /clear).
func (r *runner) pid() int { return r.st.proc.Pid() }

// spawnStream starts a thread's claude and prepares its runner (spawn starts run). msgs
// go out once Claude answers its handshake, in order; the items of all but the first are
// in the timeline already.
func (m *Manager) spawnStream(ctx context.Context, rec *record, r *runner, argv, env []string, msgs []*outgoing) error {
	s := rec.s
	log, err := m.thread(ctx, s.ID)
	if err != nil {
		return err
	}
	var first *outgoing
	var queued []*outgoing
	if len(msgs) > 0 {
		first, queued = msgs[0], msgs[1:]
	}
	st := &streamState{
		sd: &streamStatus{waiting: first != nil}, log: log, first: first, queued: queued,
		initDone: make(chan initResult, 1),
		cmds:     make(chan threadCmd),
		viewSig:  make(chan struct{}, 1),
		seenSig:  make(chan struct{}, 1),
		pending:  map[string]*claudestream.PermissionRequest{},
		effort:   s.Effort, wantEffort: s.Effort,
	}
	st.proj = newProjector(itemWriter{log: log, save: func(it Item) { m.saveItem(s.ID, it) }}, restoredTotals(m.opts.Paths, r.cwd, r.launch))
	r.st = st
	// A run the daemon lost (crash) may have left items open.
	closeUnfinished(st.proj.w, "the thread's process ended")
	proc, err := claudestream.Start(claudestream.Spec{
		Argv: argv, Env: env, Dir: s.WorktreePath,
		Conn: claudestream.Options{Log: m.log.With("thread", s.ID)},
	})
	if err != nil {
		return fmt.Errorf("thread %s: spawn claude: %w", s.ID, err)
	}
	st.proc, st.conn = proc, proc.Conn()
	st.events = st.conn.Events()
	r.tail = newTailer(m.opts.Paths, r.cwd)
	r.tail.follow(r.launch.claudeID(), r.launch.resume != "" && !r.launch.fork)
	r.usage.watchDir = r.tail.watch
	now := m.opts.Now()
	r.activity, r.pubActivity, r.savedActivity = now, now, now
	r.startedAt = now
	r.viewers = m.viewerCount(s.ID)
	return nil
}

func (m *Manager) saveItem(id string, it Item) {
	if err := saveItem(context.Background(), m.opts.DB, id, it); err != nil {
		m.log.Error("persist thread item", "thread", id, "item", it.ID, "err", err)
	}
}

// closeUnfinished completes items a run left open: streaming text stays as it is,
// running tool calls become errors, pending requests are cancelled, queued messages
// stay where they are (Claude never read them).
func closeUnfinished(w itemWriter, why string) {
	for _, it := range w.log.unfinished() {
		w.change(it.ID, func(x *Item) {
			x.Streaming, x.Queued = false, false
			if x.Tool != nil && x.Tool.Status == ToolRunning {
				x.Tool.Status = ToolError
				if x.Tool.Output == "" {
					x.Tool.Output = "Interrupted: " + why + "."
				}
			}
			if x.Request != nil && x.Request.State == RequestPending {
				x.Request.State, x.Request.Message = RequestCancelled, why
			}
		})
	}
}

func (r *runner) run() {
	defer close(r.done)
	defer r.tail.close()
	defer r.usage.closeAll()
	st := r.st
	opts := r.m.opts
	tick := time.NewTicker(opts.Tick)
	defer tick.Stop()
	startup := time.NewTimer(opts.StartTimeout)
	defer startup.Stop()
	r.initialize()
	// A resumed conversation's transcript is there already: discover it (and rescan its
	// runs) before the first frame, which can be Claude reporting a run the previous
	// process left (agents_runner.go).
	r.pollTranscript()
	for !r.finished {
		select {
		case res := <-st.initDone:
			r.onInitialized(res)
		case ev, ok := <-st.events:
			if !ok {
				st.events, st.outputEnded = nil, true
				r.maybeExited()
				continue
			}
			r.onStreamEvent(ev)
		case <-procDone(st):
			st.exited = true
			if !st.outputEnded {
				st.drainTimer = time.NewTimer(streamDrain)
			}
			r.maybeExited()
		case <-timerC(r.wakeTimer):
			r.wakeTimer = nil
			r.wakeOver("no turn came") // wake.go
			r.maybeRestart()
		case <-timerC(st.drainTimer):
			st.drainTimer = nil
			r.log().warn("claude exited but its output is still open; closing it")
			st.proc.CloseOutput()
		case cmd := <-st.cmds:
			r.onThreadCmd(cmd)
		case <-st.viewSig:
			r.onViewers()
		case <-st.seenSig:
			r.onAttended()
		case <-r.tail.events():
			r.pollTranscript()
		case err := <-r.tail.errors():
			r.log().debug("transcript watcher", "err", err)
		case now := <-tick.C:
			r.onTick(now)
			r.maybeRestart()
		case <-startup.C:
			if !st.initialized && !r.closing && st.restart == restartNone {
				r.failStart(errors.New("no answer to the initialize handshake"))
			}
		case <-timerC(st.restartForce):
			r.forceRestart()
		case <-timerC(st.restartTimer):
			st.restartTimer = nil
			if !st.initialized && !r.closing {
				r.failStart(errors.New("no answer to the initialize handshake after a restart"))
			}
		case <-r.closeReq:
			r.beginClose()
		case req := <-r.cdReq:
			r.onCdRequest(req)
		case <-timerC(r.closeTimer):
			r.closeNext()
		case <-timerC(r.debounce):
			r.debounce = nil
			r.publishStatus()
		case <-r.stopReq:
			r.shutdown()
		case c := <-r.idleReq:
			r.onIdleCheck(c)
		}
	}
}

// initResult is the handshake's answer.
type initResult struct {
	resp *claudestream.InitializeResponse
	err  error
}

// initialize runs the handshake with the current process; the answer arrives on
// initDone.
func (r *runner) initialize() {
	st := r.st
	conn, timeout := st.conn, r.m.opts.StartTimeout
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		resp, err := conn.Initialize(ctx)
		st.initDone <- initResult{resp, err}
	}()
}

// procDone is the process's exit channel until the exit was seen.
func procDone(st *streamState) <-chan struct{} {
	if st.exited {
		return nil
	}
	return st.proc.Done()
}

func (r *runner) onInitialized(res initResult) {
	st := r.st
	if err := res.err; err != nil {
		if !r.closing && !st.exited && !errors.Is(err, claudestream.ErrClosed) {
			// Still running but not answering (the startup timer says the same).
			// ErrClosed means its stdout ended: the process is gone or going, and
			// maybeExited records how (crashed, with its last stderr line).
			if errors.Is(err, context.DeadlineExceeded) {
				// The handshake's deadline and the startup (or restart) timer are the
				// same StartTimeout: whichever fires first, the timeline says the same.
				err = errors.New("no answer to the initialize handshake")
				if st.restart != restartNone {
					err = errors.New("no answer to the initialize handshake after a restart")
				}
			}
			r.failStart(err)
		}
		return
	}
	st.initialized = true
	st.sd.initialized()
	if r.closing {
		return // closed while starting: the close finishes it
	}
	r.onSlashCommands(res.resp.Commands, false)
	if st.restart != restartNone {
		r.onRestarted()
		return
	}
	r.state = StateConnected
	// The first prompt goes out before the row says connected, and the row says busy in
	// the same update: otherwise the GUI sees a connected thread that is neither
	// starting nor working for a debounce (its timeline flashed "No messages yet.").
	sentFirst := false
	if f := st.first; f != nil {
		st.first = nil
		sentFirst = r.deliver(f)
	}
	queued := st.queued
	st.queued = nil
	for _, q := range queued {
		sentFirst = r.deliver(q) || sentFirst
	}
	now := r.m.opts.Now()
	r.m.update(r.id, true, func(rec *record) {
		rec.startFails = failedStarts{} // it starts: wakes go at once again (wakebackoff.go)
		if rec.s.State == StateStarting {
			rec.s.State = StateConnected
		}
		rec.s.LastActivityAt = r.activity
		if sentFirst {
			rec.s.setStatus(r.status, r.reason, now)
			rec.s.PendingRequestID = r.ask
		}
	})
	r.pubActivity = r.activity
	if sentFirst {
		r.pubStatus, r.pubReason, r.pubAsk = r.status, r.reason, r.ask
	}
	if !r.readyClosed {
		// After the row says connected: a caller waiting on ready (lifecycle.go running)
		// reads it next.
		r.readyClosed = true
		close(r.ready)
	}
	r.log().info("thread connected", "why", "initialized", "pid", st.proc.Pid())
	r.checkStatus()
}

// failStart records why the process did not come up and ends it; the thread ends with
// status error ReasonStartFailed (finish).
func (r *runner) failStart(err error) {
	msg := "Claude did not start: " + err.Error()
	if line := r.st.proc.LastStderrLine(); line != "" {
		msg += ": " + line
	}
	r.log().warn("thread failed to start", "err", err)
	r.st.proj.w.add(Item{ID: r.st.proj.nextID("err"), Kind: KindError, Text: msg})
	r.m.update(r.id, true, func(rec *record) { rec.s.LastError = msg })
	r.startFailed, r.disconnectAs = true, ReasonSpawnFailed
	r.beginClose()
}

// deliver sends a message that waited for the handshake (the first prompt, or one
// queued behind it) and reports whether it went out. When its item was written
// already, a failure is told in the timeline.
func (r *runner) deliver(o *outgoing) bool {
	if _, err := r.sendMessage(o); err != nil {
		r.log().warn("send a message that waited for the handshake", "err", err)
		if o.itemID != "" {
			r.st.proj.w.add(Item{ID: r.st.proj.nextID("err"), Kind: KindError, Text: "Claude did not get this message: " + err.Error()})
		}
		return false
	}
	return true
}

// queue takes a message that came before the handshake (a send to a starting thread):
// its item goes into the timeline now, after the first prompt's (written first so the
// order holds), and it goes out once Claude answers (onInitialized). It never fails for
// the handshake's sake: a start that fails is told in the timeline.
func (r *runner) queue(o *outgoing) (Item, error) {
	st := r.st
	if f := st.first; f != nil && f.itemID == "" {
		if _, err := recordUser(st.proj.w, f); err != nil {
			return Item{}, err
		}
		if f.first {
			r.m.setPendingFirstItem(r.id, f.itemID) // the next start must not write it again
		}
	}
	it, err := recordUser(st.proj.w, o)
	if err != nil {
		return Item{}, err
	}
	st.queued = append(st.queued, o)
	st.sd.waiting = true
	r.checkStatus()
	if o.origin == OriginWake {
		r.publishStatus() // as send does (waiting.go)
	}
	return it, nil
}

func (r *runner) onStreamEvent(ev claudestream.Event) {
	r.activity = r.m.opts.Now()
	r.st.proj.event(ev)
	r.st.sd.event(ev)
	switch e := ev.(type) {
	case *claudestream.PermissionRequest:
		r.onAsk(e)
	case *claudestream.ControlCancel:
		r.onAskGone(e.RequestID)
	case *claudestream.Status:
		r.onModeChange(e.PermissionMode)
	case *claudestream.Init:
		if !r.closing {
			r.checkMcp(e.McpServers) // a turn starts: Claude pushes no MCP status changes (mcp.go)
		}
	case *claudestream.Result:
		r.wakeOver("Claude's turn ended") // wake.go
		r.acknowledgeIfViewed()
		if last := r.st.proj.last; last.tokens > 0 {
			r.m.recordContext(r.id, last.tokens, last.model)
		}
	case *claudestream.CommandsChanged:
		r.onSlashCommands(e.Commands, true)
	case *claudestream.ConversationReset:
		r.log().info("claude reset the conversation (/clear)", "to", e.NewConversationID)
		r.m.recordContext(r.id, 0, "")
	case *claudestream.APIRetry:
		r.onAPIRetry(e)
	case *claudestream.Task:
		r.onTask(e) // agents_runner.go
	}
	r.clearRetry(ev)
	r.checkStatus()
	r.tryCd()
	r.maybeRestart()
}

// onAPIRetry records that Claude waits to retry a failed API request (Thread.Retry),
// so the thread says why it is quiet. Published, not persisted; cleared by clearRetry.
func (r *runner) onAPIRetry(e *claudestream.APIRetry) {
	status := 0
	if e.ErrorStatus != nil {
		status = *e.ErrorStatus
	}
	retry := &APIRetry{Attempt: e.Attempt, MaxRetries: e.MaxRetries, Status: status, Error: e.Error, RetryAt: r.activity.Add(time.Duration(e.RetryDelayMs) * time.Millisecond)}
	r.log().info("claude retries an API request", "attempt", e.Attempt, "max_retries", e.MaxRetries, "retry_in_ms", e.RetryDelayMs, "status", status, "error", e.Error)
	r.m.update(r.id, false, func(rec *record) { rec.s.Retry = retry })
}

// clearRetry drops Thread.Retry on the first frame after an api_retry that is not
// another one: nothing announces a retry's success, so the next frame of any other kind
// is the signal (Claude's own REPL clears its banner the same way). Unknown frames
// count too: they are Claude's, so the request went through.
func (r *runner) clearRetry(ev claudestream.Event) {
	if _, retry := ev.(*claudestream.APIRetry); retry {
		return
	}
	if s, ok := r.m.Snapshot().Thread(r.id); !ok || s.Retry == nil {
		return
	}
	r.m.update(r.id, false, func(rec *record) { rec.s.Retry = nil })
}

// wireModes maps the permission modes Claude reports to the row's.
var wireModes = map[string]PermissionMode{
	claudestream.ModeDefault:     PermissionSupervised,
	claudestream.ModeAcceptEdits: PermissionAcceptEdits,
	claudestream.ModeAuto:        PermissionAuto,
}

// onModeChange follows a mode change Claude reports (system/status permissionMode):
// SetPermissionMode's own, or one Claude made itself, e.g. "allow for session" applying
// a setMode suggestion (an Edit's switches to accept edits). The row records it, so the
// picker shows it and later spawns keep it. Modes the app does not offer are ignored.
func (r *runner) onModeChange(wire string) {
	mode, ok := wireModes[wire]
	if !ok {
		return
	}
	r.m.update(r.id, true, func(rec *record) {
		if rec.s.PermissionMode != mode {
			r.log().info("claude switched the permission mode", "mode", wire)
			rec.s.PermissionMode = mode
		}
	})
}

// sendMessage records the user item and writes the message.
func (r *runner) sendMessage(o *outgoing) (Item, error) {
	st := r.st
	if !st.initialized || r.closing {
		return Item{}, fmt.Errorf("%w: thread %s is not ready for a message", ErrFailedPrecondition, r.id)
	}
	// The first message of a fresh session a reseed asked for starts with its prefix
	// (reseed.go); o keeps the prompt as it was, should this send fail.
	prompt, seed := o.prompt, r.seed
	if seed != "" {
		prompt = seed + "\n\n" + prompt
	}
	blocks := []claudestream.ContentBlock{claudestream.TextBlock(prompt)}
	for _, a := range o.attachments {
		if !a.inline() {
			continue // the prompt names its path; Claude reads it with Read
		}
		b, err := mediaBlock(a.path)
		if err != nil {
			return Item{}, err
		}
		blocks = append(blocks, b)
	}
	id := o.itemID
	if id == "" {
		var err error
		if id, err = newUUID(); err != nil {
			return Item{}, err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.m.opts.SendTimeout)
	defer cancel()
	if err := st.conn.Send(ctx, claudestream.UserMessage{UUID: id, Blocks: blocks}); err != nil {
		if errors.Is(err, claudestream.ErrStalled) {
			r.onStalled(err)
			return Item{}, fmt.Errorf("%w: Claude stopped reading its input; the message was not delivered and the thread is closing", ErrFailedPrecondition)
		}
		return Item{}, fmt.Errorf("%w: send to claude: %v", ErrFailedPrecondition, err)
	}
	// Claude reads a message sent while it works at its next tool call (queued.go).
	queued := st.sd.busy || st.sd.compacting
	r.m.noteTurnMessage(r.id, !queued, o) // a timer's turn needs attention (waiting_reminder.go)
	var it Item
	if o.itemID == "" {
		u := userItem(id, o)
		u.Queued, u.SeedPrefix = queued, seed
		it = st.proj.w.add(u)
	} else if queued || seed != "" {
		it, _ = st.proj.w.change(id, func(x *Item) {
			x.Queued = x.Queued || queued
			x.SeedPrefix = seed
		})
	} else {
		it, _ = st.log.get(id)
	}
	if o.note != "" {
		r.m.clearResumeNote(r.id, o.resume)
	}
	if o.first {
		r.m.clearPendingFirst(r.id)
	}
	if seed != "" {
		r.seed = ""
		r.m.clearSeedPrefix(r.id, seed)
		r.log().info("sent the seed prefix with the fresh session's first message", "prefix_bytes", len(seed))
	}
	st.sd.sent(o.origin != OriginWake)
	r.activity = r.m.opts.Now()
	r.checkStatus()
	if o.origin == OriginWake {
		// Published before the wake's delivery returns, not after the debounce: the
		// waiting overlay holds the subscriber while the wake is queued (waiting.go).
		r.publishStatus()
	}
	return it, nil
}

// onStalled: Claude stopped reading its stdin (a message could not be written by
// Options.SendTimeout; its event loop is stuck). Nothing more can reach it, so the
// thread closes, with SIGTERM and SIGKILL to follow if it does not exit (beginClose).
func (r *runner) onStalled(err error) {
	r.log().warn("claude stopped reading its input; closing the thread", "err", err)
	r.addErrorOnce("Claude stopped reading its input; the thread is closing. Send the message again once it has stopped.")
	r.requestClose()
}

// mediaBlock reads a staged attachment as a base64 block, its media type sniffed from
// the content: a document block for a PDF, else an image block.
func mediaBlock(path string) (claudestream.ContentBlock, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return claudestream.ContentBlock{}, fmt.Errorf("%w: attachment %s: %v", ErrInvalidArgument, path, err)
	}
	mt := http.DetectContentType(data)
	switch {
	case AttachmentTypes[mt] == "":
		return claudestream.ContentBlock{}, fmt.Errorf("%w: attachment %s is %s, not an image or PDF", ErrInvalidArgument, path, mt)
	case mt == pdfType:
		return claudestream.DocumentBlock(mt, base64.StdEncoding.EncodeToString(data)), nil
	}
	return claudestream.ImageBlock(mt, base64.StdEncoding.EncodeToString(data)), nil
}

func (r *runner) onAsk(req *claudestream.PermissionRequest) {
	st := r.st
	if r.closing {
		r.answer(req, claudestream.PermissionResult{Message: "The thread is closing.", Interrupt: true})
		return
	}
	it := st.proj.w.add(requestItem(req))
	st.pending[req.RequestID] = req
	st.sd.ask(req.RequestID, it)
	r.log().info("claude asks", "tool", req.ToolName, "request", req.RequestID)
	r.checkStatus()
}

// answer sends a decision to Claude. A failure means Claude no longer waits for it
// (withdrawn, or its output ended): the item is resolved anyway, as before.
func (r *runner) answer(req *claudestream.PermissionRequest, res claudestream.PermissionResult) {
	if err := req.Answer(res); err != nil {
		r.log().debug("answer permission request", "request", req.RequestID, "err", err)
	}
}

func (r *runner) onAskGone(id string) {
	st := r.st
	if _, ok := st.pending[id]; !ok {
		return
	}
	delete(st.pending, id)
	st.sd.resolved(id)
	r.resolveItem(id, func(q *Request) { q.State, q.Message = RequestCancelled, "withdrawn by Claude" })
	r.checkStatus()
	r.maybeRestart()
}

// resolveItem updates the request item of request id.
func (r *runner) resolveItem(id string, fn func(*Request)) (Item, bool) {
	for _, prefix := range []string{"perm-", "q-"} {
		if it, ok := r.st.proj.w.change(prefix+id, func(it *Item) {
			if it.Request != nil {
				fn(it.Request)
			}
		}); ok {
			return it, true
		}
	}
	return Item{}, false
}

func (r *runner) onThreadCmd(cmd threadCmd) {
	var rep threadReply
	switch {
	case cmd.send != nil && (r.closing || r.finished):
		// The process is on its way out: Send waits for it, then starts a new one.
		cmd.reply <- threadReply{err: errProcessGone}
		return
	case cmd.send != nil && (r.st.restart != restartNone || r.st.wantRestart):
		// Sent once the restarted process is up (onRestarted).
		r.st.held = append(r.st.held, cmd)
		return
	case cmd.send != nil && !r.st.initialized:
		rep.item, rep.err = r.queue(cmd.send)
	case cmd.send != nil:
		rep.item, rep.err = r.sendMessage(cmd.send)
	case cmd.effort != nil:
		rep.thread = r.setEffort(*cmd.effort)
	case cmd.restart:
		rep.thread, rep.restarted = r.requestRestart()
	case cmd.reseed != nil:
		rep.thread, rep.restarted = r.onReseed(*cmd.reseed)
	case cmd.wakeLimit:
		rep.item = r.onWakeLimit()
	default:
		rep.item, rep.err = r.respond(cmd.requestID, cmd.decision)
	}
	cmd.reply <- rep
	r.maybeRestart()
}

func (r *runner) respond(id string, d Decision) (Item, error) {
	st := r.st
	req, ok := st.pending[id]
	if !ok {
		return Item{}, fmt.Errorf("%w: no pending request %s on thread %s", ErrNotFound, id, r.id)
	}
	cur, _ := st.log.get("perm-" + id)
	if req.IsQuestion() {
		cur, _ = st.log.get("q-" + id)
	}
	if cur.Request == nil {
		return Item{}, fmt.Errorf("%w: request %s has no item", ErrNotFound, id)
	}
	res, err := permissionResult(cur.Request, cur.Kind, d)
	if err != nil {
		return Item{}, err
	}
	if err := req.Answer(res); errors.Is(err, claudestream.ErrCancelled) {
		// Withdrawn by Claude before its cancel was handled here: the item says so, not
		// what the user picked.
		r.onAskGone(id)
		return Item{}, fmt.Errorf("%w: Claude withdrew request %s", ErrNotFound, id)
	} else if err != nil {
		r.log().debug("answer permission request", "request", id, "err", err)
	}
	if d.Allow && d.ForSession {
		st.grants.add(cur.Request.SuggestionsJSON)
	}
	delete(st.pending, id)
	st.sd.resolved(id)
	it, _ := r.resolveItem(id, func(q *Request) {
		switch {
		case !d.Allow:
			q.State, q.Decision, q.Message = RequestDenied, DecisionDeny, d.Message
		case d.ForSession:
			q.State, q.Decision = RequestAllowed, DecisionAllowForSession
		default:
			q.State, q.Decision = RequestAllowed, DecisionAllow
		}
		if d.Allow && cur.Kind == KindQuestion {
			q.Answers = d.Answers
		}
	})
	r.activity = r.m.opts.Now()
	r.acknowledge() // the user is answering, so they have seen the thread
	r.checkStatus()
	return it, nil
}

func (r *runner) onViewers() {
	prev := r.viewers
	r.viewers = r.m.viewerCount(r.id)
	if r.viewers > prev && r.m.attended() {
		r.acknowledge()
		r.checkStatus()
	}
}

// streamCd moves the conversation to req's member with set_cwd (RunIn). The member is
// pre-trusted first: set_cwd refuses an untrusted folder ("needs_trust").
func (r *runner) streamCd(req cdRequest) {
	fail := func(msg string) {
		r.log().warn("run in failed", "path", req.path, "err", msg)
		r.m.update(r.id, false, func(rec *record) {
			if rec.s.PendingWorktreePath == req.path {
				rec.s.PendingWorktreePath = ""
			}
			rec.s.LastError = "run in " + req.path + ": " + msg
		})
	}
	if !r.m.opts.DisablePreTrust {
		if _, err := trustWorktree(r.m.opts.Paths.Config, req.path); err != nil {
			r.log().warn("pre-trust member before set_cwd", "path", req.path, "err", err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), streamControlTimeout)
	defer cancel()
	res, err := r.st.conn.SetCwd(ctx, req.path)
	switch {
	case err != nil:
		fail(err.Error())
		return
	case res.Status != "ok":
		fail(nonEmpty(res.Message, res.Status))
		return
	}
	r.cwd = req.path
	r.tail.cwd = req.path
	r.m.update(r.id, true, func(rec *record) {
		rec.s.WorktreePath, rec.s.ProjectID = req.path, req.projectID
		if rec.s.PendingWorktreePath == req.path {
			rec.s.PendingWorktreePath = ""
		}
	})
	r.log().info("thread moved to another workspace member", "path", req.path, "transcript_relocated", res.TranscriptRelocated)
}

// beginClose: deny what is pending, interrupt a running turn, close stdin; then
// SIGTERM after CloseTimeout and SIGKILL streamKillGrace later (closeNext).
func (r *runner) beginClose() {
	if r.closing {
		return
	}
	st := r.st
	r.closing = true
	st.restart = restartNone
	st.setSwapping(false)
	r.failHeld("the thread is closing")
	st.first, st.queued = nil, nil // their items stay; Claude never got them
	st.sd.pending = nil            // the requests die with the process; do not keep their status
	r.closeStatus, r.closeReason = st.sd.Status()
	for id, req := range st.pending {
		r.answer(req, claudestream.PermissionResult{Message: "The thread was closed.", Interrupt: true})
		delete(st.pending, id)
		r.resolveItem(id, func(q *Request) { q.State, q.Message = RequestCancelled, "the thread was closed" })
	}
	r.state = StateClosing
	r.closeBy = time.Now().Add(r.m.opts.CloseTimeout)
	r.m.update(r.id, true, func(rec *record) { rec.s.State = StateClosing })
	r.log().info("closing thread")
	busy := st.sd.busy || st.sd.compacting
	conn := st.conn
	go func() {
		if busy {
			ctx, cancel := context.WithTimeout(context.Background(), streamControlTimeout)
			_ = conn.Interrupt(ctx)
			cancel()
		}
		_ = conn.CloseStdin()
	}()
	r.closeStep = 1
	r.closeTimer = time.NewTimer(r.m.opts.CloseTimeout)
}

func (r *runner) closeNext() {
	r.closeTimer = nil
	switch r.closeStep {
	case 1:
		r.log().warn("claude did not exit after stdin closed; terminating", "timeout", r.m.opts.CloseTimeout.String())
		_ = r.st.proc.Signal(syscall.SIGTERM)
		r.closeStep = 2
		r.closeTimer = time.NewTimer(streamKillGrace)
	case 2:
		if !r.killed {
			r.killed = true
			r.log().warn("claude ignored SIGTERM; killing")
			_ = r.st.proc.Signal(syscall.SIGKILL)
		}
	}
}

// kill is Manager.Shutdown's last resort for a runner that did not finish in time (its
// goroutine stuck): the process group is killed, so the process cannot outlive the
// daemon, and stdin closed, which ends a write the runner is stuck in. Safe off the
// run goroutine.
func (r *runner) kill() {
	r.st.connMu.Lock()
	proc, conn := r.st.proc, r.st.conn
	r.st.connMu.Unlock()
	r.log().warn("claude still running at the end of the daemon's shutdown; killing it")
	_ = proc.Signal(syscall.SIGKILL)
	_ = conn.CloseStdin()
}

// killGroup is the last step of every end of a Claude process, after the graceful
// close (interrupt, stdin closed, CloseTimeout, SIGTERM, SIGKILL; beginClose) or a
// crash: what is left in its process group (a tool it started that stayed there) gets
// SIGTERM, and SIGKILL streamKillGrace later, or at once on shutdown. What a Bash call
// left in the background has a group of its own; Archive and Remove stop that
// (strays.go).
func (r *runner) killGroup(proc *claudestream.Process) {
	left, err := proc.SignalGroup(syscall.SIGTERM)
	if err != nil {
		r.log().warn("signal claude's process group", "err", err)
		return
	}
	if !left {
		return
	}
	r.log().info("stopping what claude left in its process group", "pgid", proc.Pid())
	r.m.wg.Add(1)
	go func() {
		defer r.m.wg.Done()
		t := time.NewTimer(streamKillGrace)
		defer t.Stop()
		select {
		case <-t.C:
		case <-r.m.ctx.Done():
		}
		_, _ = proc.SignalGroup(syscall.SIGKILL)
	}()
}

// abandon ends a process whose runner never ran (spawn found the store shutting down):
// killed and reaped, its pipes and transcript tailer closed.
func (r *runner) abandon() {
	st := r.st
	_ = st.proc.Signal(syscall.SIGKILL)
	st.conn.Close()
	st.proc.CloseOutput()
	select {
	case <-st.proc.Done():
	case <-time.After(streamKillGrace):
		r.log().warn("abandoned claude did not exit after SIGKILL")
	}
	r.tail.close()
	r.usage.closeAll()
}

// shutdown is daemon shutdown: the process cannot outlive the daemon (it talks to
// it over pipes), so it is terminated, and the thread disconnects "daemon stopped".
func (r *runner) shutdown() {
	st := r.st
	// A turn the stop cuts off leaves a resume note for the next message (resumenote.go),
	// unless it had filed its final report already: it finished, all but its last words.
	cut := st.sd.busy || st.sd.compacting || len(st.pending) > 0
	if cut {
		if s, ok := r.m.Snapshot().Thread(r.id); ok && reportCoversTurn(s.Report, st.log.snapshot().Items) {
			cut, r.reportedAtStop = false, true
			r.log().info("the daemon stopped a turn after its final report: finished, not interrupted", "report", s.Report.Status.String())
		}
	}
	_ = st.conn.CloseStdin()
	_ = st.proc.Signal(syscall.SIGTERM)
	select {
	case <-st.proc.Done():
	case <-time.After(streamKillGrace):
		_ = st.proc.Signal(syscall.SIGKILL)
	}
	r.killGroup(st.proc)
	if f := st.first; f != nil && f.first {
		// Kept on the row for the next start (firstprompt.go).
		r.log().warn("first message not delivered: the daemon stopped; it goes at the next start")
	}
	st.sd.pending = nil
	r.failHeld("the daemon stopped")
	closeUnfinished(st.proj.w, "the daemon stopped")
	st.proj.cutTurn(r.m.opts.Now())
	r.endRuns(orphanDaemonStopped)
	r.endBgShells(orphanDaemonStopped)
	st.log.dropMcpChecks()
	r.stopStreamTimers()
	st.conn.Close()
	// End the reader even if a grandchild kept stdout open.
	st.proc.CloseOutput()
	r.log().info("thread disconnected", "reason", ReasonDaemonStopped)
	now := r.m.opts.Now()
	r.finish(func(s *Thread) {
		s.State, s.DisconnectReason = StateDisconnected, ReasonDaemonStopped
		if cut {
			s.ResumeNote = ResumeNote{Cause: ResumeRestart, At: now}
		}
	})
}

func (r *runner) stopStreamTimers() {
	for _, t := range []*time.Timer{r.st.drainTimer, r.st.restartTimer, r.st.restartForce} {
		if t != nil {
			t.Stop()
		}
	}
	r.st.drainTimer, r.st.restartTimer, r.st.restartForce = nil, nil, nil
}

// maybeExited finishes once the process has exited and its output is read.
func (r *runner) maybeExited() {
	st := r.st
	if !st.exited || !st.outputEnded || r.finished {
		return
	}
	r.killGroup(st.proc)
	if st.restart == restartClosing && !r.closing {
		r.respawn()
		return
	}
	r.failHeld("Claude exited")
	code := st.proc.ExitCode()
	reason := ReasonExited
	switch {
	case r.closing:
		reason = cmp.Or(r.disconnectAs, ReasonClosed)
	case code != 0:
		reason = ReasonCrashed
	}
	lastErr := ""
	if !r.closing {
		// Ended on its own. Mid-turn (or before its handshake) the timeline says so; at
		// the prompt nothing is lost and nothing is added: the next message starts it.
		midTurn := st.sd.busy || st.sd.compacting || len(st.pending) > 0
		lastErr = st.proc.LastStderrLine()
		why := exitWhy(code, lastErr)
		switch {
		case !st.initialized:
			r.startFailed = true
			r.addErrorOnce("Claude did not start: " + why)
		case midTurn:
			// No one stopped it: crashed, not interrupted (disconnectedStatus), and the
			// next message says so (resumenote.go).
			r.crashed = true
			r.addErrorOnce("Claude stopped unexpectedly (" + why + ")")
		}
	}
	st.sd.pending = nil
	closeUnfinished(st.proj.w, "the thread's process ended")
	// A turn still open had no result: a close or archive while busy, a crash.
	st.proj.cutTurn(r.m.opts.Now())
	r.endRuns(orphanProcessEnded)
	r.endBgShells(orphanProcessEnded)
	st.log.dropMcpChecks()
	r.stopStreamTimers()
	st.conn.Close()
	r.log().info("thread disconnected", "reason", reason, "exit_code", code)
	r.finish(func(s *Thread) {
		s.State, s.DisconnectReason, s.ExitCode = StateDisconnected, reason, code
		if lastErr != "" && (code != 0 || !st.initialized) {
			s.LastError = lastErr
		}
		if r.crashed {
			s.ResumeNote = ResumeNote{Cause: ResumeCrash, At: r.m.opts.Now()}
		}
		// Only a daemon stop keeps an undelivered first message (firstprompt.go): a start
		// that failed, or a close while starting, ends it as before.
		s.PendingFirst = nil
	})
}

// exitWhy says how a process ended: "exit code 1: <its last stderr line>", "killed".
func exitWhy(code int, lastErr string) string {
	why := fmt.Sprintf("exit code %d", code)
	if code < 0 {
		why = "killed"
	}
	if lastErr != "" {
		why += ": " + lastErr
	}
	return why
}

// addErrorOnce adds an error item unless the timeline already ends with this very line
// (one process end, one line); any other error before it stays and this one follows.
func (r *runner) addErrorOnce(text string) {
	if last, ok := r.st.log.last(); ok && last.Kind == KindError && last.Text == text {
		return
	}
	r.st.proj.w.add(Item{ID: r.st.proj.nextID("err"), Kind: KindError, Text: text})
}
