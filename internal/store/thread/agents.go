package thread

import (
	"cmp"
	"encoding/json"
	"path/filepath"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// A thread's subagent runs as they happen (docs/notes/agents-1-daemon.md). The runs are
// the AgentRun records the transcripts already give (usage_runs.go: identity, Open,
// Usage); the stream's task frames (claudestream.Task) add their lifecycle: status,
// current activity, Claude's counters, the report or the error. Both are applied on the
// runner goroutine to the same runUsage, so there is one record per run, persisted in
// session_agent_runs and published on the Session (AgentRuns) and on the thread's log
// (ItemsSnapshot.Agents, AgentsChanged; agents_runner.go).
//
// The frames are the source: a run's task_started makes it running, task_updated and
// task_notification end it (completed is done, anything else failed), and a SendMessage
// that wakes a finished run starts it again under the same id (running in place,
// ResumedAt). Shell tasks (task_type local_bash) share the frames and are skipped. A run
// no frame has spoken for (an older Claude, a run found only on disk) follows its
// transcript records instead (transcriptLife). Subagents run inside the thread's claude
// process: when it ends, its running runs fail (orphan).

// AgentStatus is a subagent run's lifecycle state.
type AgentStatus string

// Agent statuses.
const (
	AgentRunning AgentStatus = "running"
	AgentDone    AgentStatus = "done"
	AgentFailed  AgentStatus = "failed"
)

// agentStatusOf maps Claude's task statuses (task_updated's patch, task_notification):
// completed is done, running and pending are running, anything else (failed, killed,
// stopped, a newer word) failed.
func agentStatusOf(wire string) AgentStatus {
	switch wire {
	case "completed":
		return AgentDone
	case "running", "pending":
		return AgentRunning
	}
	return AgentFailed
}

// Why a running run failed without Claude saying so: its process ended first. Error is
// the reason + orphanSuffix.
const (
	orphanSuffix        = " before the agent finished"
	orphanProcessEnded  = "the thread's process ended"
	orphanDaemonStopped = "the daemon stopped"
	orphanDaemonRestart = "the daemon restarted"
	orphanRestarted     = "Claude restarted"
	orphanRescan        = "the thread restarted"
)

// agentLife is a run's lifecycle state that is not persisted: what the runner needs
// between frames.
type agentLife struct {
	// live: a task frame spoke for the run in this runner; the transcript no longer
	// decides its status.
	live bool
	// notePending: the run ended in this runner (running to done or failed) and its note
	// waits for the task_notification, which carries the report.
	notePending bool
	// baseToolUses, baseDurationMS: the counters when the run last woke (Claude counts
	// each wake from zero).
	baseToolUses, baseDurationMS int64
}

// agentChange says what one task frame did.
type agentChange struct {
	run *runUsage // nil: not a subagent run (a shell task, an unknown id)
	// life: a lifecycle change (status, report, a new run), published at once; progress
	// alone sets threadUsage.progressed instead.
	life bool
	// ended: the run went from running to done or failed.
	ended bool
	// final: the frame was the run's task_notification.
	final bool
	// note: add the note announcing a background run's end (agentNote).
	note bool
}

// spawnInput is what the runner knows about a task_started's tool use: whether its item
// exists, whether it is an Agent (Task) call and that call's input.
type spawnInput struct {
	known, agent bool
	ev           runEvent
}

// agentInput reads an Agent call's input from its item.
func agentInput(it Item) spawnInput {
	if it.Tool == nil {
		return spawnInput{known: true}
	}
	if it.Tool.Name != "Agent" && it.Tool.Name != "Task" {
		return spawnInput{known: true}
	}
	var in struct {
		Description     string `json:"description"`
		SubagentType    string `json:"subagent_type"`
		Model           string `json:"model"`
		Effort          string `json:"effort"`
		RunInBackground bool   `json:"run_in_background"`
	}
	unmarshalLoose([]byte(it.Tool.InputJSON), &in)
	return spawnInput{known: true, agent: true, ev: runEvent{kind: runSpawned, toolUseID: it.ID,
		description: in.Description, agentType: in.SubagentType, model: in.Model, effort: in.Effort, background: in.RunInBackground}}
}

// runTime is how run times are kept (as persisted).
func runTime(t time.Time) time.Time { return t.UTC().Truncate(time.Millisecond) }

// task applies one task frame received at at. where names the subagents directory and
// transcript of the conversation now (for a run met first here); spawn looks up a tool
// use's item.
func (u *threadUsage) task(t *claudestream.Task, at time.Time, where func() (dir, cid string), spawn func(toolUseID string) spawnInput) agentChange {
	if t.Subtype == claudestream.TaskStarted {
		return u.taskStarted(t, at, where, spawn)
	}
	r := u.runs[t.TaskID]
	if r == nil {
		return agentChange{}
	}
	switch t.Subtype {
	case claudestream.TaskProgress:
		r.live = true
		before := r.info
		if t.Description != "" {
			r.info.Activity = t.Description
		}
		if t.LastToolName != "" {
			r.info.LastTool = t.LastToolName
		}
		r.takeUsage(t.Usage)
		if !sameRunInfo(before, r.info) {
			u.progressed = true
		}
		return agentChange{run: r}
	case claudestream.TaskUpdated:
		if t.Patch == nil || t.Patch.Status == "" {
			return agentChange{run: r}
		}
		end := at
		if t.Patch.EndTime > 0 {
			end = time.UnixMilli(t.Patch.EndTime)
		}
		return u.setLife(r, agentStatusOf(t.Patch.Status), t.Patch.Status, end, "", nil)
	case claudestream.TaskNotification:
		st := AgentDone
		if t.Status != "" {
			st = agentStatusOf(t.Status)
		}
		ch := u.setLife(r, st, t.Status, at, t.Report(), t.Usage)
		ch.final = true
		if r.notePending && r.info.Background && st != AgentRunning {
			ch.note = true
		}
		r.notePending = false
		return ch
	}
	return agentChange{run: r}
}

// taskStarted starts a run, or wakes a finished one in place (SendMessage).
func (u *threadUsage) taskStarted(t *claudestream.Task, at time.Time, where func() (dir, cid string), spawn func(string) spawnInput) agentChange {
	in := spawn(t.ToolUseID)
	if t.TaskType != claudestream.TaskTypeAgent && (t.TaskType != "" || !in.agent) {
		return agentChange{} // a shell or another kind of task
	}
	r := u.runs[t.TaskID]
	// A wake: the run ended before (a frame said so, or its process went). A run the
	// transcript met a moment before its first frame is just starting.
	woke := r != nil && r.info.Status != AgentRunning && (r.live || !r.info.EndedAt.IsZero())
	if r == nil {
		if !validAgentID(t.TaskID) {
			return agentChange{}
		}
		// The tool use is the spawn's unless its item says otherwise (a SendMessage
		// waking a run this thread no longer knows).
		tool := t.ToolUseID
		if in.known && !in.agent {
			tool = ""
		}
		dir, cid := where()
		if r = u.ensureRun(t.TaskID, dir, cid, tool); r == nil {
			r = &runUsage{info: AgentRun{ID: t.TaskID, ClaudeSessionID: cid, ToolUseID: tool, SpawnDepth: 1},
				dir: dir, fold: usageFold{notBefore: u.notBefore}, tail: fileTail{path: agentFile(dir, t.TaskID)}}
			u.runs[t.TaskID] = r
			u.link(r)
		}
	}
	r.live = true
	before := r.info
	r.info.Description = orStr(r.info.Description, t.Description)
	r.info.AgentType = orStr(r.info.AgentType, t.SubagentType)
	r.info.Background = r.info.Background || t.IsBackgrounded
	r.info.ParentID = orStr(r.info.ParentID, t.ParentTaskID)
	if t.SpawnDepth > 0 && !r.metaRead {
		r.info.SpawnDepth = t.SpawnDepth
	}
	if in.agent && in.ev.toolUseID == r.info.ToolUseID {
		r.takeSpawn(in.ev)
	}
	if r.info.StartedAt.IsZero() {
		r.info.StartedAt = runTime(at)
	}
	if woke {
		r.info.ResumedAt = runTime(at)
		r.info.Activity, r.info.LastTool = "", ""
		r.baseToolUses, r.baseDurationMS = r.info.ToolUses, r.info.DurationMS
	}
	r.info.Status = AgentRunning
	r.info.Summary, r.info.Error, r.info.EndedAt = "", "", time.Time{}
	r.notePending = false
	u.open(r, time.Time{})
	ch := agentChange{run: r, life: !sameRunInfo(before, r.info)}
	if ch.life {
		u.changed = true
	}
	return ch
}

func agentFile(dir, id string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "agent-"+id+".jsonl")
}

// takeUsage takes Claude's counters: the tokens as they are, tool uses and time on top
// of the run's earlier wakes.
func (r *runUsage) takeUsage(tu *claudestream.TaskUsage) {
	if tu == nil {
		return
	}
	if tu.TotalTokens > 0 {
		r.info.TotalTokens = tu.TotalTokens
	}
	r.info.ToolUses = r.baseToolUses + tu.ToolUses
	r.info.DurationMS = r.baseDurationMS + tu.DurationMS
}

// setLife applies a status a frame reported: wire is Claude's word, end when the run
// ended, report what it said (a notification's), tu its final counters.
func (u *threadUsage) setLife(r *runUsage, st AgentStatus, wire string, end time.Time, report string, tu *claudestream.TaskUsage) agentChange {
	r.live = true
	before := r.info
	was := r.info.Status
	r.takeUsage(tu)
	r.info.Status = st
	switch st {
	case AgentRunning:
		r.info.EndedAt = time.Time{}
	case AgentDone:
		if was == AgentRunning || r.info.EndedAt.IsZero() {
			r.info.EndedAt = runTime(end)
		}
		r.info.Summary = cmp.Or(report, r.info.Summary)
		r.info.Error = ""
	default:
		if was == AgentRunning || r.info.EndedAt.IsZero() {
			r.info.EndedAt = runTime(end)
		}
		if why := failText(wire, report, r.info.Description); report != "" || r.info.Error == "" || was == AgentRunning {
			r.info.Error = why
		}
	}
	ch := agentChange{run: r, ended: was == AgentRunning && st != AgentRunning}
	if ch.ended {
		r.notePending = true
	}
	if ch.life = !sameRunInfo(before, r.info); ch.life {
		u.changed = true
	}
	return ch
}

// failText says why a run failed: Claude's report when it says more than the run's
// name (a stopped run's summary is its description), else Claude's status word.
func failText(wire, report, description string) string {
	if report = strings.TrimSpace(report); report != "" && report != description {
		return report
	}
	return cmp.Or(wire, "failed")
}

// runEnd is how the transcript says a run ended (or that it runs).
type runEnd struct {
	status  AgentStatus
	why     string // failed: the error
	summary string // done: the report
}

// transcriptEnd maps a closing record: a result's toolUseResult.status or a
// <task-notification>'s status and summary.
func transcriptEnd(status, summary string) runEnd {
	if status == "completed" {
		return runEnd{status: AgentDone, summary: summary}
	}
	return runEnd{status: AgentFailed, why: failText(status, summary, "")}
}

// transcriptLife applies a transcript record's lifecycle to a run no task frame has
// spoken for.
func (u *threadUsage) transcriptLife(r *runUsage, end runEnd) {
	if r.live || end.status == "" {
		return
	}
	before := r.info
	r.info.Status = end.status
	switch end.status {
	case AgentRunning:
		r.info.Error = ""
	case AgentDone:
		r.info.Summary, r.info.Error = cmp.Or(end.summary, r.info.Summary), ""
	case AgentFailed:
		r.info.Error = end.why
	}
	if !sameRunInfo(before, r.info) {
		u.changed = true
	}
}

// orphan fails every running run (only those no frame spoke for, with staleOnly): their
// process is gone. at is when (zero: unknown); it ends their running time too (the last
// progress is older). It returns the runs it failed.
func (u *threadUsage) orphan(why string, at time.Time, staleOnly bool) []AgentRun {
	var out []AgentRun
	for _, r := range u.runs {
		if r.info.Status != AgentRunning || (staleOnly && r.live) {
			continue
		}
		r.info.Status, r.info.Error = AgentFailed, why+orphanSuffix
		if !at.IsZero() {
			r.info.EndedAt = runTime(at)
			from := cmp.Or(r.info.ResumedAt, r.info.StartedAt)
			if ran := r.info.EndedAt.Sub(from).Milliseconds(); !from.IsZero() && ran > 0 {
				r.info.DurationMS = max(r.info.DurationMS, r.baseDurationMS+ran)
			}
		}
		r.notePending = false
		out = append(out, r.info)
	}
	if len(out) > 0 {
		u.changed = true
	}
	return out
}

// carry gives a run its lifecycle again after a rescan rebuilt the folds: prev is the
// saved run (or the replaced threadUsage's, with life). A run the rescan did not find
// is adopted whole.
func (u *threadUsage) carry(prev AgentRun, life agentLife) {
	r := u.runs[prev.ID]
	if r == nil {
		u.adopt(prev)
		u.runs[prev.ID].agentLife = life
		return
	}
	r.agentLife = life
	if prev.Status == "" {
		return
	}
	if !prev.StartedAt.IsZero() {
		r.info.StartedAt = prev.StartedAt
	}
	r.info.ParentID = cmp.Or(prev.ParentID, r.info.ParentID)
	r.info.Status, r.info.Activity, r.info.LastTool = prev.Status, prev.Activity, prev.LastTool
	r.info.TotalTokens, r.info.ToolUses, r.info.DurationMS = prev.TotalTokens, prev.ToolUses, prev.DurationMS
	r.info.Summary, r.info.Error = prev.Summary, prev.Error
	r.info.ResumedAt, r.info.EndedAt, r.info.NoteItemID = prev.ResumedAt, prev.EndedAt, prev.NoteItemID
	u.changed = true
}

// runList is the runs as published on the thread's log: by start time, without usage.
func (u *threadUsage) runList() []AgentRun {
	out := make([]AgentRun, 0, len(u.runs))
	for _, r := range u.runs {
		info := r.info
		info.Usage = nil
		out = append(out, info)
	}
	sortRuns(out)
	return out
}

// AgentsRunning counts the thread's running subagent runs: all of them, and those it
// launched in the background itself (spawn depth 1).
func (s Thread) AgentsRunning() (all, background int) {
	for _, r := range s.AgentRuns {
		if r.Status != AgentRunning {
			continue
		}
		all++
		if r.Background && r.SpawnDepth <= 1 {
			background++
		}
	}
	return all, background
}

// agentNoteMax bounds the report quoted in a note.
const agentNoteMax = 200

// agentNote is the note announcing a background run's end:
// "Agent finished · <name> · <report>" or "Agent failed · <name> · <error>".
func agentNote(r AgentRun) string {
	head, what := "Agent finished", r.Summary
	if r.Status == AgentFailed {
		head, what = "Agent failed", r.Error
	}
	parts := []string{head, cmp.Or(r.Description, r.AgentType, r.ID)}
	if line := noteLine(what); line != "" {
		parts = append(parts, line)
	}
	return strings.Join(parts, " · ")
}

// noteLine is s's first non-empty line, cut to agentNoteMax runes.
func noteLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			if rs := []rune(l); len(rs) > agentNoteMax {
				return string(rs[:agentNoteMax]) + "…"
			}
			return l
		}
	}
	return ""
}

// isAsyncLaunch reports whether a tool result says an Agent call went to the background
// (its result comes at once, status async_launched).
func isAsyncLaunch(raw json.RawMessage) bool {
	if len(raw) == 0 || !strings.Contains(string(raw), "async") {
		return false
	}
	var res toolUseResult
	unmarshalLoose(raw, &res)
	return res.Status == "async_launched" || res.IsAsync
}
