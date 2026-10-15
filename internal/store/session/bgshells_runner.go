package session

import "github.com/alexwaumann/code-foundry/internal/claudestream"

// The runner's half of the background shells (bgshells.go): task frames in, the call's
// item and the Session's count out.

// onShellTask applies a task frame if it is one of the thread's own shells'; false
// when it is not (the agents model takes it).
func (r *runner) onShellTask(t *claudestream.Task) bool {
	ch := r.bgShells.task(t, r.m.opts.Now(), r.shellCall)
	if !ch.handled {
		return false
	}
	if t.Subtype == claudestream.TaskStarted {
		sh := r.bgShells.running[t.TaskID]
		r.log().info("background shell started", "task", t.TaskID, "monitor", sh.Monitor, "description", sh.Description)
	}
	if e := ch.end; e != nil && ch.counted {
		r.log().info("background shell ended", "task", e.shell.TaskID, "failed", e.failed, "output", e.output)
	}
	ch.apply(r.st.proj)
	if ch.counted {
		r.publishBgShells()
	}
	return true
}

// shellCall is a tool call's name and input by tool use id.
func (r *runner) shellCall(toolUseID string) (name, input string) {
	it, ok := r.st.log.get(toolUseID)
	if !ok || it.Tool == nil {
		return "", ""
	}
	return it.Tool.Name, it.Tool.InputJSON
}

// publishBgShells sets the Session's count of running shells (not persisted: shells die
// with the process). EventService carries it with the session.
func (r *runner) publishBgShells() {
	n := r.bgShells.count()
	if s, ok := r.m.Snapshot().Session(r.id); ok && s.BackgroundShellsRunning == n {
		return
	}
	r.m.update(r.id, false, func(rec *record) { rec.s.BackgroundShellsRunning = n })
}

// endBgShells ends the shells still running: their process is gone (why). closeUnfinished
// already made their calls errors; the reason becomes their output.
func (r *runner) endBgShells(why string) {
	ended := r.bgShells.orphan(why)
	for _, e := range ended {
		r.log().info("background shell orphaned", "task", e.shell.TaskID, "why", why)
		e.apply(r.st.proj)
	}
	if len(ended) > 0 {
		r.publishBgShells()
	}
}
