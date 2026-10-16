package thread

import "time"

// The wake after a background end. When one of the thread's own background shells or
// background agent runs ends while Claude is idle at its prompt, Claude starts a turn by
// itself to report it (system/init, a reply, a result: docs/notes/background-shells.md,
// agents-1-daemon.md), a moment after the end frame. Until that turn ends the thread is
// not really idle: an effort restart (maybeRestart) in that gap would close stdin under
// the reply. So the end sets wakePending, the next result clears it, and a fallback timer
// (Options.WakeTimeout) clears it when no turn comes. Thread.WakePending mirrors it on
// the row (not persisted, not on the proto) and Thread.BackgroundWork counts it.

// expectWake notes that a background end (what) may wake Claude: only when it arrived at
// the prompt (an end during a turn is reported in that turn).
func (r *runner) expectWake(what string) {
	if !r.st.sd.AtPrompt() {
		return
	}
	if r.wakeTimer != nil {
		r.wakeTimer.Stop()
	}
	r.wakeTimer = time.NewTimer(r.m.opts.WakeTimeout)
	if !r.wakePending {
		r.log().info("expecting Claude to wake for a background end", "what", what)
	}
	r.wakePending = true
	r.publishWake()
}

// wakeOver ends the wait: Claude's turn ended (or, why, none came).
func (r *runner) wakeOver(why string) {
	if !r.wakePending {
		return
	}
	if r.wakeTimer != nil {
		r.wakeTimer.Stop()
		r.wakeTimer = nil
	}
	r.wakePending = false
	r.log().info("background wake over", "why", why)
	r.publishWake()
}

// publishWake mirrors wakePending on the row when it changed (not persisted).
func (r *runner) publishWake() {
	if r.wakePub == r.wakePending {
		return
	}
	r.wakePub = r.wakePending
	on := r.wakePending
	r.m.update(r.id, false, func(rec *record) { rec.s.WakePending = on })
}
