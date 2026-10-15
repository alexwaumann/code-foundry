package session

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

// testdata/runs.jsonl is cut from real transcripts (Claude Code 2.1.29x, October 2026),
// stripped to the fields run lifecycle reads (tool_use input without the prompt,
// toolUseResult without content and prompt, notification text without its result):
//
//	0 an Agent tool_use, foreground          (toolu_01WY88rdFs5yCT87eozT9dq1)
//	1 its tool_result: completed             (agent a7d1982fd1b785358)
//	2 an Agent tool_use, run_in_background   (toolu_01CgCYdhG99TjYHypgmM9geo)
//	3 its tool_result: async_launched        (agent a055747a7620ea4ef)
//	4 the run's <task-notification>, queue-operation enqueue
//	5 the same notification delivered as a user message
//	6 a SendMessage tool_result that resumed agent a1467bb316600eb5c
//	7 an Agent tool_result for an interrupted call (is_error, string toolUseResult,
//	  no agentId)                            (toolu_01MzYMFmL6XaHVGYVfEruVAD)
//	8 an assistant record from a subagent's own transcript (isSidechain, agentId)
func runLines(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "runs.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
}

const (
	capFgTool    = "toolu_01WY88rdFs5yCT87eozT9dq1"
	capFgAgent   = "a7d1982fd1b785358"
	capBgTool    = "toolu_01CgCYdhG99TjYHypgmM9geo"
	capBgAgent   = "a055747a7620ea4ef"
	capResumed   = "a1467bb316600eb5c"
	capErrorTool = "toolu_01MzYMFmL6XaHVGYVfEruVAD"
)

func TestParseRunEvents(t *testing.T) {
	c := runLines(t)
	all := func([]byte) bool { return true }
	tests := []struct {
		name      string
		line      string
		watched   func([]byte) bool
		notBefore time.Time
		want      []runEvent
	}{
		{name: "foreground spawn", line: c[0], want: []runEvent{{kind: runSpawned, toolUseID: capFgTool,
			description: "Sidebar toolbar + dashboard view", model: "opus", effort: "high"}}},
		{name: "completed", line: c[1], want: []runEvent{{kind: runResult, toolUseID: capFgTool, agentID: capFgAgent,
			status: "completed", agentType: "general-purpose"}}},
		{name: "background spawn", line: c[2], want: []runEvent{{kind: runSpawned, toolUseID: capBgTool, background: true,
			description: "PR 2: daemon skills/files RPCs", agentType: "claude", model: "opus", effort: "high"}}},
		{name: "async launched", line: c[3], want: []runEvent{{kind: runResult, toolUseID: capBgTool, agentID: capBgAgent,
			status: "async_launched", background: true, description: "PR 2: daemon skills/files RPCs"}}},
		{name: "notification enqueued", line: c[4], want: []runEvent{{kind: runNotified, agentID: capBgAgent, status: "completed", summary: `Agent "PR 2: daemon skills/files RPCs" finished`}}},
		{name: "notification delivered", line: c[5], want: []runEvent{{kind: runNotified, agentID: capBgAgent, status: "completed", summary: `Agent "PR 2: daemon skills/files RPCs" finished`}}},
		{name: "resumed by SendMessage", line: c[6], want: []runEvent{{kind: runResumed, toolUseID: "toolu_01ApXxee8WQSwYqaqtA8PFzg", agentID: capResumed}}},
		{name: "interrupted result, not watched", line: c[7]},
		{name: "interrupted result, watched", line: c[7], watched: all, want: []runEvent{{kind: runResult, toolUseID: capErrorTool}}},
		{name: "a run's usage record", line: c[8], watched: all},
		{name: "fork copy before notBefore", line: c[1], notBefore: time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)},
		{name: "not before the cutoff", line: c[1], notBefore: time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC),
			want: []runEvent{{kind: runResult, toolUseID: capFgTool, agentID: capFgAgent, status: "completed", agentType: "general-purpose"}}},
		{name: "other tool use", line: `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_x","name":"TaskOutput","input":{}}]}}`},
		{name: "other tool result", watched: all,
			line: `{"type":"user","message":{"content":[{"tool_use_id":"toolu_b","type":"tool_result","content":"ok"}]},"toolUseResult":{"stdout":"ok"}}`,
			want: []runEvent{{kind: runResult, toolUseID: "toolu_b"}}},
		{name: "a shell task's notification", line: `{"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>b8x1</task-id>\n<status>completed</status>\n</task-notification>"}}`,
			want: []runEvent{{kind: runNotified, agentID: "b8x1", status: "completed"}}},
		{name: "notification quoted in a prompt", line: `{"type":"user","message":{"role":"user","content":"look: <task-notification><task-id>a1</task-id>"}}`},
		{name: "dequeue", line: `{"type":"queue-operation","operation":"dequeue","content":"<task-notification>\n<task-id>a1</task-id>"}`},
		{name: "not json", line: `{"type":"assistant","name":"Agent"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseRunEvents([]byte(tt.line), tt.notBefore, tt.watched)
			for i := range got {
				if ts := lineTime([]byte(tt.line)); !got[i].at.Equal(ts) {
					t.Errorf("event %d at %v; want the record's %v", i, got[i].at, ts)
				}
				got[i].at = time.Time{}
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("parseRunEvents =\n %+v\nwant\n %+v", got, tt.want)
			}
		})
	}
}

var timestampField = regexp.MustCompile(`"timestamp":"[^"]*"`)

// stamp sets a captured line's timestamp.
func stamp(line string, at time.Time) string {
	return timestampField.ReplaceAllString(line, `"timestamp":"`+at.UTC().Format(time.RFC3339Nano)+`"`)
}

// tick advances the fixture's clock and stamps line with it: lines are written in
// time order, as Claude writes them.
func (fx *runFixture) tick(line string) string {
	fx.now = fx.now.Add(time.Second)
	return stamp(line, fx.now)
}

func (fx *runFixture) ticked(lines []string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = fx.tick(l)
	}
	return out
}

// ---- captured lines with other ids ----

func swap(line, from, to string) string { return strings.ReplaceAll(line, from, to) }

func spawnFg(c []string, tool string) string { return swap(c[0], capFgTool, tool) }
func spawnBg(c []string, tool string) string { return swap(c[2], capBgTool, tool) }
func completed(c []string, tool, agent string) string {
	return swap(swap(c[1], capFgTool, tool), capFgAgent, agent)
}
func launched(c []string, tool, agent string) string {
	return swap(swap(c[3], capBgTool, tool), capBgAgent, agent)
}
func notified(c []string, agent string) string      { return swap(c[5], capBgAgent, agent) }
func notifiedQueue(c []string, agent string) string { return swap(c[4], capBgAgent, agent) }
func resumed(c []string, agent string) string       { return swap(c[6], capResumed, agent) }
func interrupted(c []string, tool string) string    { return swap(c[7], capErrorTool, tool) }
func agentReq(agent, req string, ts time.Time) string {
	return usageLine(req, ts.UTC().Format(time.RFC3339Nano), "c1", "claude-haiku-5-5", 1, 10, 100, 0, h1(0), "standard")
}

// runFixture is a project dir with transcript c1 and its subagents/ directory, driven
// by hand through a threadUsage with a fake clock.
type runFixture struct {
	t    *testing.T
	dir  string
	sub  string
	now  time.Time
	u    *threadUsage
	f    *fileUsage
	reqs int
}

const fixtureCID = "c1"

func newRunFixture(t *testing.T) *runFixture {
	t.Helper()
	fx := &runFixture{t: t, dir: t.TempDir(), now: time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)}
	fx.sub = filepath.Join(fx.dir, fixtureCID, "subagents")
	if err := os.MkdirAll(fx.sub, 0o755); err != nil {
		t.Fatal(err)
	}
	fx.u = fx.fresh()
	fx.f = fx.u.file(fixtureCID, fx.parentPath())
	return fx
}

func (fx *runFixture) fresh() *threadUsage {
	return newThreadUsage(time.Time{}, func() time.Time { return fx.now }, time.Minute)
}

func (fx *runFixture) parentPath() string { return filepath.Join(fx.dir, fixtureCID+".jsonl") }

func appendLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	for _, l := range lines {
		if _, err := f.WriteString(l + "\n"); err != nil {
			t.Fatal(err)
		}
	}
}

// parent writes lines to the thread's transcript and feeds them live, then polls.
func (fx *runFixture) parent(lines ...string) {
	fx.t.Helper()
	lines = fx.ticked(lines)
	appendLines(fx.t, fx.parentPath(), lines...)
	for _, l := range lines {
		fx.u.transcriptLine(fx.f, []byte(l))
	}
	fx.u.poll()
}

func (fx *runFixture) meta(agent, tool string, depth int, shape string) {
	fx.t.Helper()
	m := fmt.Sprintf(`{"agentType":"general-purpose","description":"run %s","toolUseId":%q,"spawnDepth":%d,"requestShape":%q,"model":"haiku","effort":"medium"}`,
		agent, tool, depth, shape)
	if err := os.WriteFile(filepath.Join(fx.sub, "agent-"+agent+".meta.json"), []byte(m), 0o644); err != nil {
		fx.t.Fatal(err)
	}
}

// agent appends n requests (or the given lines when n is 0) to a run's transcript.
func (fx *runFixture) agent(agent string, n int, lines ...string) {
	fx.t.Helper()
	lines = fx.ticked(lines)
	for range n {
		fx.reqs++
		fx.now = fx.now.Add(time.Second)
		lines = append(lines, agentReq(agent, fmt.Sprintf("req-%s-%d", agent, fx.reqs), fx.now))
	}
	appendLines(fx.t, filepath.Join(fx.sub, "agent-"+agent+".jsonl"), lines...)
}

func (fx *runFixture) run(id string) (AgentRun, int64) {
	fx.t.Helper()
	r := fx.u.runs[id]
	if r == nil {
		fx.t.Fatalf("no run %s; runs = %v", id, fx.u.runs)
	}
	return r.info, r.fold.requests
}

func (fx *runFixture) wantRun(id string, open bool, requests int64) {
	fx.t.Helper()
	info, n := fx.run(id)
	if info.Open != open || n != requests {
		fx.t.Errorf("run %s: open %v, %d requests; want open %v, %d", id, info.Open, n, open, requests)
	}
}

func TestRunLifecycle(t *testing.T) {
	c := runLines(t)
	fx := newRunFixture(t)

	// Foreground: the spawn waits for its meta file; the run is followed from it until
	// its completed result, which drains it one last time.
	fx.parent(spawnFg(c, "T1"))
	if len(fx.u.runs) != 0 || len(fx.u.spawns) != 1 {
		t.Fatalf("after spawn: runs %v spawns %v", fx.u.runs, fx.u.spawns)
	}
	fx.meta("A1", "T1", 1, "foreground")
	fx.agent("A1", 1)
	fx.u.poll()
	fx.wantRun("A1", true, 1)
	fx.agent("A1", 1)
	fx.parent(completed(c, "T1", "A1"))
	fx.wantRun("A1", false, 2)
	fx.agent("A1", 1) // after its close: not followed
	fx.u.poll()
	fx.wantRun("A1", false, 2)
	if info, _ := fx.run("A1"); info.Description != "run A1" || info.Model != "haiku" || info.Background || info.StartedAt.IsZero() {
		t.Errorf("A1 = %+v", info)
	}

	// Background: async_launched keeps it open, the notification closes it.
	fx.meta("A2", "T2", 1, "background")
	fx.parent(spawnBg(c, "T2"), launched(c, "T2", "A2"))
	fx.wantRun("A2", true, 0)
	fx.agent("A2", 2)
	fx.u.poll()
	fx.wantRun("A2", true, 2)
	fx.agent("A2", 1)
	fx.parent(notified(c, "A2"))
	fx.wantRun("A2", false, 3)
	if info, _ := fx.run("A2"); !info.Background {
		t.Errorf("A2 = %+v", info)
	}

	// SendMessage resumes it: followed again from where it stopped, until the next
	// notification (here the queue-operation copy).
	fx.parent(resumed(c, "A2"))
	fx.wantRun("A2", true, 3)
	fx.agent("A2", 1)
	fx.u.poll()
	fx.wantRun("A2", true, 4)
	fx.parent(notifiedQueue(c, "A2"), notified(c, "A2"))
	fx.wantRun("A2", false, 4)

	// An interrupted call's result has no agentId: the spawn's tool use id closes it.
	fx.parent(spawnFg(c, "T3"))
	fx.meta("A3", "T3", 1, "foreground")
	fx.agent("A3", 1)
	fx.u.poll()
	fx.wantRun("A3", true, 1)
	fx.parent(interrupted(c, "T3"))
	fx.wantRun("A3", false, 1)

	// A run's own spawn (depth 2) is followed the same way, from the run's file.
	fx.parent(spawnFg(c, "T4"))
	fx.meta("A4", "T4", 1, "foreground")
	fx.agent("A4", 1, spawnFg(c, "T5"))
	fx.u.poll()
	fx.meta("A5", "T5", 2, "foreground")
	fx.agent("A5", 2)
	fx.u.poll()
	fx.wantRun("A5", true, 2)
	fx.agent("A4", 0, completed(c, "T5", "A5"))
	fx.u.poll()
	fx.wantRun("A5", false, 2)
	fx.parent(completed(c, "T4", "A4"))
	fx.wantRun("A4", false, 1)
	if info, _ := fx.run("A5"); info.SpawnDepth != 2 {
		t.Errorf("A5 depth = %d", info.SpawnDepth)
	}

	// A completed result for a run never seen (its spawn predates the fold): folded once.
	fx.agent("A6", 2)
	fx.parent(completed(c, "T6", "A6"))
	fx.wantRun("A6", false, 2)
	// A notification for a background shell (no such agent file) is ignored.
	fx.parent(notified(c, "bshell1"))
	if fx.u.runs["bshell1"] != nil {
		t.Error("a shell task became a run")
	}

	// Safety net: idle past the limit while the thread is at its prompt.
	fx.meta("A7", "T7", 1, "foreground")
	fx.meta("A8", "T8", 1, "background")
	fx.parent(spawnFg(c, "T7"), spawnBg(c, "T8"), launched(c, "T8", "A8"))
	fx.wantRun("A7", true, 0)
	fx.now = fx.now.Add(2 * time.Minute)
	fx.u.closeIdle(false)
	fx.wantRun("A7", true, 0)
	fx.u.closeIdle(true)
	fx.wantRun("A7", false, 0)
	fx.wantRun("A8", true, 0) // background: six times longer
	fx.now = fx.now.Add(5 * time.Minute)
	fx.u.closeIdle(true)
	fx.wantRun("A8", false, 0)

	// The total is every run's requests (the parent made none here).
	up := fx.u.snapshot()
	if got := totalRequests(up.total); got != int64(fx.reqs-1) { // A1's request after its close is not counted
		t.Errorf("total requests = %d; want %d", got, fx.reqs-1)
	}
	if len(up.runs) != 8 || up.sources[runSource("A1")] == nil {
		t.Errorf("snapshot runs = %d, sources = %v", len(up.runs), up.sources)
	}
	for i := 1; i < len(up.runs); i++ {
		if up.runs[i-1].StartedAt.After(up.runs[i].StartedAt) && !up.runs[i].StartedAt.IsZero() {
			t.Errorf("runs not by start time: %v then %v", up.runs[i-1].ID, up.runs[i].ID)
		}
	}
	if fx.u.changed || len(fx.u.dirty) != 0 {
		t.Error("snapshot left changes pending")
	}
}

// rescanFixture folds the fixture's files from byte zero, as runner.rescan does.
func (fx *runFixture) rescan() *threadUsage {
	fx.t.Helper()
	u := fx.fresh()
	f := u.file(fixtureCID, fx.parentPath())
	if err := scanLines(fx.parentPath(), 0, func(l []byte) { u.transcriptLine(f, l) }); err != nil {
		fx.t.Fatal(err)
	}
	u.settle()
	if u.err != nil {
		fx.t.Fatal(u.err)
	}
	return u
}

func TestRunRescan(t *testing.T) {
	c := runLines(t)
	fx := newRunFixture(t)
	own := usageLine("r-own", "2026-10-11T11:00:00Z", fixtureCID, "claude-opus-5-5", 1, 1, 1, 0, h1(0), "standard")
	appendLines(t, fx.parentPath(), fx.ticked([]string{
		own,
		spawnFg(c, "T1"), completed(c, "T1", "A1"), // closed
		spawnBg(c, "T2"), launched(c, "T2", "A2"), // background, no notification: open
		spawnBg(c, "T3"), launched(c, "T3", "A3"), notified(c, "A3"), // closed
		spawnFg(c, "T4"), // in flight: open
	})...)
	fx.meta("A1", "T1", 1, "foreground")
	fx.agent("A1", 2, spawnFg(c, "T5"), completed(c, "T5", "A5"))
	fx.meta("A5", "T5", 2, "foreground")
	fx.agent("A5", 1)
	fx.meta("A2", "T2", 1, "background")
	fx.agent("A2", 1)
	fx.meta("A3", "T3", 1, "background")
	fx.agent("A3", 1)
	fx.meta("A4", "T4", 1, "foreground")
	fx.agent("A4", 1, spawnFg(c, "T6"))
	fx.meta("A6", "T6", 2, "foreground") // in flight under an in-flight run: open
	fx.agent("A6", 1)
	fx.meta("A9", "T-gone", 3, "foreground") // nothing names it: folded, closed
	fx.agent("A9", 1)
	fx.agent("A10", 1) // no meta at all: folded, closed

	fx.u = fx.rescan()
	open := map[string]bool{"A2": true, "A4": true, "A6": true}
	for _, id := range []string{"A1", "A2", "A3", "A4", "A5", "A6", "A9", "A10"} {
		want := int64(1)
		if id == "A1" {
			want = 2
		}
		fx.wantRun(id, open[id], want)
	}
	if info, _ := fx.run("A6"); info.SpawnDepth != 2 {
		t.Errorf("A6 depth = %d", info.SpawnDepth)
	}
	up := fx.u.snapshot()
	if got := totalRequests(up.total); got != int64(fx.reqs)+1 {
		t.Errorf("rescanned total = %d; want %d", got, fx.reqs+1)
	}

	// Live from the rescan: the open runs are followed on.
	fx.f = fx.u.files[0]
	fx.agent("A2", 1)
	fx.agent("A6", 1)
	fx.u.poll()
	fx.wantRun("A2", true, 2)
	fx.wantRun("A6", true, 2)
	fx.parent(notified(c, "A2"))
	fx.wantRun("A2", false, 2)

	// A nested background run: launched in its parent run's file, its notification
	// enqueued in the thread's transcript (as Claude does). The rescan reads the
	// thread's file first, yet it ends closed: the older launch does not reopen it.
	fx.parent(spawnFg(c, "T7"))
	fx.meta("A7", "T7", 1, "foreground")
	fx.agent("A7", 1, spawnBg(c, "T8"))
	fx.meta("A8", "T8", 2, "background")
	fx.agent("A7", 0, launched(c, "T8", "A8"))
	fx.agent("A8", 1)
	fx.u.poll()
	fx.u.poll()
	fx.wantRun("A8", true, 1)
	fx.parent(notifiedQueue(c, "A8"))
	fx.wantRun("A8", false, 1)
	fx.agent("A7", 1)
	fx.parent(completed(c, "T7", "A7"))
	fx.wantRun("A7", false, 2)

	// And a second rescan of the same files agrees with the live state.
	again := fx.rescan()
	if !slices.Equal(again.snapshot().total, fx.u.snapshot().total) {
		t.Error("rescan disagrees with live")
	}
	for id, r := range again.runs {
		if live := fx.u.runs[id]; live == nil || live.info.Open != r.info.Open || live.fold.requests != r.fold.requests {
			t.Errorf("run %s: rescan %+v vs live %+v", id, r.info, live)
		}
	}
}

// ---- through the Manager: runner, persistence, restarts ----

func (e *env) writeAgent(cid, agent string, meta string, lines ...string) {
	e.t.Helper()
	sub := filepath.Join(e.paths.projectDir(e.wt), cid, "subagents")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		e.t.Fatal(err)
	}
	if meta != "" {
		if err := os.WriteFile(filepath.Join(sub, "agent-"+agent+".meta.json"), []byte(meta), 0o644); err != nil {
			e.t.Fatal(err)
		}
	}
	appendLines(e.t, filepath.Join(sub, "agent-"+agent+".jsonl"), lines...)
}

func (e *env) reconnect(id string) {
	e.t.Helper()
	s, _ := e.m.Get(e.ctx(), id)
	if s.State != StateDisconnected {
		e.exit(id, 0)
		e.waitFor(id, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	}
	if _, err := e.m.Reconnect(e.ctx(), id); err != nil {
		e.t.Fatal(err)
	}
}

func agentMetaJSON(tool string) string {
	return fmt.Sprintf(`{"agentType":"general-purpose","description":"say ok","toolUseId":%q,"spawnDepth":1,"requestShape":"foreground","model":"haiku","effort":"medium"}`, tool)
}

func TestAgentRunsRollUpAndPersist(t *testing.T) {
	c := runLines(t)
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "driver"})
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	now := time.Now()
	e.writeTranscript(cid, userLine("hi"), usageLine("r-1", now.UTC().Format(time.RFC3339Nano), cid, "claude-haiku-5-5", 1, 1, 1, 0, h1(0), "standard"),
		spawnFg(c, "T1"))
	e.writeAgent(cid, "A1", agentMetaJSON("T1"), userLine("say ok"), agentReq("A1", "a-1", now))
	got := e.waitFor(s.ID, "open run", func(s Session) bool {
		return len(s.AgentRuns) == 1 && s.AgentRuns[0].Open && totalRequests(s.Usage) == 2
	})
	if r := got.AgentRuns[0]; r.ID != "A1" || r.ToolUseID != "T1" || r.Description != "say ok" || r.ClaudeSessionID != cid || totalRequests(r.Usage) != 1 {
		t.Errorf("run = %+v", r)
	}
	e.writeAgent(cid, "A1", "", agentReq("A1", "a-2", now.Add(time.Second)))
	e.writeTranscript(cid, completed(c, "T1", "A1"))
	got = e.waitFor(s.ID, "closed run", func(s Session) bool {
		return len(s.AgentRuns) == 1 && !s.AgentRuns[0].Open && totalRequests(s.Usage) == 3
	})

	e.restart()
	after, err := e.m.Get(e.ctx(), s.ID)
	if err != nil || !slices.Equal(after.Usage, got.Usage) || !sameRuns(after.AgentRuns, got.AgentRuns) {
		t.Errorf("after restart = %+v %+v (%v); want %+v %+v", after.Usage, after.AgentRuns, err, got.Usage, got.AgentRuns)
	}

	// A reconnect rescans the transcript and every run file: the same numbers replace a
	// stale cached value.
	e.m.setUsage(s.ID, usageUpdate{total: []UsageBucket{{Model: "claude-haiku-5-5", Day: "2026-01-01", Requests: 99}}})
	e.reconnect(s.ID)
	e.waitFor(s.ID, "rescanned", func(s Session) bool {
		return slices.Equal(s.Usage, got.Usage) && sameRuns(s.AgentRuns, got.AgentRuns)
	})
}

func TestClearRescansEveryTranscript(t *testing.T) {
	c := runLines(t)
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "driver"})
	first := argOf(e.spec(s.ID).Argv, "--session-id")
	now := time.Now()
	req := func(id string, at time.Time) string {
		return usageLine(id, at.UTC().Format(time.RFC3339Nano), "x", "claude-haiku-5-5", 1, 1, 1, 0, h1(0), "standard")
	}
	// The run's files first, as Claude writes them: they are complete by the time the
	// transcript has the spawn's result. The runner drains a run one last time when that
	// result closes it and never again, so written the other way round a runner that
	// read the transcript between the meta file and the run's line (a loaded CI runner
	// under -race) closed the run empty and "first file" never came.
	e.writeAgent(first, "A1", agentMetaJSON("T1"))
	e.writeAgent(first, "A1", "", agentReq("A1", "a-1", now))
	e.writeTranscript(first, userLine("hi"), req("r-1", now), spawnFg(c, "T1"), completed(c, "T1", "A1"))
	e.waitFor(s.ID, "first file", func(s Session) bool { return totalRequests(s.Usage) == 2 })

	// /clear: Claude moves to a new id and file.
	pid := e.pid(s.ID)
	_ = os.MkdirAll(filepath.Join(e.paths.Dir, "sessions"), 0o755)
	if err := os.WriteFile(e.paths.pidFile(pid), []byte(fmt.Sprintf(`{"pid":%d,"sessionId":"cleared-id"}`, pid)), 0o644); err != nil {
		t.Fatal(err)
	}
	// No need to wait for the runner to see the pid file: it reads a newly followed
	// transcript from its start, whenever the file was written.
	e.writeTranscript("cleared-id", userLine("again"), req("r-2", now.Add(time.Second)))
	live := e.waitFor(s.ID, "both files", func(s Session) bool {
		return s.ClaudeSessionID == "cleared-id" && totalRequests(s.Usage) == 3
	})
	if !slices.Equal(live.Transcripts, []string{first, "cleared-id"}) {
		t.Errorf("transcripts = %v", live.Transcripts)
	}

	// Restart and reconnect (resume cleared-id): the rescan reads both files and the
	// run, and replaces a stale cached value instead of adding to it.
	e.restart()
	e.m.setUsage(s.ID, usageUpdate{total: []UsageBucket{{Model: "claude-haiku-5-5", Day: "2026-01-01", Requests: 99}}})
	e.reconnect(s.ID)
	got := e.waitFor(s.ID, "rescan of both files", func(s Session) bool { return slices.Equal(s.Usage, live.Usage) })
	if len(got.AgentRuns) != 1 || got.AgentRuns[0].Open {
		t.Errorf("runs = %+v", got.AgentRuns)
	}

	// Claude's cleanup deletes the first file and its run: their saved folds stand in.
	if err := os.RemoveAll(filepath.Join(e.paths.projectDir(e.wt), first)); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(e.paths.projectDir(e.wt), first+".jsonl")); err != nil {
		t.Fatal(err)
	}
	e.m.setUsage(s.ID, usageUpdate{total: []UsageBucket{{Model: "claude-haiku-5-5", Day: "2026-01-01", Requests: 99}}, runs: got.AgentRuns})
	e.reconnect(s.ID)
	e.waitFor(s.ID, "rescan with a deleted file", func(s Session) bool {
		return slices.Equal(s.Usage, live.Usage) && len(s.AgentRuns) == 1
	})
}
