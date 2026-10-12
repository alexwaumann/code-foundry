package session

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Effort changes of a rendered thread. Claude has no live effort switch (no
// set_effort control request), so the runner restarts the process with --resume and
// the new --effort, between turns: the old process gets its stdin closed (it exits
// once idle), then the same runner starts the new one and does the handshake again.
// The thread stays connected throughout; its items, viewers, transcript tailing and
// usage carry on. A send during the restart waits for the new process (held).

// restartPhase is where a restart is.
type restartPhase int

const (
	restartNone     restartPhase = iota
	restartClosing               // the old process's stdin is closed; waiting for its exit
	restartStarting              // the new process is up; waiting for its handshake
)

// SetEffort implements Store.
func (m *Manager) SetEffort(ctx context.Context, id, effort string) (Session, error) {
	if !slices.Contains(Efforts, effort) {
		return Session{}, fmt.Errorf("%w: effort %q (want one of %s)", ErrInvalidArgument, effort, strings.Join(Efforts, ", "))
	}
	r, _, err := m.liveStream(id)
	if err != nil {
		return Session{}, err
	}
	cmd := threadCmd{effort: &effort, reply: make(chan threadReply, 1)}
	select {
	case r.st.cmds <- cmd:
	case <-r.done:
		return Session{}, fmt.Errorf("%w: thread %s disconnected", ErrFailedPrecondition, id)
	case <-ctx.Done():
		return Session{}, ctx.Err()
	}
	select {
	case rep := <-cmd.reply:
		return rep.session, rep.err
	case <-ctx.Done():
		return Session{}, ctx.Err()
	}
}

// restarting: a restart is under way (rendered threads only).
func (r *runner) restarting() bool { return r.st != nil && r.st.restart != restartNone }

// setEffort records the wanted effort on the row; maybeRestart applies it.
func (r *runner) setEffort(effort string) Session {
	st := r.st
	st.wantEffort = effort
	r.log().info("thread effort change requested", "effort", effort, "running", st.effort)
	s, _ := r.m.update(r.id, true, func(rec *record) {
		rec.s.Effort = effort
		rec.s.EffortPending = effort != st.effort
	})
	return s
}

// maybeRestart begins a restart for a pending effort change once nothing would be
// lost: connected, idle at the prompt, nothing pending, streaming or running (a
// background agent's tool call keeps running across turns), no send on its way.
func (r *runner) maybeRestart() {
	st := r.st
	if st.wantEffort == st.effort || st.restart != restartNone || r.closing || r.finished || !st.initialized ||
		st.first != nil || r.cdTimer != nil || !st.sd.AtPrompt() || len(st.log.unfinished()) > 0 {
		return
	}
	st.restart = restartClosing
	r.log().info("restarting claude for an effort change", "from", st.effort, "to", st.wantEffort, "pid", st.proc.Pid())
	conn := st.conn
	go func() { _ = conn.CloseStdin() }()
	// Not gone after CloseTimeout: SIGTERM, then SIGKILL (closeNextStream).
	r.closeStep = 1
	r.closeTimer = time.NewTimer(r.m.opts.CloseTimeout)
}

// respawn starts the new process once the old one has exited (maybeExited): the
// row's current launch options (model, permission mode, members) with the wanted
// effort, resuming the conversation Claude is on (it follows /clear). Before any
// message there is no transcript to resume, so the original launch is reused.
func (r *runner) respawn() {
	st := r.st
	if r.closeTimer != nil {
		r.closeTimer.Stop()
		r.closeTimer = nil
	}
	r.closeStep, r.killed = 0, false
	r.stopStreamTimers()
	st.conn.Close()
	closeUnfinished(st.proj.w, "Claude restarted")
	l := r.launch
	if id := r.tail.id; id != "" {
		if _, ok := r.m.opts.Paths.transcriptPath(r.cwd, id); ok {
			l = launch{resume: id}
		}
	}
	s, _ := r.m.Snapshot().Session(r.id)
	s.WorktreePath, s.Effort = r.cwd, st.wantEffort
	argv, env := r.m.claudeCommand(s, l, "")
	proc, err := claudestream.Start(claudestream.Spec{
		Argv: argv, Env: env, Dir: r.cwd,
		Conn: claudestream.Options{Log: r.m.log.With("session", r.id)},
	})
	if err != nil {
		msg := "Claude did not restart for the effort change: " + err.Error()
		r.log().warn("restart claude", "err", err)
		st.restart = restartNone
		st.proj.w.add(Item{ID: st.proj.nextID("err"), Kind: KindError, Text: msg})
		r.failHeld("Claude did not restart")
		r.finish(func(s *Session) {
			s.State, s.DisconnectReason, s.TerminalID, s.LastError = StateDisconnected, ReasonSpawnFailed, "", msg
		})
		return
	}
	st.connMu.Lock()
	st.proc, st.conn = proc, proc.Conn()
	st.connMu.Unlock()
	st.events = st.conn.Events()
	st.initialized, st.outputEnded, st.exited = false, false, false
	st.effort = s.Effort
	st.restart = restartStarting
	st.restartTimer = time.NewTimer(r.m.opts.StartTimeout)
	r.launch = l
	r.log().info("claude restarted", "pid", proc.Pid(), "argv", argv, "effort", s.Effort)
	r.initialize()
}

// onRestarted: the new process answered the handshake. The timeline says so, the row's
// pending flag clears (unless the effort changed again meanwhile), held sends go out.
func (r *runner) onRestarted() {
	st := r.st
	st.restart = restartNone
	if st.restartTimer != nil {
		st.restartTimer.Stop()
		st.restartTimer = nil
	}
	label := st.effort
	if label == "" {
		label = "Claude's default"
	}
	st.proj.w.add(Item{ID: st.proj.nextID("effort"), Kind: KindCommandOutput, Text: "Set effort to " + label})
	r.m.update(r.id, false, func(rec *record) { rec.s.EffortPending = st.wantEffort != st.effort })
	held := st.held
	st.held = nil
	for _, cmd := range held {
		var rep threadReply
		rep.item, rep.err = r.sendMessage(cmd.send)
		cmd.reply <- rep
	}
	r.checkStatus()
	r.maybeRestart()
}

// failHeld answers sends held by a restart that will not complete.
func (r *runner) failHeld(why string) {
	for _, cmd := range r.st.held {
		cmd.reply <- threadReply{err: fmt.Errorf("%w: %s", ErrFailedPrecondition, why)}
	}
	r.st.held = nil
}
