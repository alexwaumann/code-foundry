package api

import (
	"context"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/ember"
)

// EmberStore is the Ember store (*ember.Store) as EmberService reads it. The board is
// changed by the ember.* commands, not this service.
type EmberStore interface {
	Snapshot() *ember.Snapshot
}

var _ EmberStore = (*ember.Store)(nil)

// Ember implements codefoundryv1connect.EmberServiceHandler over the Ember store
// (docs/notes/ember-2-store.md).
type Ember struct {
	store EmberStore
	bus   *bus.Bus
	beat  time.Duration // WatchBoard's heartbeat interval; zero is HeartbeatInterval (tests shorten it)
}

var _ codefoundryv1connect.EmberServiceHandler = (*Ember)(nil)

// NewEmber returns an EmberService handler. b must be the bus the store publishes
// ember.Changed on.
func NewEmber(store EmberStore, b *bus.Bus) *Ember { return &Ember{store: store, bus: b} }

// Route mounts the service.
func (h *Ember) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewEmberServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// GetStatus is Ember's state.
func (h *Ember) GetStatus(context.Context, *connect.Request[v1.GetEmberStatusRequest]) (*connect.Response[v1.GetEmberStatusResponse], error) {
	return connect.NewResponse(&v1.GetEmberStatusResponse{Status: EmberStatusToProto(h.store.Snapshot().Status)}), nil
}

// ListTasks lists the tasks (open ones only with open), in board order.
func (h *Ember) ListTasks(_ context.Context, req *connect.Request[v1.ListEmberTasksRequest]) (*connect.Response[v1.ListEmberTasksResponse], error) {
	out := &v1.ListEmberTasksResponse{}
	for _, t := range h.store.Snapshot().Tasks {
		if !req.Msg.GetOpen() || t.State.Open() {
			out.Tasks = append(out.Tasks, EmberTaskToProto(t))
		}
	}
	return connect.NewResponse(out), nil
}

// WatchBoard sends the board, then the board again after every change, and a heartbeat
// after HeartbeatInterval without one (see heartbeat.proto).
func (h *Ember) WatchBoard(ctx context.Context, _ *connect.Request[v1.WatchEmberBoardRequest], stream *connect.ServerStream[v1.EmberBoard]) error {
	sub := bus.Subscribe[ember.Changed](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(EmberBoardToProto(h.store.Snapshot())); err != nil {
		return err
	}
	beat := newHeartbeat(h.beat)
	defer beat.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-beat.C():
			beat.Reset()
			if err := stream.Send(&v1.EmberBoard{Heartbeat: &v1.StreamHeartbeat{}}); err != nil {
				return err
			}
		case _, ok := <-sub.C():
			if !ok {
				return nil
			}
			// Every event carries the whole board: the latest one says it all.
			for len(sub.C()) > 0 {
				<-sub.C()
			}
			beat.Reset()
			if err := stream.Send(EmberBoardToProto(h.store.Snapshot())); err != nil {
				return err
			}
		}
	}
}

// EmberBoardToProto converts a snapshot to the wire board.
func EmberBoardToProto(s *ember.Snapshot) *v1.EmberBoard {
	out := &v1.EmberBoard{Status: EmberStatusToProto(s.Status), Tasks: make([]*v1.EmberTask, len(s.Tasks))}
	for i, t := range s.Tasks {
		out.Tasks[i] = EmberTaskToProto(t)
	}
	return out
}

// EmberStatusToProto converts Ember's status.
func EmberStatusToProto(s ember.Status) *v1.EmberStatus {
	return &v1.EmberStatus{
		Enabled: s.Enabled, ThreadId: s.ThreadID, Epoch: int32(s.Epoch), EpochStartedAt: optionalTime(s.EpochStartedAt),
		ContextTokens: s.ContextTokens, EpochContextTokens: s.EpochContextTokens, Consolidating: s.Consolidating,
		LastConsolidatedAt: optionalTime(s.LastConsolidatedAt), LastConsolidationError: s.LastConsolidationError,
		Counts: &v1.EmberTaskCounts{
			Todo: int32(s.Counts.Todo), Doing: int32(s.Counts.Doing), Blocked: int32(s.Counts.Blocked),
			Done: int32(s.Counts.Done), Cancelled: int32(s.Counts.Cancelled),
		},
	}
}

// EmberTaskToProto converts a task with its worker's progress.
func EmberTaskToProto(t ember.Task) *v1.EmberTask {
	out := &v1.EmberTask{
		Id: t.ID, Title: t.Title, Detail: t.Detail, State: v1.EmberTaskState(t.State), ParentId: t.ParentID, ThreadId: t.ThreadID,
		Outcome: t.Outcome, Branch: t.Branch, Position: int32(t.Position), CreatedAt: optionalTime(t.CreatedAt), UpdatedAt: optionalTime(t.UpdatedAt),
		DoneAt: optionalTime(t.DoneAt),
	}
	if w := t.Thread; w != nil {
		out.Thread = &v1.EmberTaskThread{
			Id: w.ID, Name: w.Name, State: v1.ThreadState(w.State), Status: v1.ThreadStatus(w.Status), StatusReason: w.StatusReason,
			ReportStatus: v1.ThreadReportStatus(w.Report.Status), ReportSummary: w.Report.Summary, ReportAt: optionalTime(w.Report.At),
			CreatedAt: optionalTime(w.CreatedAt), LastActivityAt: optionalTime(w.LastActivityAt), Archived: w.Archived, Removed: w.Removed,
			DescendantsWorking: int32(w.Team.Working), DescendantsWaiting: int32(w.Team.Waiting), DescendantsTotal: int32(w.Team.Total),
		}
		for _, m := range w.Team.Members {
			out.Thread.Descendants = append(out.Thread.Descendants, &v1.EmberTaskDescendant{
				Id: m.ID, Name: m.Name, Status: v1.ThreadStatus(m.Status), StatusReason: m.StatusReason,
				ReportStatus: v1.ThreadReportStatus(m.Report.Status), ReportSummary: m.Report.Summary, State: v1.ThreadState(m.State),
				LastActivityAt: optionalTime(m.LastActivityAt), Depth: int32(m.Depth),
			})
		}
	}
	return out
}
