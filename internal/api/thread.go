package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// threadWatchBuffer is the per-stream backlog of thread events. Text deltas of every
// thread pass through each subscription, so it is larger than watchBuffer.
const threadWatchBuffer = 2048

// Thread implements codefoundryv1connect.ThreadServiceHandler over the thread store's
// thread methods.
type Thread struct {
	store thread.Store
	bus   *bus.Bus
	beat  time.Duration // WatchThread's heartbeat interval; zero is HeartbeatInterval (tests shorten it)
}

var _ codefoundryv1connect.ThreadServiceHandler = (*Thread)(nil)

// NewThread returns a ThreadService handler. b must be the bus the store publishes
// thread.ThreadEvent on.
func NewThread(store thread.Store, b *bus.Bus) *Thread { return &Thread{store: store, bus: b} }

// Route mounts the service.
func (h *Thread) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewThreadServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// ListItems returns a thread's items and pending requests.
func (h *Thread) ListItems(ctx context.Context, req *connect.Request[v1.ListThreadItemsRequest]) (*connect.Response[v1.ListThreadItemsResponse], error) {
	snap, err := h.store.Items(ctx, req.Msg.GetThreadId())
	if err != nil {
		return nil, threadError(err)
	}
	if q := req.Msg.GetQuery(); q != nil {
		// A page for an agent (thread_read.go).
		p, err := pageItems(snap.Items, q)
		if err != nil {
			return nil, threadError(err)
		}
		return connect.NewResponse(&v1.ListThreadItemsResponse{Page: pageToProto(snap.ThreadID, p)}), nil
	}
	return connect.NewResponse(&v1.ListThreadItemsResponse{Snapshot: itemsSnapshotToProto(snap)}), nil
}

// WatchThread sends the thread's snapshot, then its events. It counts as a viewer of the
// thread while open (Store.WatchItems). After dropped events it resends the snapshot.
// A quiet thread gets a heartbeat every HeartbeatInterval (see heartbeat.proto). The
// thread's removal ends the stream with the NOT_FOUND a new WatchThread would get, so a
// client stops retrying and lets the stream go.
func (h *Thread) WatchThread(ctx context.Context, req *connect.Request[v1.WatchThreadRequest], stream *connect.ServerStream[v1.ThreadEvent]) error {
	id := req.Msg.GetThreadId()
	// Subscribe first: events published between the snapshot and the loop are in the
	// queue, and their seq says whether the snapshot has them already. A removal
	// between the subscription and WatchItems fails WatchItems.
	gone := bus.Subscribe[thread.Event](h.bus, watchBuffer)
	defer gone.Close()
	sub := bus.Subscribe[thread.ThreadEvent](h.bus, threadWatchBuffer)
	defer sub.Close()
	snap, err := h.store.WatchItems(ctx, id)
	if err != nil {
		return threadError(err)
	}
	beat := newHeartbeat(h.beat)
	defer beat.Stop()
	send := func(msg *v1.ThreadEvent) error {
		beat.Reset()
		return stream.Send(msg)
	}
	if err := send(&v1.ThreadEvent{Event: &v1.ThreadEvent_Snapshot{Snapshot: itemsSnapshotToProto(snap)}}); err != nil {
		return err
	}
	seen := snap.Seq
	var dropped, goneDropped uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-gone.C():
			if !ok {
				return nil
			}
			removed := false
			if d := gone.Dropped(); d != goneDropped {
				goneDropped = d // missed events: ask the store
				_, ok := h.store.Snapshot().Thread(id)
				removed = !ok
			} else if r, ok := ev.(thread.Removed); ok && r.ID == id {
				removed = true
			}
			if removed {
				return h.watchGone(ctx, id)
			}
		case <-beat.C():
			if err := send(&v1.ThreadEvent{Event: &v1.ThreadEvent_Heartbeat{Heartbeat: &v1.StreamHeartbeat{}}}); err != nil {
				return err
			}
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if d := sub.Dropped(); d != dropped {
				dropped = d
				if snap, err = h.store.Items(ctx, id); err != nil {
					return threadError(err)
				}
				seen = snap.Seq
				if err := send(&v1.ThreadEvent{Event: &v1.ThreadEvent_Snapshot{Snapshot: itemsSnapshotToProto(snap)}}); err != nil {
					return err
				}
				continue
			}
			if ev.Thread() != id || threadSeq(ev) <= seen {
				continue
			}
			if msg := threadEventToProto(ev); msg != nil {
				if err := send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// watchGone is WatchThread's end for a thread that was removed: the store's NOT_FOUND
// (its tombstone when it keeps one).
func (h *Thread) watchGone(ctx context.Context, id string) error {
	if _, err := h.store.Items(ctx, id); err != nil {
		return threadError(err)
	}
	return threadError(fmt.Errorf("%w: thread %s was removed", thread.ErrNotFound, id))
}

// Send sends a user message.
func (h *Thread) Send(ctx context.Context, req *connect.Request[v1.SendThreadMessageRequest]) (*connect.Response[v1.SendThreadMessageResponse], error) {
	m := req.Msg
	it, err := h.store.Send(ctx, m.GetThreadId(), thread.Message{Text: m.GetText(), Attachments: m.GetAttachments(), ComposerText: m.GetComposerText()})
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SendThreadMessageResponse{Item: itemToProto(it)}), nil
}

// Respond answers a pending request.
func (h *Thread) Respond(ctx context.Context, req *connect.Request[v1.RespondThreadRequest]) (*connect.Response[v1.RespondThreadResponse], error) {
	m := req.Msg
	d := thread.Decision{Answers: m.GetAnswers(), Message: m.GetMessage(), Interrupt: m.GetInterrupt()}
	switch m.GetDecision() {
	case v1.ThreadDecision_THREAD_DECISION_ALLOW:
		d.Allow = true
	case v1.ThreadDecision_THREAD_DECISION_ALLOW_FOR_SESSION:
		d.Allow, d.ForSession = true, true
	case v1.ThreadDecision_THREAD_DECISION_DENY:
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, errDecision)
	}
	it, err := h.store.Respond(ctx, m.GetThreadId(), m.GetRequestId(), d)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RespondThreadResponse{Item: itemToProto(it)}), nil
}

var errDecision = errors.New("a decision is required: allow, allow for session, or deny")

// Interrupt stops the running turn.
func (h *Thread) Interrupt(ctx context.Context, req *connect.Request[v1.InterruptThreadRequest]) (*connect.Response[v1.InterruptThreadResponse], error) {
	if err := h.store.Interrupt(ctx, req.Msg.GetThreadId(), req.Msg.GetByThreadId()); err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.InterruptThreadResponse{}), nil
}

// SetModel switches the model.
func (h *Thread) SetModel(ctx context.Context, req *connect.Request[v1.SetThreadModelRequest]) (*connect.Response[v1.SetThreadModelResponse], error) {
	s, err := h.store.SetModel(ctx, req.Msg.GetThreadId(), req.Msg.GetModel())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SetThreadModelResponse{Thread: threadToProto(s)}), nil
}

// SetPermissionMode switches the permission mode.
func (h *Thread) SetPermissionMode(ctx context.Context, req *connect.Request[v1.SetThreadPermissionModeRequest]) (*connect.Response[v1.SetThreadPermissionModeResponse], error) {
	s, err := h.store.SetPermissionMode(ctx, req.Msg.GetThreadId(), thread.PermissionMode(req.Msg.GetPermissionMode()))
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SetThreadPermissionModeResponse{Thread: threadToProto(s)}), nil
}

// SetEffort changes the effort (a restart with --resume, now or after the turn).
func (h *Thread) SetEffort(ctx context.Context, req *connect.Request[v1.SetThreadEffortRequest]) (*connect.Response[v1.SetThreadEffortResponse], error) {
	s, err := h.store.SetEffort(ctx, req.Msg.GetThreadId(), req.Msg.GetEffort())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SetThreadEffortResponse{Thread: threadToProto(s)}), nil
}

// ---- mapping ----------------------------------------------------------------------

func threadSeq(ev thread.ThreadEvent) uint64 {
	switch e := ev.(type) {
	case thread.ItemAppended:
		return e.Seq
	case thread.ItemUpdated:
		return e.Seq
	case thread.ItemDelta:
		return e.Seq
	case thread.PendingChanged:
		return e.Seq
	case thread.McpChanged:
		return e.Seq
	case thread.SlashCommandsChanged:
		return e.Seq
	case thread.AgentsChanged:
		return e.Seq
	}
	return 0
}

// threadEventToProto converts a bus event to the wire event.
func threadEventToProto(ev thread.ThreadEvent) *v1.ThreadEvent {
	switch e := ev.(type) {
	case thread.ItemAppended:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Appended{Appended: &v1.ThreadItemChange{ThreadId: e.ThreadID, Seq: e.Seq, Item: itemToProto(e.Item)}}}
	case thread.ItemUpdated:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Updated{Updated: &v1.ThreadItemChange{ThreadId: e.ThreadID, Seq: e.Seq, Item: itemToProto(e.Item)}}}
	case thread.ItemDelta:
		f := v1.ThreadItemDelta_FIELD_TEXT
		if e.Field == thread.DeltaInput {
			f = v1.ThreadItemDelta_FIELD_INPUT
		}
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Delta{Delta: &v1.ThreadItemDelta{
			ThreadId: e.ThreadID, Seq: e.Seq, ItemId: e.ItemID, Ordinal: e.Ordinal, Field: f, Text: e.Text,
		}}}
	case thread.PendingChanged:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Pending{Pending: pendingToProto(e.ThreadID, e.Seq, e.Pending)}}
	case thread.McpChanged:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Mcp{Mcp: &v1.ThreadMcpChange{ThreadId: e.ThreadID, Seq: e.Seq, Status: mcpStatusToProto(e.Status)}}}
	case thread.SlashCommandsChanged:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Commands{Commands: &v1.ThreadSlashCommandsChange{ThreadId: e.ThreadID, Seq: e.Seq, Commands: slashCommandsToProto(e.Commands)}}}
	case thread.AgentsChanged:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Agents{Agents: &v1.ThreadAgentsChange{ThreadId: e.ThreadID, Seq: e.Seq, Agents: threadAgentsToProto(e.Agents)}}}
	}
	return nil
}

func itemsSnapshotToProto(s thread.ItemsSnapshot) *v1.ThreadItemsSnapshot {
	out := &v1.ThreadItemsSnapshot{ThreadId: s.ThreadID, Seq: s.Seq, Items: make([]*v1.ThreadItem, len(s.Items))}
	for i, it := range s.Items {
		out.Items[i] = itemToProto(it)
	}
	out.Pending = pendingToProto(s.ThreadID, s.Seq, s.Pending).GetPending()
	out.Mcp = mcpStatusToProto(s.Mcp)
	out.Commands = slashCommandsToProto(s.Commands)
	out.Agents = threadAgentsToProto(s.Agents)
	return out
}

func pendingToProto(id string, seq uint64, pending []thread.PendingRequest) *v1.ThreadPending {
	out := &v1.ThreadPending{ThreadId: id, Seq: seq}
	for _, p := range pending {
		out.Pending = append(out.Pending, &v1.ThreadPendingRequest{
			RequestId: p.RequestID, ItemId: p.ItemID, Question: p.Kind == thread.KindQuestion, ToolName: p.ToolName, Summary: p.Summary,
		})
	}
	return out
}

var toolStatuses = map[thread.ToolStatus]v1.ToolCallStatus{
	thread.ToolRunning: v1.ToolCallStatus_TOOL_CALL_STATUS_RUNNING,
	thread.ToolDone:    v1.ToolCallStatus_TOOL_CALL_STATUS_DONE,
	thread.ToolError:   v1.ToolCallStatus_TOOL_CALL_STATUS_ERROR,
}

var requestStates = map[thread.RequestState]v1.ThreadRequestState{
	thread.RequestPending:   v1.ThreadRequestState_THREAD_REQUEST_STATE_PENDING,
	thread.RequestAllowed:   v1.ThreadRequestState_THREAD_REQUEST_STATE_ALLOWED,
	thread.RequestDenied:    v1.ThreadRequestState_THREAD_REQUEST_STATE_DENIED,
	thread.RequestCancelled: v1.ThreadRequestState_THREAD_REQUEST_STATE_CANCELLED,
}

// itemToProto maps an item; an unknown kind maps to an item without a payload.
func itemToProto(it thread.Item) *v1.ThreadItem {
	p := &v1.ThreadItem{Id: it.ID, Ordinal: it.Ordinal, ParentToolUseId: it.ParentToolUseID, Streaming: it.Streaming, PlacedAfter: it.PlacedAfter}
	if !it.CreatedAt.IsZero() {
		p.CreatedAt = timestamppb.New(it.CreatedAt)
	}
	if !it.UpdatedAt.IsZero() {
		p.UpdatedAt = timestamppb.New(it.UpdatedAt)
	}
	switch it.Kind {
	case thread.KindUserMessage:
		p.Payload = &v1.ThreadItem_UserMessage{UserMessage: userMessageToProto(it)}
	case thread.KindAssistantText:
		p.Payload = &v1.ThreadItem_AssistantText{AssistantText: &v1.AssistantTextItem{Text: it.Text}}
	case thread.KindThinking:
		p.Payload = &v1.ThreadItem_Thinking{Thinking: &v1.ThinkingItem{Text: it.Text}}
	case thread.KindToolCall:
		if t := it.Tool; t != nil {
			p.Payload = &v1.ThreadItem_ToolCall{ToolCall: &v1.ToolCallItem{
				ToolUseId: t.ToolUseID, Name: t.Name, InputJson: t.InputJSON, Status: toolStatuses[t.Status],
				Output: t.Output, IsError: t.IsError, ResultJson: t.ResultJSON,
			}}
		}
	case thread.KindPermission, thread.KindQuestion:
		if r := it.Request; r != nil {
			rp := &v1.ThreadRequestItem{
				RequestId: r.RequestID, ToolName: r.ToolName, DisplayName: r.DisplayName, Title: r.Title,
				Description: r.Description, ToolUseId: r.ToolUseID, AgentId: r.AgentID, BlockedPath: r.BlockedPath,
				DecisionReason: r.DecisionReason, InputJson: r.InputJSON, SuggestionsJson: r.SuggestionsJSON,
				State: requestStates[r.State], Decision: r.Decision, Message: r.Message, Answers: r.Answers,
			}
			if it.Kind == thread.KindQuestion {
				p.Payload = &v1.ThreadItem_Question{Question: rp}
			} else {
				p.Payload = &v1.ThreadItem_Permission{Permission: rp}
			}
		}
	case thread.KindTurnEnd:
		if t := it.Turn; t != nil {
			p.Payload = &v1.ThreadItem_TurnEnd{TurnEnd: &v1.TurnEndItem{
				Subtype: t.Subtype, IsError: t.IsError, Interrupted: t.Interrupted, StopReason: t.StopReason,
				TerminalReason: t.TerminalReason, DurationMs: t.DurationMS, NumTurns: int32(t.NumTurns), CostUsd: t.CostUSD,
				InputTokens: t.InputTokens, OutputTokens: t.OutputTokens, CacheReadTokens: t.CacheReadTokens,
				CacheWriteTokens: t.CacheWriteTokens, Errors: t.Errors, TurnCostUsd: t.TurnCostUSD, Model: t.Model,
			}}
		}
	case thread.KindError:
		p.Payload = &v1.ThreadItem_Error{Error: &v1.ErrorItem{Text: it.Text}}
	case thread.KindCompaction:
		c := &v1.CompactionItem{Summary: it.Text}
		if it.Compaction != nil {
			c.Trigger, c.PreTokens, c.PostTokens = it.Compaction.Trigger, it.Compaction.PreTokens, it.Compaction.PostTokens
		}
		p.Payload = &v1.ThreadItem_Compaction{Compaction: c}
	case thread.KindCommandOutput:
		p.Payload = &v1.ThreadItem_CommandOutput{CommandOutput: &v1.CommandOutputItem{Text: it.Text}}
	case thread.KindNote:
		p.Payload = &v1.ThreadItem_Note{Note: &v1.NoteItem{Text: it.Text, CreatedBy: it.NoteCreatedBy}}
	case thread.KindHTML:
		if h := it.HTML; h != nil {
			p.Payload = &v1.ThreadItem_Html{Html: &v1.HtmlItem{Path: h.Path, Title: h.Title, BaseDir: h.BaseDir}}
		}
	case thread.KindTheme:
		if c := it.Theme; c != nil {
			p.Payload = &v1.ThreadItem_Theme{Theme: &v1.ThemeItem{Theme: theme.ToProto(c.File, ""), Applied: c.Applied, Previous: c.Previous}}
		}
	}
	return p
}
