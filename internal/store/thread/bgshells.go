package thread

import (
	"cmp"
	"encoding/json"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Background shells: the thread's own Bash calls with run_in_background and its Monitor
// calls (a watched command). Claude Code runs each as a "b…" task inside the thread's
// process and frames it like a subagent (claudestream.Task, task_type local_bash), so
// the runner follows the frames: task_started opens a shell, task_updated or
// task_notification ends it. Shells die with their process (Claude's --resume reports
// none), so they live in memory on the runner only: a daemon restart starts at zero.
// Shells a subagent started (owned_by_subagent) are not the thread's and stay skipped.
//
// The call's item follows the shell, like a background Agent call's follows its run:
// its result comes at once ("Command running in background with ID: b…"), so the
// projector keeps it running (projector.async) until the shell ends, then done with
// Claude's summary as its output, or an error with it. No note items: the count shows
// in the strip above the composer only (Session.BackgroundShellsRunning).

// shellOrphanSuffix ends the error of a shell still running when its process ended
// (the reasons are the agents': orphanProcessEnded, orphanDaemonStopped, ...).
const shellOrphanSuffix = " before the shell finished"

// BackgroundShell is one of the thread's own background shells while it runs.
type BackgroundShell struct {
	// TaskID is Claude's task id ("b…"), the one the call's result names.
	TaskID string
	// ToolUseID is the Bash or Monitor call (its item's id).
	ToolUseID string
	// Description is the call's description, as task_started gives it.
	Description string
	// Command is the call's command (from its input; the frames carry none).
	Command string
	// Monitor: a Monitor call; else a Bash call with run_in_background. Only the call
	// tells them apart.
	Monitor bool
	// StartedAt is task_started's arrival.
	StartedAt time.Time
}

// shellSet is a runner's background shells (runner goroutine only).
type shellSet struct {
	// running are the shells running now, by task id.
	running map[string]*BackgroundShell
	// ending are shells task_updated ended whose task_notification (with the summary)
	// has not come yet, with that end.
	ending map[string]shellEnd
}

// shellEnd is what a shell's end does to its call's item.
type shellEnd struct {
	shell  BackgroundShell
	failed bool
	// output replaces the item's output when not empty: Claude's summary, the reason it
	// failed, or why its process ended first.
	output string
	// final: the item no longer follows the shell (projector.agentEnded).
	final bool
}

// shellChange is what a task frame did to the shells.
type shellChange struct {
	// handled: the frame was a shell's (the agents model must not see it).
	handled bool
	// counted: the number of running shells changed.
	counted bool
	end     *shellEnd
}

// count is the number of running shells.
func (s *shellSet) count() int { return len(s.running) }

// task applies a task frame received at at. call looks up a tool call's name and input
// JSON by tool use id (the call precedes its task_started on the stream).
func (s *shellSet) task(t *claudestream.Task, at time.Time, call func(toolUseID string) (name, input string)) shellChange {
	switch t.Subtype {
	case claudestream.TaskStarted:
		if t.TaskType != claudestream.TaskTypeShell || !t.IsBackgrounded || t.OwnedBySubagent || t.ParentTaskID != "" {
			return shellChange{}
		}
		sh := &BackgroundShell{TaskID: t.TaskID, ToolUseID: t.ToolUseID, Description: t.Description, StartedAt: at}
		if call != nil && t.ToolUseID != "" {
			name, input := call(t.ToolUseID)
			sh.Monitor = name == "Monitor"
			var in struct {
				Command string `json:"command"`
			}
			if json.Unmarshal([]byte(input), &in) == nil {
				sh.Command = in.Command
			}
		}
		if s.running == nil {
			s.running = map[string]*BackgroundShell{}
		}
		_, again := s.running[t.TaskID]
		s.running[t.TaskID] = sh
		return shellChange{handled: true, counted: !again}
	case claudestream.TaskUpdated, claudestream.TaskNotification:
		final := t.Subtype == claudestream.TaskNotification
		wire := t.Status
		if !final {
			if t.Patch == nil {
				wire = ""
			} else {
				wire = t.Patch.Status
			}
		}
		if sh, ok := s.running[t.TaskID]; ok {
			st := agentStatusOf(wire)
			if wire == "" || st == AgentRunning {
				return shellChange{handled: true}
			}
			delete(s.running, t.TaskID)
			end := shellEndOf(*sh, st, wire, t.Summary, final)
			if !final {
				if s.ending == nil {
					s.ending = map[string]shellEnd{}
				}
				s.ending[t.TaskID] = shellEndOf(*sh, st, wire, "", true)
			}
			return shellChange{handled: true, counted: true, end: &end}
		}
		if prev, ok := s.ending[t.TaskID]; ok {
			if !final {
				return shellChange{handled: true}
			}
			delete(s.ending, t.TaskID)
			end := shellEndOf(prev.shell, agentStatusOf(wire), wire, t.Summary, true)
			return shellChange{handled: true, end: &end}
		}
	}
	// Not one of the thread's shells: a subagent's, or a frame after a shell's end (on
	// SIGTERM task_updated follows the notification). The agents model skips both: their
	// task id is no run of its.
	return shellChange{}
}

// shellEndOf: done takes Claude's summary as the output; anything else (failed, killed,
// stopped) is an error with Claude's summary when it says more than the shell's
// description (a stopped shell's is), else Claude's word. task_updated carries no
// summary: a done shell keeps its output until the notification.
func shellEndOf(sh BackgroundShell, st AgentStatus, wire, summary string, final bool) shellEnd {
	end := shellEnd{shell: sh, final: final, failed: st != AgentDone}
	switch {
	case !end.failed:
		end.output = strings.TrimSpace(summary)
	case final:
		end.output = failText(wire, summary, sh.Description)
	}
	return end
}

// apply completes the shell's call item (projector.async keeps it running till then).
func (e shellEnd) apply(p *projector) {
	if e.shell.ToolUseID != "" {
		p.agentEnded(e.shell.ToolUseID, e.failed, e.output, e.final)
	}
}

// apply is what the change does to the items.
func (ch shellChange) apply(p *projector) {
	if ch.end != nil {
		ch.end.apply(p)
	}
}

// orphan ends every shell: their process is gone (why), so they cannot finish. A shell
// task_updated already ended keeps that end, now final (its notification will not come):
// its call gets the status Claude gave and stops following the shell.
func (s *shellSet) orphan(why string) []shellEnd {
	var out []shellEnd
	for _, sh := range s.running {
		out = append(out, shellEnd{shell: *sh, failed: true, output: why + shellOrphanSuffix, final: true})
	}
	for _, end := range s.ending {
		out = append(out, end)
	}
	s.running, s.ending = nil, nil
	return out
}

// isShellLaunch reports whether a tool result says a Bash or Monitor call went to the
// background: Bash names its task in backgroundTaskId, Monitor in taskId.
func isShellLaunch(raw json.RawMessage) bool {
	// A cheap pre-filter before decoding: "askId" is in both backgroundTaskId and taskId.
	if len(raw) == 0 || !strings.Contains(string(raw), "askId") {
		return false
	}
	var res struct {
		BackgroundTaskID string `json:"backgroundTaskId"`
		TaskID           string `json:"taskId"`
	}
	unmarshalLoose(raw, &res)
	return cmp.Or(res.BackgroundTaskID, res.TaskID) != ""
}

// BackgroundWork reports whether the thread has work running after its turn: a
// background agent run it launched itself, one of its own background shells, or the turn
// Claude is about to start for one that just ended (WakePending, wake.go). Foreground runs
// are part of a turn, nested runs keep their background parent running.
func (s Thread) BackgroundWork() bool {
	_, background := s.AgentsRunning()
	return background > 0 || s.BackgroundShellsRunning > 0 || s.WakePending
}
