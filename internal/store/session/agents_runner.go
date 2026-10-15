package session

import (
	"context"
	"slices"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// The runner's half of the agents model (agents.go): task frames in, items and
// publication out.
//
// Publication goes through publishUsage (runner.go), the one path that replaces the
// Session's AgentRuns (and persists the changed runs) and then the thread log's list
// (AgentsChanged). A lifecycle change publishes at once; progress alone (task_progress
// comes per tool call) at most once per agentPublishGap, the rest on the next tick.

// agentPublishGap is the least time between two publications made only for progress.
const agentPublishGap = time.Second

// AgentsChanged is published on the bus (as a ThreadEvent) when a thread's subagent
// runs changed: the whole list, in spawn order, without usage.
type AgentsChanged struct {
	SessionID string
	Seq       uint64
	Agents    []AgentRun
}

func (AgentsChanged) isThreadEvent() {}

// Thread implements ThreadEvent.
func (e AgentsChanged) Thread() string { return e.SessionID }

// logAgents is runs as the thread log keeps them: without usage (a new slice).
func logAgents(runs []AgentRun) []AgentRun {
	if len(runs) == 0 {
		return nil
	}
	out := slices.Clone(runs)
	for i := range out {
		out[i].Usage = nil
	}
	return out
}

// setAgents replaces the thread's runs and publishes them, unless nothing changed.
func (t *threadLog) setAgents(runs []AgentRun) {
	runs = logAgents(runs)
	t.mu.Lock()
	defer t.mu.Unlock()
	if slices.EqualFunc(t.agents, runs, sameRunInfo) {
		return
	}
	t.agents = runs
	t.seq++
	bus.Publish[ThreadEvent](t.bus, AgentsChanged{SessionID: t.id, Seq: t.seq, Agents: runs})
}

// onTask applies a task frame: the run's record, the Agent call's item when a
// background run ends, the note announcing it, then publication.
func (r *runner) onTask(t *claudestream.Task) {
	ch := r.usage.task(t, r.m.opts.Now(), r.subagentsWhere, r.spawnInput)
	run := ch.run
	if run == nil {
		return
	}
	if (ch.ended || ch.final) && run.info.Status != AgentRunning && run.info.ToolUseID != "" {
		out, failed := run.info.Summary, run.info.Status == AgentFailed
		if failed {
			out = run.info.Error
		}
		r.st.proj.agentEnded(run.info.ToolUseID, failed, out, ch.final)
	}
	if ch.note {
		it := r.st.proj.w.add(Item{ID: r.st.proj.nextID("agent"), Kind: KindNote, Text: agentNote(run.info)})
		run.info.NoteItemID = it.ID
		r.usage.changed = true
	}
	r.publishUsage()
}

// subagentsWhere is where a run met first in a task frame lives: the subagents
// directory of the transcript the conversation is in.
func (r *runner) subagentsWhere() (dir, cid string) {
	cid = r.tail.id
	path := r.tail.path
	if path == "" {
		path, _ = r.m.opts.Paths.transcriptPath(r.cwd, cid)
	}
	return subagentsDir(path, cid), cid
}

// spawnInput looks up a tool use's item (the Agent call precedes its task_started on
// the stream).
func (r *runner) spawnInput(toolUseID string) spawnInput {
	if toolUseID == "" {
		return spawnInput{}
	}
	it, ok := r.st.log.get(toolUseID)
	if !ok {
		return spawnInput{}
	}
	return agentInput(it)
}

// endRuns fails the runs still running: their process is gone (why), so they cannot
// finish. closeUnfinished already made their background Agent calls errors; the error
// becomes their output (it kept the launch's).
func (r *runner) endRuns(why string) {
	ended := r.usage.orphan(why, r.m.opts.Now(), false)
	for _, run := range ended {
		if run.ToolUseID != "" {
			r.st.proj.agentEnded(run.ToolUseID, true, run.Error, true)
		}
	}
	if len(ended) > 0 {
		r.publishUsage()
	}
}

// carryRuns gives the runs of a rescan (u, which replaces r.usage) their lifecycle:
// the saved runs' and, for runs a frame spoke for in this runner, the live state. Runs
// that are running only by their transcripts' account are from a process that is gone.
func (r *runner) carryRuns(u *threadUsage, saved []AgentRun) {
	carried := map[string]bool{}
	for _, run := range saved {
		var life agentLife
		if old := r.usage.runs[run.ID]; old != nil && old.live {
			info := old.info
			info.Usage = run.Usage
			run, life = info, old.agentLife
		}
		u.carry(run, life)
		carried[run.ID] = true
	}
	for id, old := range r.usage.runs {
		if old.live && !carried[id] {
			info := old.info
			info.Usage = old.fold.Buckets()
			u.carry(info, old.agentLife)
		}
	}
	u.orphan(orphanRescan, time.Time{}, true)
}

// agentEnded completes the item of a background Agent call whose run ended (failed:
// an error with the error as output; else done with the report). final: the run's
// notification, after which the item no longer follows the run (a later wake is the
// SendMessage call's).
func (p *projector) agentEnded(toolUseID string, failed bool, output string, final bool) {
	if !p.async[toolUseID] {
		return
	}
	if final {
		delete(p.async, toolUseID)
	}
	cur, ok := p.w.log.get(toolUseID)
	if !ok || cur.Tool == nil {
		return
	}
	want := ToolDone
	if failed {
		want = ToolError
	}
	output = capOutput(output)
	if cur.Tool.Status == want && cur.Tool.IsError == failed && (output == "" || cur.Tool.Output == output) {
		return
	}
	p.w.change(toolUseID, func(it *Item) {
		it.Tool.Status, it.Tool.IsError = want, failed
		if output != "" {
			it.Tool.Output = output
		}
	})
}

// setAgentRuns replaces a session's runs' records while its usage cannot be published
// (a rescan failed: runner.usageOff): each run keeps the usage the session has.
func (m *Manager) setAgentRuns(id string, runs []AgentRun) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	next := make([]AgentRun, len(runs))
	var changed []AgentRun
	for i, run := range runs {
		run.Usage = nil
		if j := slices.IndexFunc(rec.s.AgentRuns, func(o AgentRun) bool { return o.ID == run.ID }); j >= 0 {
			run.Usage = rec.s.AgentRuns[j].Usage
			if sameRunInfo(rec.s.AgentRuns[j], run) {
				next[i] = run
				continue
			}
		}
		next[i] = run
		changed = append(changed, run)
	}
	if len(changed) == 0 && len(next) == len(rec.s.AgentRuns) {
		return
	}
	if err := saveAgentRuns(context.Background(), m.opts.DB, id, changed); err != nil {
		m.log.Error("persist agent runs", "session", id, "err", err)
	}
	rec.s.AgentRuns = next
	m.commitLocked(rec, false)
}
