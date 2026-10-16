package thread

import (
	"context"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Agent ids and tool uses in claudestream/testdata/agents.jsonl (Claude Code 2.1.299).
const (
	fxSlowCount  = "a143f862edc769de9" // background, woken again by SendMessage
	fxSlowTool   = "toolu_016ACK63yVNV4gQd5SLXVtAU"
	fxWakeTool   = "toolu_01DNbuneqKoogVQ4SRVMWozs" // the SendMessage
	fxOuter      = "a2fbfcc13c429d7ce"
	fxInner      = "a6e44aeab5faca0ee" // spawned by fxOuter
	fxShellTask  = "b0j67tk8w"         // a shell the background run started
	fxLongWait   = "a8625072e13dedaad" // agents-stop.jsonl
	fxLeftByPrev = "af2c22e8ba05a9386" // agents-resume.jsonl
)

func TestAgentStatusOf(t *testing.T) {
	for wire, want := range map[string]AgentStatus{
		"completed": AgentDone, "running": AgentRunning, "pending": AgentRunning,
		"failed": AgentFailed, "killed": AgentFailed, "stopped": AgentFailed, "something new": AgentFailed,
	} {
		if got := agentStatusOf(wire); got != want {
			t.Errorf("%q = %s, want %s", wire, got, want)
		}
	}
}

func TestFailTextAndNote(t *testing.T) {
	fails := []struct{ wire, report, desc, want string }{
		{"stopped", "Long wait", "Long wait", "stopped"}, // TaskStop: the summary is the name
		{"stopped", "Background agent \"x\" didn't finish", "x", "Background agent \"x\" didn't finish"},
		{"failed", "", "x", "failed"},
		{"", "  ", "x", "failed"},
	}
	for _, tt := range fails {
		if got := failText(tt.wire, tt.report, tt.desc); got != tt.want {
			t.Errorf("failText(%q, %q, %q) = %q, want %q", tt.wire, tt.report, tt.desc, got, tt.want)
		}
	}
	long := strings.Repeat("é", agentNoteMax+5)
	notes := []struct {
		run  AgentRun
		want string
	}{
		{AgentRun{Description: "Slow count", Status: AgentDone, Summary: "three"}, "Agent finished · Slow count · three"},
		{AgentRun{Description: "Long wait", Status: AgentFailed, Error: "stopped"}, "Agent failed · Long wait · stopped"},
		{AgentRun{AgentType: "Explore", Status: AgentDone}, "Agent finished · Explore"},
		{AgentRun{Description: "x", Status: AgentDone, Summary: "\n\n  first line  \nsecond"}, "Agent finished · x · first line"},
		{AgentRun{Description: "x", Status: AgentDone, Summary: long}, "Agent finished · x · " + strings.Repeat("é", agentNoteMax) + "…"},
	}
	for _, tt := range notes {
		if got := agentNote(tt.run); got != tt.want {
			t.Errorf("agentNote(%+v) = %q, want %q", tt.run, got, tt.want)
		}
	}
}

// taskFeed replays a captured stream through the projector and the agents model the
// way the runner does (onTask without its items and publication), recording what each
// task frame did.
type taskFeed struct {
	log     *threadLog
	u       *threadUsage
	changes map[string][]agentChange // by task id
}

func newTaskFeed(t *testing.T, u *threadUsage) *taskFeed {
	t.Helper()
	if u == nil {
		u = newThreadUsage(time.Time{}, time.Now, 0)
	}
	log := newThreadLog("s", bus.New(), time.Now, nil)
	return &taskFeed{log: log, u: u, changes: map[string][]agentChange{}}
}

func (f *taskFeed) play(t *testing.T, fixture string, upTo int) {
	t.Helper()
	data, err := os.ReadFile(fixturePath(fixture))
	if err != nil {
		t.Fatal(err)
	}
	p := newProjector(itemWriter{log: f.log, save: func(Item) {}}, runningTotals{known: true})
	where := func() (string, string) { return t.TempDir(), "cid" }
	spawn := func(id string) spawnInput {
		if it, ok := f.log.get(id); ok {
			return agentInput(it)
		}
		return spawnInput{}
	}
	var sp claudestream.Splitter
	for i, line := range sp.Split(nil, data) {
		if upTo >= 0 && i > upTo {
			break
		}
		ev := claudestream.Parse(line)
		p.event(ev)
		if tk, ok := ev.(*claudestream.Task); ok {
			f.changes[tk.TaskID] = append(f.changes[tk.TaskID], f.u.task(tk, time.Now(), where, spawn))
		}
	}
}

func (f *taskFeed) run(t *testing.T, id string) AgentRun {
	t.Helper()
	r, ok := f.u.runs[id]
	if !ok {
		t.Fatalf("no run %s (runs %v)", id, f.u.runList())
	}
	return r.info
}

func notes(chs []agentChange) int {
	n := 0
	for _, c := range chs {
		if c.note {
			n++
		}
	}
	return n
}

func TestAgentsFromCapturedFrames(t *testing.T) {
	// Up to the first turn's result: the background run is running, joined to its Agent
	// call's input.
	f := newTaskFeed(t, nil)
	f.play(t, "agents", 8)
	slow := f.run(t, fxSlowCount)
	if slow.Status != AgentRunning || !slow.Background || slow.Model != "haiku" || slow.AgentType != "general-purpose" ||
		slow.Description != "Slow count" || slow.ToolUseID != fxSlowTool || slow.SpawnDepth != 1 || slow.StartedAt.IsZero() {
		t.Errorf("after launch %+v", slow)
	}
	if ch := f.changes[fxSlowCount]; len(ch) != 1 || !ch[0].life {
		t.Errorf("task_started change %+v", ch)
	}

	// The whole capture.
	f = newTaskFeed(t, nil)
	f.play(t, "agents", -1)
	if _, ok := f.u.runs[fxShellTask]; ok {
		t.Errorf("the shell task became a run")
	}
	list := f.u.runList()
	ids := make([]string, len(list))
	for i, r := range list {
		ids[i] = r.ID
	}
	if !slices.Equal(ids, []string{fxSlowCount, fxOuter, fxInner}) {
		t.Errorf("order %v", ids)
	}
	slow = f.run(t, fxSlowCount)
	// Woken by SendMessage and ended again: the same run, its spawn's tool use kept,
	// counters summed over both wakes (2+1 tools, 9355+3114 ms), the latest report.
	if slow.Status != AgentDone || slow.Summary != "four" || slow.ToolUseID != fxSlowTool || slow.ResumedAt.IsZero() ||
		slow.ToolUses != 3 || slow.DurationMS != 9355+3114 || slow.TotalTokens != 16147 || slow.EndedAt.IsZero() || slow.Error != "" {
		t.Errorf("slow count %+v", slow)
	}
	if n := notes(f.changes[fxSlowCount]); n != 2 {
		t.Errorf("slow count notes = %d, want 2 (each end)", n)
	}
	outer, inner := f.run(t, fxOuter), f.run(t, fxInner)
	if outer.Status != AgentDone || outer.Summary != "outer done" || outer.Background || outer.ParentID != "" || outer.SpawnDepth != 1 {
		t.Errorf("outer %+v", outer)
	}
	if inner.Status != AgentDone || inner.Summary != "inner done" || inner.ParentID != fxOuter || inner.SpawnDepth != 2 || inner.LastTool != "SubagentHandback" {
		t.Errorf("inner %+v", inner)
	}
	if notes(f.changes[fxOuter])+notes(f.changes[fxInner]) != 0 {
		t.Errorf("foreground runs got notes")
	}

	// TaskStop: failed with Claude's word (its summary is the run's name), one note.
	f = newTaskFeed(t, nil)
	f.play(t, "agents-stop", -1)
	long := f.run(t, fxLongWait)
	if long.Status != AgentFailed || long.Error != "stopped" || long.EndedAt.IsZero() || notes(f.changes[fxLongWait]) != 1 {
		t.Errorf("long wait %+v, notes %d", long, notes(f.changes[fxLongWait]))
	}
}

// A thread reconnected after its process (and the background run in it) ended: the
// run was failed when the process went; the new process reports it stopped, which
// replaces the error without a second note.
func TestAgentsLeftByThePreviousProcess(t *testing.T) {
	u := newThreadUsage(time.Time{}, time.Now, 0)
	u.adopt(AgentRun{ID: fxLeftByPrev, Description: "Long wait", Background: true, SpawnDepth: 1, Status: AgentFailed,
		Error: orphanProcessEnded + orphanSuffix, StartedAt: time.Now().Add(-time.Minute)})
	f := newTaskFeed(t, u)
	f.play(t, "agents-resume", -1)
	run := f.run(t, fxLeftByPrev)
	if run.Status != AgentFailed || !strings.Contains(run.Error, "didn't finish before the previous session ended") {
		t.Errorf("run %+v", run)
	}
	if ch := f.changes[fxLeftByPrev]; len(ch) != 1 || ch[0].note || ch[0].ended || !ch[0].final || !ch[0].life {
		t.Errorf("changes %+v", ch)
	}
}

func TestAgentsOrphanAndCarry(t *testing.T) {
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	running := func(id string, live bool) *runUsage {
		return &runUsage{info: AgentRun{ID: id, Status: AgentRunning, Open: true}, agentLife: agentLife{live: live}}
	}
	u := newThreadUsage(time.Time{}, func() time.Time { return now }, 0)
	u.runs = map[string]*runUsage{"live": running("live", true), "stale": running("stale", false),
		"done": {info: AgentRun{ID: "done", Status: AgentDone}}}
	if got := u.orphan(orphanRescan, time.Time{}, true); len(got) != 1 || got[0].ID != "stale" {
		t.Fatalf("orphaned %+v", got)
	}
	if s := u.runs["stale"].info; s.Status != AgentFailed || s.Error != "the thread restarted before the agent finished" || !s.EndedAt.IsZero() {
		t.Errorf("stale %+v", s)
	}
	if u.runs["live"].info.Status != AgentRunning || u.runs["done"].info.Status != AgentDone {
		t.Errorf("staleOnly touched live or done runs")
	}
	u.runs["live"].info.StartedAt, u.runs["live"].info.DurationMS = now.Add(-90*time.Second), 1200 // its last progress
	u.orphan(orphanDaemonStopped, now, false)
	if l := u.runs["live"].info; l.Status != AgentFailed || l.Error != "the daemon stopped before the agent finished" || !l.EndedAt.Equal(now) ||
		l.DurationMS != 90_000 {
		t.Errorf("live %+v", l)
	}
	if got := u.orphan(orphanDaemonStopped, now, false); len(got) != 0 {
		t.Errorf("orphaned twice: %+v", got)
	}

	// carry: a rescanned run takes the saved lifecycle; a saved run the rescan did not
	// find is adopted whole.
	started := now.Add(-time.Hour)
	saved := AgentRun{ID: "r1", Description: "x", Status: AgentDone, Summary: "ok", StartedAt: started, ParentID: "p",
		ToolUses: 4, DurationMS: 900, TotalTokens: 1200, NoteItemID: "agent-1", EndedAt: now}
	u = newThreadUsage(time.Time{}, time.Now, 0)
	u.runs["r1"] = &runUsage{info: AgentRun{ID: "r1", Description: "x", Status: AgentDone, StartedAt: now}}
	u.carry(saved, agentLife{})
	u.carry(AgentRun{ID: "gone", Status: AgentFailed, Error: "e", Usage: []UsageBucket{{Model: "m", Day: "d", Requests: 1}}}, agentLife{live: true})
	r1 := u.runs["r1"].info
	if r1.Summary != "ok" || !r1.StartedAt.Equal(started) || r1.ParentID != "p" || r1.ToolUses != 4 || r1.NoteItemID != "agent-1" || !r1.EndedAt.Equal(now) {
		t.Errorf("carried %+v", r1)
	}
	if g := u.runs["gone"]; g == nil || g.info.Status != AgentFailed || !g.live || g.fold.requests != 1 {
		t.Errorf("adopted %+v", g)
	}
}

// Runs no task frame speaks for (an older Claude) follow their transcript.
func TestAgentsTranscriptLife(t *testing.T) {
	c := runLines(t)
	fx := newRunFixture(t)
	status := func(id string) AgentRun { info, _ := fx.run(id); return info }

	fx.parent(spawnFg(c, "T1"))
	fx.meta("A1", "T1", 1, "foreground")
	fx.agent("A1", 1)
	fx.u.poll()
	if s := status("A1"); s.Status != AgentRunning {
		t.Errorf("open foreground %+v", s)
	}
	fx.parent(completed(c, "T1", "A1"))
	if s := status("A1"); s.Status != AgentDone {
		t.Errorf("completed %+v", s)
	}
	fx.meta("A2", "T2", 1, "background")
	fx.parent(spawnBg(c, "T2"), launched(c, "T2", "A2"))
	if s := status("A2"); s.Status != AgentRunning {
		t.Errorf("launched %+v", s)
	}
	fx.parent(notified(c, "A2"))
	if s := status("A2"); s.Status != AgentDone || s.Summary == "" {
		t.Errorf("notified %+v", s)
	}
	fx.parent(resumed(c, "A2"))
	if s := status("A2"); s.Status != AgentRunning {
		t.Errorf("resumed %+v", s)
	}
	fx.parent(spawnFg(c, "T3"))
	fx.meta("A3", "T3", 1, "foreground")
	fx.agent("A3", 1)
	fx.u.poll()
	fx.parent(interrupted(c, "T3"))
	if s := status("A3"); s.Status != AgentFailed || s.Error == "" {
		t.Errorf("interrupted %+v", s)
	}

	// A frame makes a run live: the transcript no longer decides its status.
	fx.u.runs["A2"].live = true
	fx.parent(notifiedQueue(c, "A2"))
	if s := status("A2"); s.Status != AgentRunning {
		t.Errorf("live run's status followed the transcript: %+v", s)
	}

	// The idle safety net fails a run nothing speaks for and keeps following one the
	// stream says still runs.
	fx.meta("A4", "T4", 1, "foreground")
	fx.meta("A5", "T5", 1, "foreground")
	fx.parent(spawnFg(c, "T4"), spawnFg(c, "T5"))
	fx.wantRun("A4", true, 0)
	fx.u.runs["A5"].live = true
	fx.now = fx.now.Add(2 * time.Hour)
	fx.u.closeIdle(true)
	if s := status("A4"); s.Open || s.Status != AgentFailed || s.Error != "no result from Claude" {
		t.Errorf("idle run %+v", s)
	}
	if s := status("A5"); !s.Open || s.Status != AgentRunning {
		t.Errorf("live idle run %+v", s)
	}
}

// The runner publishes a lifecycle change at once and progress alone at most once per
// agentPublishGap; the Session and the thread log get the same list, persisted. The
// fake replays one turn per message: a start, then progress, then the end.
func TestAgentsPublication(t *testing.T) {
	const result = `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"num_turns":1,"result":"ok","session_id":"x","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}`
	progress := `{"type":"system","subtype":"task_progress","task_id":"a1","description":"Running ls","usage":{"total_tokens":100,"tool_uses":1,"duration_ms":50},"last_tool_name":"Bash"}`
	turns := []string{
		`{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_1","description":"Count","subagent_type":"general-purpose","is_backgrounded":true,"spawn_depth":1,"task_type":"local_agent"}`,
		result,
		progress,
		result,
		strings.Replace(progress, "Running ls", "Reading", 1),
		`{"type":"system","subtype":"task_notification","task_id":"a1","status":"completed","summary":"see report","handback_report":{"text":"all good"},"usage":{"total_tokens":120,"tool_uses":2,"duration_ms":80}}`,
		result,
	}
	path := t.TempDir() + "/agents-publish.jsonl"
	if err := os.WriteFile(path, []byte(strings.Join(turns, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC).UnixNano())
	e := newFixtureEnvAt(t, path, nil, func(o *Options) { o.Now = func() time.Time { return time.Unix(0, clock.Load()).UTC() } })
	sub := bus.Subscribe[ThreadEvent](e.bus, 256)
	defer sub.Close()
	agents := func() []AgentsChanged {
		var out []AgentsChanged
		for len(sub.C()) > 0 {
			if ev, ok := (<-sub.C()).(AgentsChanged); ok {
				out = append(out, ev)
			}
		}
		return out
	}
	turnEnds := func(n int) func([]Item) bool {
		return func(items []Item) bool {
			c := 0
			for _, it := range items {
				if it.Kind == KindTurnEnd {
					c++
				}
			}
			return c >= n
		}
	}

	s := e.create(CreateOptions{InitialPrompt: "go"})
	e.waitItems(s.ID, "first turn", turnEnds(1))
	if got := agents(); len(got) != 1 || len(got[0].Agents) != 1 || got[0].Agents[0].Status != AgentRunning {
		t.Fatalf("after start %+v", got)
	}
	if all, bg := e.waitFor(s.ID, "a run", func(s Thread) bool { return len(s.AgentRuns) == 1 }).AgentsRunning(); all != 1 || bg != 1 {
		t.Errorf("running %d, background %d", all, bg)
	}

	// Progress alone waits for the gap (the clock stands still; ticks run every 20ms).
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "more"}); err != nil {
		t.Fatal(err)
	}
	e.waitItems(s.ID, "second turn", turnEnds(2))
	time.Sleep(60 * time.Millisecond)
	if got := agents(); len(got) != 0 {
		t.Errorf("progress published before the gap: %+v", got)
	}
	clock.Add(int64(agentPublishGap / 2))
	time.Sleep(60 * time.Millisecond)
	if got := agents(); len(got) != 0 {
		t.Errorf("progress published before the gap: %+v", got)
	}
	clock.Add(int64(agentPublishGap))
	got := waitAgents(t, sub, s.ID, func(ev AgentsChanged) bool { return ev.Agents[0].Activity == "Running ls" })
	if a := got.Agents[0]; a.LastTool != "Bash" || a.ToolUses != 1 || a.TotalTokens != 100 || a.Status != AgentRunning {
		t.Errorf("flushed progress %+v", a)
	}

	// The end goes out at once, with the progress before it, in one event.
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "end"}); err != nil {
		t.Fatal(err)
	}
	items := e.waitItems(s.ID, "third turn", turnEnds(3))
	evs := agents()
	if len(evs) != 1 || evs[0].Agents[0].Status != AgentDone || evs[0].Agents[0].Summary != "all good" || evs[0].Agents[0].Activity != "Reading" {
		t.Fatalf("after notification %+v", evs)
	}
	if snap := e.items(s.ID); len(snap.Agents) != 1 || snap.Agents[0].Status != AgentDone || snap.Seq < evs[0].Seq {
		t.Errorf("snapshot agents %+v (seq %d, event %d)", snap.Agents, snap.Seq, evs[0].Seq)
	}
	// A background run's end is a note in the conversation, recorded on the run.
	note, ok := lastKind(items, KindNote)
	if !ok || note.Text != "Agent finished · Count · all good" {
		t.Errorf("note %+v\n%s", note, describeItems(items))
	}
	run := e.snapshot(s.ID).AgentRuns[0]
	if run.NoteItemID != note.ID || run.ToolUses != 2 || run.DurationMS != 80 || run.EndedAt.IsZero() {
		t.Errorf("thread run %+v", run)
	}
	if all, _ := e.snapshot(s.ID).AgentsRunning(); all != 0 {
		t.Errorf("still %d running", all)
	}

	// Persisted: a restart loads the run as it ended.
	e.restart()
	if got := e.snapshot(s.ID).AgentRuns; len(got) != 1 || got[0].Status != AgentDone || got[0].Summary != "all good" ||
		got[0].NoteItemID != note.ID || got[0].Description != "Count" || !got[0].Background || got[0].ToolUses != 2 {
		t.Errorf("after restart %+v", got)
	}
}

func waitAgents(t *testing.T, sub *bus.Subscription[ThreadEvent], id string, cond func(AgentsChanged) bool) AgentsChanged {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ev := <-sub.C():
			if a, ok := ev.(AgentsChanged); ok && a.ThreadID == id && cond(a) {
				return a
			}
		case <-deadline:
			t.Fatal("timed out waiting for AgentsChanged")
		}
	}
}

func (e *env) snapshot(id string) Thread {
	e.t.Helper()
	s, err := e.m.Get(context.Background(), id)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

// agentItem is the Agent call item with tool use id.
func agentItem(t *testing.T, items []Item, id string) Item {
	t.Helper()
	i := slices.IndexFunc(items, func(it Item) bool { return it.ID == id })
	if i < 0 || items[i].Tool == nil {
		t.Fatalf("no tool item %s\n%s", id, describeItems(items))
	}
	return items[i]
}

func noteItems(items []Item) []Item {
	var out []Item
	for _, it := range items {
		if it.Kind == KindNote {
			out = append(out, it)
		}
	}
	return out
}

func turnCount(n int) func([]Item) bool {
	return func(items []Item) bool {
		c := 0
		for _, it := range items {
			if it.Kind == KindTurnEnd {
				c++
			}
		}
		return c >= n
	}
}

// The capture through the runner (the fake replays one turn per message): a
// background run keeps its Agent call running past the turn and ends with a note; a
// nested pair; the background run woken by SendMessage ends with a second note.
func TestAgentsThroughTheStream(t *testing.T) {
	e := newFixtureEnv(t, "agents")
	s := e.create(CreateOptions{InitialPrompt: "launch"})
	send := func(text string, turns int) []Item {
		t.Helper()
		if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: text}); err != nil {
			t.Fatal(err)
		}
		return e.waitItems(s.ID, text, turnCount(turns))
	}

	items := e.waitItems(s.ID, "launched", turnCount(1))
	if it := agentItem(t, items, fxSlowTool); it.Tool.Status != ToolRunning || !strings.Contains(it.Tool.Output, "Async agent launched") {
		t.Errorf("background Agent call after its turn %+v", it.Tool)
	}
	got := e.waitFor(s.ID, "running", func(s Thread) bool { all, bg := s.AgentsRunning(); return all == 1 && bg == 1 })
	if r := got.AgentRuns[0]; r.ID != fxSlowCount || r.Status != AgentRunning || r.Model != "haiku" {
		t.Errorf("run %+v", r)
	}

	// The run ends (Claude then starts a turn of its own): done, the call with it, a
	// note at that point of the conversation.
	items = send("next", 2)
	notes := noteItems(items)
	if len(notes) != 1 || notes[0].Text != "Agent finished · Slow count · three" {
		t.Fatalf("notes %+v\n%s", notes, describeItems(items))
	}
	if it := agentItem(t, items, fxSlowTool); it.Tool.Status != ToolDone || it.Tool.Output != "three" {
		t.Errorf("Agent call after the run %+v", it.Tool)
	}
	if notes[0].Ordinal > items[len(items)-1].Ordinal {
		t.Errorf("note after the turn it preceded")
	}
	snap := e.items(s.ID)
	if len(snap.Agents) != 1 || snap.Agents[0].NoteItemID != notes[0].ID || snap.Agents[0].Status != AgentDone {
		t.Errorf("agents %+v", snap.Agents)
	}

	send("empty", 3)
	items = send("nested", 4)
	snap = e.items(s.ID)
	if len(snap.Agents) != 3 || snap.Agents[1].ID != fxOuter || snap.Agents[2].ID != fxInner || snap.Agents[2].ParentID != fxOuter {
		t.Fatalf("agents %+v", snap.Agents)
	}
	if len(noteItems(items)) != 1 {
		t.Errorf("foreground runs added notes")
	}

	// Woken by SendMessage: running again in place, then done with a second note.
	send("wake", 5)
	wake := e.items(s.ID).Agents[0]
	if wake.ID != fxSlowCount || wake.ResumedAt.IsZero() {
		t.Errorf("woken run %+v", wake)
	}
	items = send("report", 6)
	notes = noteItems(items)
	final := e.items(s.ID).Agents[0]
	if len(notes) != 2 || notes[1].Text != "Agent finished · Slow count · four" || final.NoteItemID != notes[1].ID || final.Status != AgentDone {
		t.Errorf("notes %+v run %+v", notes, final)
	}
	if it := agentItem(t, items, fxSlowTool); it.Tool.Output != "three" {
		t.Errorf("the first call followed the wake: %+v", it.Tool)
	}
	if it := agentItem(t, items, fxWakeTool); it.Tool.Name != "SendMessage" || it.Tool.Status != ToolDone {
		t.Errorf("SendMessage call %+v", it.Tool)
	}
}

// Subagents run inside the thread's process: when it ends, or the daemon stops, or the
// daemon died, the runs it left running fail.
func TestAgentsOrphaned(t *testing.T) {
	t.Run("process ended", func(t *testing.T) {
		e := newFixtureEnv(t, "agents")
		s := e.create(CreateOptions{InitialPrompt: "launch"})
		e.waitItems(s.ID, "launched", turnCount(1))
		e.waitFor(s.ID, "running", func(s Thread) bool { all, _ := s.AgentsRunning(); return all == 1 })
		e.exit(s.ID, 0)
		got := e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })
		if r := got.AgentRuns[0]; r.Status != AgentFailed || r.Error != "the thread's process ended before the agent finished" || r.EndedAt.IsZero() {
			t.Errorf("run %+v", r)
		}
		if it := agentItem(t, e.items(s.ID).Items, fxSlowTool); it.Tool.Status != ToolError || !it.Tool.IsError ||
			it.Tool.Output != "the thread's process ended before the agent finished" {
			t.Errorf("Agent call %+v", it.Tool)
		}
		if a := e.items(s.ID).Agents; len(a) != 1 || a[0].Status != AgentFailed {
			t.Errorf("log agents %+v", a)
		}
	})
	t.Run("daemon stopped", func(t *testing.T) {
		e := newFixtureEnv(t, "agents")
		s := e.create(CreateOptions{InitialPrompt: "launch"})
		e.waitItems(s.ID, "launched", turnCount(1))
		e.waitFor(s.ID, "running", func(s Thread) bool { all, _ := s.AgentsRunning(); return all == 1 })
		e.restart()
		if r := e.snapshot(s.ID).AgentRuns; len(r) != 1 || r[0].Status != AgentFailed || r[0].Error != "the daemon stopped before the agent finished" {
			t.Errorf("runs %+v", r)
		}
		if a := e.items(s.ID).Agents; len(a) != 1 || a[0].Status != AgentFailed {
			t.Errorf("log agents after restart %+v", a)
		}
	})
	t.Run("daemon died", func(t *testing.T) {
		e := newEnv(t)
		s := e.create(CreateOptions{Name: "x"})
		e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
		// What a crash leaves: a row saved as running.
		if err := saveAgentRuns(context.Background(), e.m.opts.DB, s.ID, []AgentRun{{ID: "a1", Description: "d", Status: AgentRunning, SpawnDepth: 1}}); err != nil {
			t.Fatal(err)
		}
		e.restart()
		if r := e.snapshot(s.ID).AgentRuns; len(r) != 1 || r[0].Status != AgentFailed || r[0].Error != "the daemon restarted before the agent finished" {
			t.Errorf("runs %+v", r)
		}
	})
}
