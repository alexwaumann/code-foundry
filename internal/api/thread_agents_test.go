package api

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

func agentsSample(at time.Time) []session.AgentRun {
	return []session.AgentRun{
		{ID: "a1", ToolUseID: "toolu_1", Description: "Slow count", AgentType: "general-purpose", Model: "haiku", Effort: "low",
			Background: true, SpawnDepth: 1, Status: session.AgentRunning, Activity: "Running ls", LastTool: "Bash",
			TotalTokens: 14140, ToolUses: 1, DurationMS: 1380, StartedAt: at, ResumedAt: at.Add(time.Minute)},
		{ID: "a2", Description: "Outer", SpawnDepth: 1, Status: session.AgentDone, Summary: "outer done", StartedAt: at, EndedAt: at.Add(time.Second)},
		{ID: "a3", ParentID: "a2", Description: "Inner", SpawnDepth: 2, Status: session.AgentFailed, Error: "stopped", NoteItemID: "agent-1"},
		{ID: "a4", Status: "newer"},
	}
}

func TestThreadAgentsToProto(t *testing.T) {
	if threadAgentsToProto(nil) != nil {
		t.Error("no runs mapped to a list")
	}
	at := time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)
	p := threadAgentsToProto(agentsSample(at))
	if len(p) != 4 {
		t.Fatalf("runs %v", p)
	}
	a := p[0]
	if a.GetId() != "a1" || a.GetToolUseId() != "toolu_1" || a.GetModel() != "haiku" || a.GetEffort() != "low" || !a.GetBackground() ||
		a.GetStatus() != v1.ThreadAgentStatus_THREAD_AGENT_STATUS_RUNNING || a.GetActivity() != "Running ls" || a.GetLastTool() != "Bash" ||
		a.GetTotalTokens() != 14140 || a.GetToolUses() != 1 || a.GetDurationMs() != 1380 || !a.GetStartedAt().AsTime().Equal(at) ||
		!a.GetResumedAt().AsTime().Equal(at.Add(time.Minute)) || a.GetEndedAt() != nil {
		t.Errorf("running %v", a)
	}
	if b := p[1]; b.GetStatus() != v1.ThreadAgentStatus_THREAD_AGENT_STATUS_DONE || b.GetSummary() != "outer done" || b.GetResumedAt() != nil || b.GetEndedAt() == nil {
		t.Errorf("done %v", b)
	}
	if c := p[2]; c.GetStatus() != v1.ThreadAgentStatus_THREAD_AGENT_STATUS_FAILED || c.GetError() != "stopped" || c.GetParentId() != "a2" ||
		c.GetSpawnDepth() != 2 || c.GetNoteItemId() != "agent-1" || c.GetStartedAt() != nil {
		t.Errorf("failed %v", c)
	}
	if p[3].GetStatus() != v1.ThreadAgentStatus_THREAD_AGENT_STATUS_UNSPECIFIED {
		t.Errorf("unknown status %v", p[3])
	}
}

func TestSessionAgentCounts(t *testing.T) {
	runs := agentsSample(time.Now())
	runs = append(runs, session.AgentRun{ID: "a5", Background: true, SpawnDepth: 2, Status: session.AgentRunning})
	p := sessionToProto(session.Session{ID: "s1", AgentRuns: runs})
	if p.GetAgentsRunning() != 2 || p.GetBackgroundAgentsRunning() != 1 {
		t.Errorf("running %d, background %d", p.GetAgentsRunning(), p.GetBackgroundAgentsRunning())
	}
	want := []v1.AgentRunStatus{v1.AgentRunStatus_AGENT_RUN_STATUS_OPEN, v1.AgentRunStatus_AGENT_RUN_STATUS_CLOSED,
		v1.AgentRunStatus_AGENT_RUN_STATUS_CLOSED, v1.AgentRunStatus_AGENT_RUN_STATUS_CLOSED, v1.AgentRunStatus_AGENT_RUN_STATUS_OPEN}
	for i, r := range p.GetAgentRuns() {
		if r.GetStatus() != want[i] {
			t.Errorf("run %s status %v want %v", r.GetId(), r.GetStatus(), want[i])
		}
	}
	// A row from before the lifecycle (no status) follows Open.
	old := sessionToProto(session.Session{ID: "s2", AgentRuns: []session.AgentRun{{ID: "x", Open: true}}})
	if old.GetAgentRuns()[0].GetStatus() != v1.AgentRunStatus_AGENT_RUN_STATUS_OPEN {
		t.Errorf("old open run %v", old.GetAgentRuns()[0])
	}
}

func TestThreadAgentsWatch(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(session.Session{ID: "s1", State: session.StateConnected})
	fake.PutItems("s1", session.Item{ID: "u1", Kind: session.KindUserMessage, Text: "hi"})
	fake.PutAgents("s1", agentsSample(time.Now())[:1]...)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchThreadRequest{SessionId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	next := func() *v1.ThreadEvent {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg()
	}
	snap := next().GetSnapshot()
	if snap.GetSeq() != 2 || len(snap.GetAgents()) != 1 || snap.GetAgents()[0].GetDescription() != "Slow count" {
		t.Fatalf("snapshot %v", snap)
	}
	fake.PutAgents("s1", agentsSample(time.Now())...)
	ev := next().GetAgents()
	if ev.GetSessionId() != "s1" || ev.GetSeq() != 3 || len(ev.GetAgents()) != 4 {
		t.Errorf("event %v", ev)
	}
	list, err := c.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{SessionId: "s1"}))
	if err != nil || len(list.Msg.GetSnapshot().GetAgents()) != 4 {
		t.Errorf("list %v %v", list, err)
	}
}
