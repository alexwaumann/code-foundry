package session

import (
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

// The stdio runner: a rendered thread's claude runs as `claude -p` over stream-json
// (claudestream) instead of in a PTY. It is the same runner type as a terminal
// thread's, so lifecycle, status persistence, transcript tailing (naming, usage, PR
// links, /clear), RunIn and close share their code; runStream replaces the terminal
// loop. See docs/notes/rendered-threads-1-daemon.md.

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
	text        string   // as typed: the item's text
	composer    string   // the composer's text: the item's ComposerText
	attachments []string // staged paths
	prompt      string   // the text Claude gets (file refs rewritten, attachment lines)
}

// streamState is the stdio runner's part of runner. Every field is touched only by
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

	initDone chan error
	cmds     chan threadCmd
	viewSig  chan struct{}

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
	restart            restartPhase
	restartTimer       *time.Timer
	held               []threadCmd
	// grants: what allow-for-session answers gave this conversation, passed again to a
	// restarted process (effort.go).
	grants grants
	// swapping (under connMu): a restart is replacing the Conn; Store calls made outside
	// the goroutine are refused meanwhile (connection).
	swapping bool
}

// connection is the current Conn, for Store calls made outside the run goroutine. While
// a restart swaps it (the old process's stdin is closed, the new one has not answered
// the handshake) there is no Conn to talk to: refused.
func (st *streamState) connection() (*claudestream.Conn, error) {
	st.connMu.Lock()
	defer st.connMu.Unlock()
	if st.swapping {
		return nil, fmt.Errorf("%w: Claude is restarting for an effort change; try again in a moment", ErrFailedPrecondition)
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
	requestID string
	decision  Decision
	reply     chan threadReply
}

type threadReply struct {
	item    Item
	session Session // SetEffort's
	err     error
}

// viewersChanged tells the runner the thread's viewer count changed. Non-blocking;
// a terminal runner learns about viewers from its terminal's Attach count instead.
func (r *runner) viewersChanged() {
	if r.st == nil {
		return
	}
	select {
	case r.st.viewSig <- struct{}{}:
	default:
	}
}

// pid is the claude process id (Claude's sessions/<pid>.json follows /clear).
func (r *runner) pid() int {
	if r.st != nil {
		return r.st.proc.Pid()
	}
	return r.term.Pid
}

// spawnStream starts a rendered thread's claude and its runner. argv is the stream
// argv (launch.argv with spawnArgs.rendered).
func (m *Manager) spawnStream(ctx context.Context, rec *record, r *runner, argv, env []string, first *outgoing) error {
	s := rec.s
	log, err := m.thread(ctx, s.ID)
	if err != nil {
		return err
	}
	st := &streamState{
		sd: &streamStatus{}, log: log, first: first,
		initDone: make(chan error, 1),
		cmds:     make(chan threadCmd),
		viewSig:  make(chan struct{}, 1),
		pending:  map[string]*claudestream.PermissionRequest{},
		effort:   s.Effort, wantEffort: s.Effort,
	}
	st.proj = newProjector(itemWriter{log: log, save: func(it Item) { m.saveItem(s.ID, it) }}, restoredTotals(m.opts.Paths, r.cwd, r.launch))
	r.st = st
	// A run the daemon lost (crash) may have left items open.
	closeUnfinished(st.proj.w, "the thread's process ended")
	proc, err := claudestream.Start(claudestream.Spec{
		Argv: argv, Env: env, Dir: s.WorktreePath,
		Conn: claudestream.Options{Log: m.log.With("session", s.ID)},
	})
	if err != nil {
		return fmt.Errorf("session %s: spawn claude: %w", s.ID, err)
	}
	st.proc, st.conn = proc, proc.Conn()
	st.events = st.conn.Events()
	r.det = st.sd
	r.awaitFirstPrompt = false
	r.tail = newTailer(m.opts.Paths, r.cwd)
	r.tail.follow(r.launch.claudeID(), r.launch.resume != "" && !r.launch.fork)
	r.usage.watchDir = r.tail.watch
	now := m.opts.Now()
	r.activity, r.pubActivity, r.savedActivity = now, now, now
	r.viewers = m.viewerCount(s.ID)
	return nil
}

func (m *Manager) saveItem(id string, it Item) {
	if err := saveItem(context.Background(), m.opts.DB, id, it); err != nil {
		m.log.Error("persist thread item", "session", id, "item", it.ID, "err", err)
	}
}

// closeUnfinished completes items a run left open: streaming text stays as it is,
// running tool calls become errors, pending requests are cancelled.
func closeUnfinished(w itemWriter, why string) {
	for _, it := range w.log.unfinished() {
		w.change(it.ID, func(x *Item) {
			x.Streaming = false
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

func (r *runner) runStream() {
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
	for !r.finished {
		select {
		case err := <-st.initDone:
			r.onInitialized(err)
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
		case <-timerC(st.drainTimer):
			st.drainTimer = nil
			r.log().warn("claude exited but its output is still open; closing it")
			st.proc.CloseOutput()
		case cmd := <-st.cmds:
			r.onThreadCmd(cmd)
		case <-st.viewSig:
			r.onViewers()
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
		case <-timerC(st.restartTimer):
			st.restartTimer = nil
			if !st.initialized && !r.closing {
				r.failStart(errors.New("no answer to the initialize handshake after a restart"))
			}
		case <-r.closeReq:
			r.beginCloseStream()
		case req := <-r.cdReq:
			r.onCdRequest(req)
		case <-timerC(r.closeTimer):
			r.closeNextStream()
		case <-timerC(r.debounce):
			r.debounce = nil
			r.publishStatus()
		case <-r.stopReq:
			r.stopStream()
		}
	}
}

// initialize runs the handshake with the current process; the answer arrives on
// initDone.
func (r *runner) initialize() {
	st := r.st
	conn, timeout := st.conn, r.m.opts.StartTimeout
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		_, err := conn.Initialize(ctx)
		st.initDone <- err
	}()
}

// procDone is the process's exit channel until the exit was seen.
func procDone(st *streamState) <-chan struct{} {
	if st.exited {
		return nil
	}
	return st.proc.Done()
}

func (r *runner) onInitialized(err error) {
	st := r.st
	if err != nil {
		if !r.closing && !st.exited && !errors.Is(err, claudestream.ErrClosed) {
			// Still running but not answering (the startup timer says the same).
			// ErrClosed means its stdout ended: the process is gone or going, and
			// maybeExited records how (crashed, with its last stderr line).
			r.failStart(err)
		}
		return
	}
	st.initialized = true
	st.sd.initialized()
	if r.closing {
		return // closed while starting: the close finishes it
	}
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
		if _, err := r.sendMessage(f); err != nil {
			r.log().warn("send first prompt", "err", err)
		} else {
			sentFirst = true
		}
	}
	now := r.m.opts.Now()
	r.m.update(r.id, true, func(rec *record) {
		if rec.s.State == StateStarting {
			rec.s.State = StateConnected
		}
		rec.s.LastActivityAt = r.activity
		if sentFirst {
			rec.s.setStatus(r.status, r.reason, now)
		}
	})
	r.pubActivity = r.activity
	if sentFirst {
		r.pubStatus, r.pubReason = r.status, r.reason
	}
	r.log().info("session connected", "why", "initialized", "pid", st.proc.Pid())
	r.checkStatus()
}

// failStart records why the process did not come up and ends it.
func (r *runner) failStart(err error) {
	msg := "claude did not start: " + err.Error()
	if line := r.st.proc.LastStderrLine(); line != "" {
		msg += ": " + line
	}
	r.log().warn("rendered thread failed to start", "err", err)
	r.st.proj.w.add(Item{ID: r.st.proj.nextID("err"), Kind: KindError, Text: msg})
	r.m.update(r.id, true, func(rec *record) { rec.s.LastError = msg })
	r.beginCloseStream()
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
			r.checkMcp() // a turn starts: Claude pushes no MCP status changes (mcp.go)
		}
	case *claudestream.Result:
		r.acknowledgeIfViewed()
		if last := r.st.proj.last; last.tokens > 0 {
			r.m.recordContext(r.id, last.tokens, last.model)
		}
	case *claudestream.ConversationReset:
		r.log().info("claude reset the conversation (/clear)", "to", e.NewConversationID)
		r.m.recordContext(r.id, 0, "")
	}
	r.checkStatus()
	r.tryCd()
	r.maybeRestart()
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
	blocks := []claudestream.ContentBlock{claudestream.TextBlock(o.prompt)}
	for _, p := range o.attachments {
		b, err := imageBlock(p)
		if err != nil {
			return Item{}, err
		}
		blocks = append(blocks, b)
	}
	id, err := newUUID()
	if err != nil {
		return Item{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), streamControlTimeout)
	defer cancel()
	if err := st.conn.Send(ctx, claudestream.UserMessage{UUID: id, Blocks: blocks}); err != nil {
		return Item{}, fmt.Errorf("%w: send to claude: %v", ErrFailedPrecondition, err)
	}
	it := st.proj.w.add(Item{ID: id, Kind: KindUserMessage, Text: o.text, Attachments: o.attachments, ComposerText: o.composer})
	st.sd.sent()
	r.activity = r.m.opts.Now()
	r.checkStatus()
	return it, nil
}

// imageBlock reads a staged attachment as a base64 image block, its media type
// sniffed from the content.
func imageBlock(path string) (claudestream.ContentBlock, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return claudestream.ContentBlock{}, fmt.Errorf("%w: attachment %s: %v", ErrInvalidArgument, path, err)
	}
	mt := http.DetectContentType(data)
	if AttachmentTypes[mt] == "" {
		return claudestream.ContentBlock{}, fmt.Errorf("%w: attachment %s is %s, not an image", ErrInvalidArgument, path, mt)
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
	case cmd.send != nil && r.st.restart != restartNone:
		// Sent once the restarted process is up (onRestarted).
		r.st.held = append(r.st.held, cmd)
		return
	case cmd.send != nil:
		rep.item, rep.err = r.sendMessage(cmd.send)
	case cmd.effort != nil:
		rep.session = r.setEffort(*cmd.effort)
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
	if r.viewers > prev {
		r.acknowledge()
		r.checkStatus()
	}
}

// streamCd moves the conversation to req's member with set_cwd (RunIn), the
// rendered counterpart of typing /cd. The member is pre-trusted first: set_cwd
// refuses an untrusted folder ("needs_trust").
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
		rec.s.WorktreePath, rec.s.RepoID = req.path, req.repoID
		if rec.s.PendingWorktreePath == req.path {
			rec.s.PendingWorktreePath = ""
		}
	})
	r.log().info("thread moved to another workspace member", "path", req.path, "transcript_relocated", res.TranscriptRelocated)
}

// beginCloseStream: deny what is pending, interrupt a running turn, close stdin; then
// SIGTERM after CloseTimeout and SIGKILL streamKillGrace later (closeNextStream).
func (r *runner) beginCloseStream() {
	if r.closing {
		return
	}
	st := r.st
	r.closing = true
	st.restart = restartNone
	st.setSwapping(false)
	r.failHeld("the thread is closing")
	st.sd.pending = nil // the requests die with the process; do not keep their status
	r.closeStatus, r.closeReason = st.sd.Status()
	for id, req := range st.pending {
		r.answer(req, claudestream.PermissionResult{Message: "The thread was closed.", Interrupt: true})
		delete(st.pending, id)
		r.resolveItem(id, func(q *Request) { q.State, q.Message = RequestCancelled, "the thread was closed" })
	}
	r.state = StateClosing
	r.closeBy = time.Now().Add(r.m.opts.CloseTimeout)
	r.m.update(r.id, true, func(rec *record) { rec.s.State = StateClosing })
	r.log().info("closing session")
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

func (r *runner) closeNextStream() {
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

// stopStream is daemon shutdown: the process cannot outlive the daemon (it talks to
// it over pipes), so it is terminated, and the thread disconnects "daemon stopped".
func (r *runner) stopStream() {
	st := r.st
	_ = st.conn.CloseStdin()
	_ = st.proc.Signal(syscall.SIGTERM)
	select {
	case <-st.proc.Done():
	case <-time.After(streamKillGrace):
		_ = st.proc.Signal(syscall.SIGKILL)
	}
	st.sd.pending = nil
	r.failHeld("the daemon stopped")
	closeUnfinished(st.proj.w, "the daemon stopped")
	st.log.clearMcp()
	r.stopStreamTimers()
	st.conn.Close()
	// End the reader even if a grandchild kept stdout open.
	st.proc.CloseOutput()
	r.log().info("session disconnected", "reason", ReasonDaemonStopped)
	r.finish(func(s *Session) {
		s.State, s.DisconnectReason, s.TerminalID = StateDisconnected, ReasonDaemonStopped, ""
	})
}

func (r *runner) stopStreamTimers() {
	for _, t := range []*time.Timer{r.st.drainTimer, r.st.restartTimer} {
		if t != nil {
			t.Stop()
		}
	}
	r.st.drainTimer, r.st.restartTimer = nil, nil
}

// maybeExited finishes once the process has exited and its output is read.
func (r *runner) maybeExited() {
	st := r.st
	if !st.exited || !st.outputEnded || r.finished {
		return
	}
	if st.restart == restartClosing && !r.closing {
		r.respawn()
		return
	}
	r.failHeld("Claude exited")
	code := st.proc.ExitCode()
	reason := ReasonExited
	switch {
	case r.closing:
		reason = ReasonClosed
	case code != 0:
		reason = ReasonCrashed
	}
	lastErr := ""
	if !r.closing {
		midTurn := st.sd.busy || st.sd.compacting || len(st.pending) > 0
		lastErr = st.proc.LastStderrLine()
		if midTurn || code != 0 || !st.initialized {
			msg := fmt.Sprintf("Claude exited (code %d)", code)
			switch {
			case midTurn:
				msg = fmt.Sprintf("Claude exited mid-turn (code %d)", code)
			case !st.initialized:
				msg = fmt.Sprintf("Claude exited (code %d) before answering the initialize handshake", code)
			}
			if lastErr != "" {
				msg += ": " + lastErr
			}
			st.proj.w.add(Item{ID: st.proj.nextID("err"), Kind: KindError, Text: msg})
		}
	}
	st.sd.pending = nil
	closeUnfinished(st.proj.w, "the thread's process ended")
	st.log.clearMcp()
	r.stopStreamTimers()
	st.conn.Close()
	r.log().info("session disconnected", "reason", reason, "exit_code", code)
	r.finish(func(s *Session) {
		s.State, s.DisconnectReason, s.ExitCode, s.TerminalID = StateDisconnected, reason, code, ""
		if lastErr != "" && (code != 0 || !st.initialized) {
			s.LastError = lastErr
		}
	})
}
