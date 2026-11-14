package terminal

import "time"

// Facts are what a terminal's process is doing now, read from the process table rather
// than from the program (no shell integration): Terminal.LiveCwd, Foreground and
// LastCommand. They let a window name a terminal by what runs in it, show the
// directory a shell has moved to, and offer the last command again.
//
// When they are read: a sample is taken FactsDelay after output (at most once per
// FactsDelay while output keeps coming), then again after each of FactsRecheck while the
// terminal stays quiet, for a job that started or ended without printing. Then nothing
// until the next output. A shell's prompt follows every command, `cd` included, so
// output is the signal; a sample costs one ioctl and two or three system calls
// (proc.go), never a process.

// factSample is one reading of a terminal's process.
type factSample struct {
	// cwd is the main process's working directory; "" when it could not be read.
	cwd string
	// fgKnown is whether the PTY's foreground group could be read.
	fgKnown bool
	// fg is the foreground job's command line; "" when the main process itself (the
	// shell at its prompt) is in the foreground.
	fg string
}

// applyFacts is cur with sample s applied, and whether anything changed. A command that
// leaves the foreground (it ended, or another job took its place) becomes LastCommand;
// what cannot be read keeps its last value.
func applyFacts(cur Terminal, s factSample) (Terminal, bool) {
	next := cur
	if s.cwd != "" {
		next.LiveCwd = s.cwd
	}
	if s.fgKnown && s.fg != cur.Foreground {
		if cur.Foreground != "" {
			next.LastCommand = cur.Foreground
		}
		next.Foreground = s.fg
	}
	return next, next.LiveCwd != cur.LiveCwd || next.Foreground != cur.Foreground || next.LastCommand != cur.LastCommand
}

// endFacts is cur once its process has exited: nothing is in the foreground, and what
// was becomes the last command.
func endFacts(cur Terminal) Terminal {
	if cur.Foreground != "" {
		cur.LastCommand = cur.Foreground
		cur.Foreground = ""
	}
	return cur
}

// ---- actor goroutine only ----

// readFacts samples the terminal's process: the main process's working directory and
// the PTY's foreground job.
func (a *actor) readFacts() factSample {
	var s factSample
	if cwd, err := cwdOf(a.cur.Pid); err == nil {
		s.cwd = cwd
	}
	if pg := foregroundGroup(a.master); pg > 0 {
		s.fgKnown = true
		if pg != a.cur.Pid {
			s.fg = groupCommand(pg)
		}
	}
	return s
}

// factsSoon schedules a sample FactsDelay from now, unless one is due sooner, and
// restarts the quiet rechecks after it.
func (a *actor) factsSoon() {
	if a.exited {
		return
	}
	a.factsStep = 0
	if a.factsC != nil && !a.factsDue.After(time.Now().Add(a.opts.FactsDelay)) {
		return
	}
	a.armFacts(a.opts.FactsDelay)
}

func (a *actor) armFacts(d time.Duration) {
	a.factsDue = time.Now().Add(d)
	if a.factsTimer == nil {
		a.factsTimer = time.NewTimer(d)
	} else {
		a.factsTimer.Reset(d)
	}
	a.factsC = a.factsTimer.C
}

func (a *actor) stopFacts() {
	if a.factsTimer != nil {
		a.factsTimer.Stop()
	}
	a.factsC = nil
}

// onFacts takes a sample, publishes what changed, and arms the next quiet recheck.
func (a *actor) onFacts() {
	a.factsC = nil
	if a.exited {
		return
	}
	if next, changed := applyFacts(a.cur, a.readFacts()); changed {
		a.cur = next
		a.schedulePublish()
	}
	if a.factsStep < len(a.opts.FactsRecheck) {
		d := a.opts.FactsRecheck[a.factsStep]
		a.factsStep++
		a.armFacts(d)
	}
}
