package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

// threadWatchBuffer is the per-stream backlog of thread events. Text deltas of every
// thread pass through each subscription, so it is larger than watchBuffer.
const threadWatchBuffer = 2048

// Thread implements codefoundryv1connect.ThreadServiceHandler over the session store's
// thread methods.
type Thread struct {
	store session.Store
	bus   *bus.Bus
}

var _ codefoundryv1connect.ThreadServiceHandler = (*Thread)(nil)

// NewThread returns a ThreadService handler. b must be the bus the store publishes
// session.ThreadEvent on.
func NewThread(store session.Store, b *bus.Bus) *Thread { return &Thread{store: store, bus: b} }

// Route mounts the service.
func (h *Thread) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewThreadServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// ListItems returns a thread's items and pending requests.
func (h *Thread) ListItems(ctx context.Context, req *connect.Request[v1.ListThreadItemsRequest]) (*connect.Response[v1.ListThreadItemsResponse], error) {
	snap, err := h.store.Items(ctx, req.Msg.GetSessionId())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.ListThreadItemsResponse{Snapshot: itemsSnapshotToProto(snap)}), nil
}

// Watch sends the thread's snapshot, then its events. It counts as a viewer of the
// thread while open (Store.WatchItems). After dropped events it resends the snapshot.
func (h *Thread) Watch(ctx context.Context, req *connect.Request[v1.WatchThreadRequest], stream *connect.ServerStream[v1.ThreadEvent]) error {
	id := req.Msg.GetSessionId()
	// Subscribe first: events published between the snapshot and the loop are in the
	// queue, and their seq says whether the snapshot has them already.
	sub := bus.Subscribe[session.ThreadEvent](h.bus, threadWatchBuffer)
	defer sub.Close()
	snap, err := h.store.WatchItems(ctx, id)
	if err != nil {
		return sessionError(err)
	}
	if err := stream.Send(&v1.ThreadEvent{Event: &v1.ThreadEvent_Snapshot{Snapshot: itemsSnapshotToProto(snap)}}); err != nil {
		return err
	}
	seen := snap.Seq
	var dropped uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if d := sub.Dropped(); d != dropped {
				dropped = d
				if snap, err = h.store.Items(ctx, id); err != nil {
					return sessionError(err)
				}
				seen = snap.Seq
				if err := stream.Send(&v1.ThreadEvent{Event: &v1.ThreadEvent_Snapshot{Snapshot: itemsSnapshotToProto(snap)}}); err != nil {
					return err
				}
				continue
			}
			if ev.Thread() != id || threadSeq(ev) <= seen {
				continue
			}
			if msg := threadEventToProto(ev); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// Send sends a user message.
func (h *Thread) Send(ctx context.Context, req *connect.Request[v1.SendThreadMessageRequest]) (*connect.Response[v1.SendThreadMessageResponse], error) {
	m := req.Msg
	it, err := h.store.Send(ctx, m.GetSessionId(), session.Message{Text: m.GetText(), Attachments: m.GetAttachments(), ComposerText: m.GetComposerText()})
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.SendThreadMessageResponse{Item: itemToProto(it)}), nil
}

// Respond answers a pending request.
func (h *Thread) Respond(ctx context.Context, req *connect.Request[v1.RespondThreadRequest]) (*connect.Response[v1.RespondThreadResponse], error) {
	m := req.Msg
	d := session.Decision{Answers: m.GetAnswers(), Message: m.GetMessage(), Interrupt: m.GetInterrupt()}
	switch m.GetDecision() {
	case v1.ThreadDecision_THREAD_DECISION_ALLOW:
		d.Allow = true
	case v1.ThreadDecision_THREAD_DECISION_ALLOW_FOR_SESSION:
		d.Allow, d.ForSession = true, true
	case v1.ThreadDecision_THREAD_DECISION_DENY:
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, errDecision)
	}
	it, err := h.store.Respond(ctx, m.GetSessionId(), m.GetRequestId(), d)
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.RespondThreadResponse{Item: itemToProto(it)}), nil
}

var errDecision = errors.New("a decision is required: allow, allow for session, or deny")

// Interrupt stops the running turn.
func (h *Thread) Interrupt(ctx context.Context, req *connect.Request[v1.InterruptThreadRequest]) (*connect.Response[v1.InterruptThreadResponse], error) {
	if err := h.store.Interrupt(ctx, req.Msg.GetSessionId()); err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.InterruptThreadResponse{}), nil
}

// SetModel switches the model.
func (h *Thread) SetModel(ctx context.Context, req *connect.Request[v1.SetThreadModelRequest]) (*connect.Response[v1.SetThreadModelResponse], error) {
	s, err := h.store.SetModel(ctx, req.Msg.GetSessionId(), req.Msg.GetModel())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.SetThreadModelResponse{Session: sessionToProto(s)}), nil
}

// SetPermissionMode switches the permission mode.
func (h *Thread) SetPermissionMode(ctx context.Context, req *connect.Request[v1.SetThreadPermissionModeRequest]) (*connect.Response[v1.SetThreadPermissionModeResponse], error) {
	s, err := h.store.SetPermissionMode(ctx, req.Msg.GetSessionId(), session.PermissionMode(req.Msg.GetPermissionMode()))
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.SetThreadPermissionModeResponse{Session: sessionToProto(s)}), nil
}

// SetEffort changes the effort (a restart with --resume, now or after the turn).
func (h *Thread) SetEffort(ctx context.Context, req *connect.Request[v1.SetThreadEffortRequest]) (*connect.Response[v1.SetThreadEffortResponse], error) {
	s, err := h.store.SetEffort(ctx, req.Msg.GetSessionId(), req.Msg.GetEffort())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.SetThreadEffortResponse{Session: sessionToProto(s)}), nil
}

// ---- mapping ----------------------------------------------------------------------

func threadSeq(ev session.ThreadEvent) uint64 {
	switch e := ev.(type) {
	case session.ItemAppended:
		return e.Seq
	case session.ItemUpdated:
		return e.Seq
	case session.ItemDelta:
		return e.Seq
	case session.PendingChanged:
		return e.Seq
	case session.McpChanged:
		return e.Seq
	case session.SlashCommandsChanged:
		return e.Seq
	}
	return 0
}

// threadEventToProto converts a bus event to the wire event.
func threadEventToProto(ev session.ThreadEvent) *v1.ThreadEvent {
	switch e := ev.(type) {
	case session.ItemAppended:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Appended{Appended: &v1.ThreadItemChange{SessionId: e.SessionID, Seq: e.Seq, Item: itemToProto(e.Item)}}}
	case session.ItemUpdated:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Updated{Updated: &v1.ThreadItemChange{SessionId: e.SessionID, Seq: e.Seq, Item: itemToProto(e.Item)}}}
	case session.ItemDelta:
		f := v1.ThreadItemDelta_FIELD_TEXT
		if e.Field == session.DeltaInput {
			f = v1.ThreadItemDelta_FIELD_INPUT
		}
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Delta{Delta: &v1.ThreadItemDelta{
			SessionId: e.SessionID, Seq: e.Seq, ItemId: e.ItemID, Ordinal: e.Ordinal, Field: f, Text: e.Text,
		}}}
	case session.PendingChanged:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Pending{Pending: pendingToProto(e.SessionID, e.Seq, e.Pending)}}
	case session.McpChanged:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Mcp{Mcp: &v1.ThreadMcpChange{SessionId: e.SessionID, Seq: e.Seq, Status: mcpStatusToProto(e.Status)}}}
	case session.SlashCommandsChanged:
		return &v1.ThreadEvent{Event: &v1.ThreadEvent_Commands{Commands: &v1.ThreadSlashCommandsChange{SessionId: e.SessionID, Seq: e.Seq, Commands: slashCommandsToProto(e.Commands)}}}
	}
	return nil
}

func itemsSnapshotToProto(s session.ItemsSnapshot) *v1.ThreadItemsSnapshot {
	out := &v1.ThreadItemsSnapshot{SessionId: s.SessionID, Seq: s.Seq, Items: make([]*v1.ThreadItem, len(s.Items))}
	for i, it := range s.Items {
		out.Items[i] = itemToProto(it)
	}
	out.Pending = pendingToProto(s.SessionID, s.Seq, s.Pending).GetPending()
	out.Mcp = mcpStatusToProto(s.Mcp)
	out.Commands = slashCommandsToProto(s.Commands)
	return out
}

func pendingToProto(id string, seq uint64, pending []session.PendingRequest) *v1.ThreadPending {
	out := &v1.ThreadPending{SessionId: id, Seq: seq}
	for _, p := range pending {
		out.Pending = append(out.Pending, &v1.ThreadPendingRequest{
			RequestId: p.RequestID, ItemId: p.ItemID, Question: p.Kind == session.KindQuestion, ToolName: p.ToolName, Summary: p.Summary,
		})
	}
	return out
}

var toolStatuses = map[session.ToolStatus]v1.ToolCallStatus{
	session.ToolRunning: v1.ToolCallStatus_TOOL_CALL_STATUS_RUNNING,
	session.ToolDone:    v1.ToolCallStatus_TOOL_CALL_STATUS_DONE,
	session.ToolError:   v1.ToolCallStatus_TOOL_CALL_STATUS_ERROR,
}

var requestStates = map[session.RequestState]v1.ThreadRequestState{
	session.RequestPending:   v1.ThreadRequestState_THREAD_REQUEST_STATE_PENDING,
	session.RequestAllowed:   v1.ThreadRequestState_THREAD_REQUEST_STATE_ALLOWED,
	session.RequestDenied:    v1.ThreadRequestState_THREAD_REQUEST_STATE_DENIED,
	session.RequestCancelled: v1.ThreadRequestState_THREAD_REQUEST_STATE_CANCELLED,
}

// itemToProto maps an item; an unknown kind maps to an item without a payload.
func itemToProto(it session.Item) *v1.ThreadItem {
	p := &v1.ThreadItem{Id: it.ID, Ordinal: it.Ordinal, ParentToolUseId: it.ParentToolUseID, Streaming: it.Streaming}
	if !it.CreatedAt.IsZero() {
		p.CreatedAt = timestamppb.New(it.CreatedAt)
	}
	if !it.UpdatedAt.IsZero() {
		p.UpdatedAt = timestamppb.New(it.UpdatedAt)
	}
	switch it.Kind {
	case session.KindUserMessage:
		p.Payload = &v1.ThreadItem_UserMessage{UserMessage: &v1.UserMessageItem{Text: it.Text, Attachments: it.Attachments, ComposerText: it.ComposerText}}
	case session.KindAssistantText:
		p.Payload = &v1.ThreadItem_AssistantText{AssistantText: &v1.AssistantTextItem{Text: it.Text}}
	case session.KindThinking:
		p.Payload = &v1.ThreadItem_Thinking{Thinking: &v1.ThinkingItem{Text: it.Text}}
	case session.KindToolCall:
		if t := it.Tool; t != nil {
			p.Payload = &v1.ThreadItem_ToolCall{ToolCall: &v1.ToolCallItem{
				ToolUseId: t.ToolUseID, Name: t.Name, InputJson: t.InputJSON, Status: toolStatuses[t.Status],
				Output: t.Output, IsError: t.IsError, ResultJson: t.ResultJSON,
			}}
		}
	case session.KindPermission, session.KindQuestion:
		if r := it.Request; r != nil {
			rp := &v1.ThreadRequestItem{
				RequestId: r.RequestID, ToolName: r.ToolName, DisplayName: r.DisplayName, Title: r.Title,
				Description: r.Description, ToolUseId: r.ToolUseID, AgentId: r.AgentID, BlockedPath: r.BlockedPath,
				DecisionReason: r.DecisionReason, InputJson: r.InputJSON, SuggestionsJson: r.SuggestionsJSON,
				State: requestStates[r.State], Decision: r.Decision, Message: r.Message, Answers: r.Answers,
			}
			if it.Kind == session.KindQuestion {
				p.Payload = &v1.ThreadItem_Question{Question: rp}
			} else {
				p.Payload = &v1.ThreadItem_Permission{Permission: rp}
			}
		}
	case session.KindTurnEnd:
		if t := it.Turn; t != nil {
			p.Payload = &v1.ThreadItem_TurnEnd{TurnEnd: &v1.TurnEndItem{
				Subtype: t.Subtype, IsError: t.IsError, Interrupted: t.Interrupted, StopReason: t.StopReason,
				TerminalReason: t.TerminalReason, DurationMs: t.DurationMS, NumTurns: int32(t.NumTurns), CostUsd: t.CostUSD,
				InputTokens: t.InputTokens, OutputTokens: t.OutputTokens, CacheReadTokens: t.CacheReadTokens,
				CacheWriteTokens: t.CacheWriteTokens, Errors: t.Errors, TurnCostUsd: t.TurnCostUSD, Model: t.Model,
			}}
		}
	case session.KindError:
		p.Payload = &v1.ThreadItem_Error{Error: &v1.ErrorItem{Text: it.Text}}
	case session.KindCompaction:
		c := &v1.CompactionItem{Summary: it.Text}
		if it.Compaction != nil {
			c.Trigger, c.PreTokens, c.PostTokens = it.Compaction.Trigger, it.Compaction.PreTokens, it.Compaction.PostTokens
		}
		p.Payload = &v1.ThreadItem_Compaction{Compaction: c}
	case session.KindCommandOutput:
		p.Payload = &v1.ThreadItem_CommandOutput{CommandOutput: &v1.CommandOutputItem{Text: it.Text}}
	case session.KindNote:
		p.Payload = &v1.ThreadItem_Note{Note: &v1.NoteItem{Text: it.Text}}
	}
	return p
}
