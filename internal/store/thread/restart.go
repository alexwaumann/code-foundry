package thread

import (
	"context"
	"time"
)

// The user's restart of a thread's Claude (Store.Restart; thread.restart,
// docs/notes/plugins-env-restart.md): the effort restart's path (effort.go) without an
// effort change. The process is replaced by one that resumes the same conversation, so
// it picks up what changed outside the conversation, such as a plugin's session
// environment (envstale.go). Unlike an effort change it does not wait for a quiet
// moment: a running turn is interrupted first (Claude withdraws a pending permission
// request or question with it), and background agents and shells stop with the old
// process. Sends during the restart are held for the new process.

// RestartNote is the timeline's line once a user's restart is done.
const RestartNote = "Restarted Claude"

// Restart implements Store.
func (m *Manager) Restart(ctx context.Context, id string) (Thread, bool, error) {
	live, s, err := m.liveOrStopped(ctx, id)
	if err != nil {
		return Thread{}, false, err
	}
	if live == nil {
		// Not running: its next message starts Claude with the current environment.
		return s, false, nil
	}
	cmd := threadCmd{restart: true, reply: make(chan threadReply, 1)}
	select {
	case live.st.cmds <- cmd:
	case <-live.done:
		return m.Restart(ctx, id) // it stopped meanwhile
	case <-ctx.Done():
		return Thread{}, false, ctx.Err()
	}
	select {
	case rep := <-cmd.reply:
		return rep.thread, rep.restarted, rep.err
	case <-ctx.Done():
		return Thread{}, false, ctx.Err()
	}
}

// requestRestart records the user's restart; maybeRestart (run after every command)
// begins it, at once at the prompt, else after interrupting the turn. A closing
// process is not restarted (its thread stops; the next message starts it afresh).
func (r *runner) requestRestart() (Thread, bool) {
	s, _ := r.m.Snapshot().Thread(r.id)
	if r.closing || r.finished {
		return s, false
	}
	if r.st.restart == restartNone {
		r.st.wantRestart = true
	}
	// A restart under way (an effort change) already gives the new process the current
	// environment.
	r.log().info("thread restart requested", "at_prompt", r.st.sd.AtPrompt())
	return s, true
}

// interruptForRestart interrupts the running turn once per requested restart; the
// restart begins when Claude is back at its prompt (maybeRestart). If the turn has not
// ended within CloseTimeout, the restart goes ahead anyway (forceRestart), so held sends
// never wait on a turn that ignores the interrupt.
func (r *runner) interruptForRestart() {
	st := r.st
	if st.restartInterrupted {
		return
	}
	st.restartInterrupted = true
	st.restartForce = time.NewTimer(r.m.opts.CloseTimeout)
	r.log().info("interrupting the turn for a restart")
	conn := st.conn
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), streamControlTimeout)
		defer cancel()
		_ = conn.Interrupt(ctx)
	}()
}

// forceRestart: the interrupted turn did not end in time; restart now.
func (r *runner) forceRestart() {
	st := r.st
	st.restartForce = nil
	if !st.wantRestart || st.restart != restartNone || r.closing || r.finished || !st.initialized {
		return
	}
	r.log().warn("the turn did not end after the restart's interrupt; restarting anyway", "timeout", r.m.opts.CloseTimeout.String())
	r.beginRestart(true)
}
