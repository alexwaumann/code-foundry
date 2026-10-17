package api

import (
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A thread's subagent runs (docs/notes/agents-1-daemon.md): ThreadItemsSnapshot.agents,
// ThreadEvent.agents, and the Thread's running counts.

var agentStatuses = map[thread.AgentStatus]v1.ThreadAgentStatus{
	thread.AgentRunning: v1.ThreadAgentStatus_THREAD_AGENT_STATUS_RUNNING,
	thread.AgentDone:    v1.ThreadAgentStatus_THREAD_AGENT_STATUS_DONE,
	thread.AgentFailed:  v1.ThreadAgentStatus_THREAD_AGENT_STATUS_FAILED,
}

// threadAgentsToProto maps a thread's runs, in their order.
func threadAgentsToProto(runs []thread.AgentRun) []*v1.ThreadAgentRun {
	if len(runs) == 0 {
		return nil
	}
	out := make([]*v1.ThreadAgentRun, len(runs))
	for i, r := range runs {
		out[i] = &v1.ThreadAgentRun{
			Id: r.ID, ToolUseId: r.ToolUseID, ParentId: r.ParentID, Description: r.Description, AgentType: r.AgentType,
			Model: r.Model, Effort: r.Effort, Background: r.Background, SpawnDepth: int32(r.SpawnDepth),
			Status: agentStatuses[r.Status], Activity: r.Activity, LastTool: r.LastTool,
			TotalTokens: r.TotalTokens, ToolUses: r.ToolUses, DurationMs: r.DurationMS,
			Summary: r.Summary, Error: r.Error, NoteItemId: r.NoteItemID,
			StartedAt: optTime(r.StartedAt), ResumedAt: optTime(r.ResumedAt), EndedAt: optTime(r.EndedAt),
		}
	}
	return out
}

// optTime is t on the wire, nil when zero.
func optTime(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}
