package api

import (
	"context"
	"errors"
	"slices"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Workspace implements codefoundryv1connect.WorkspaceServiceHandler over a
// workspace.Store.
type Workspace struct {
	store workspace.Store
	bus   *bus.Bus
}

var _ codefoundryv1connect.WorkspaceServiceHandler = (*Workspace)(nil)

// NewWorkspace returns a WorkspaceService handler. b must be the bus the store
// publishes workspace.Event on.
func NewWorkspace(store workspace.Store, b *bus.Bus) *Workspace {
	return &Workspace{store: store, bus: b}
}

// Route mounts the service.
func (h *Workspace) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewWorkspaceServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// List returns every workspace.
func (h *Workspace) List(context.Context, *connect.Request[v1.ListWorkspacesRequest]) (*connect.Response[v1.ListWorkspacesResponse], error) {
	return connect.NewResponse(&v1.ListWorkspacesResponse{Workspaces: workspacesToProto(h.store.Snapshot())}), nil
}

// Create saves a workspace and makes its managed dir.
func (h *Workspace) Create(ctx context.Context, req *connect.Request[v1.CreateWorkspaceRequest]) (*connect.Response[v1.CreateWorkspaceResponse], error) {
	m := req.Msg
	w, err := h.store.Create(ctx, workspace.CreateOptions{Name: m.GetName(), Members: m.GetMembers(), RootPath: m.GetRootPath(), DefaultPrimary: m.GetDefaultPrimary()})
	if err != nil {
		return nil, workspaceError(err)
	}
	return connect.NewResponse(&v1.CreateWorkspaceResponse{Workspace: workspaceToProto(w)}), nil
}

// AddProject adds a member project.
func (h *Workspace) AddProject(ctx context.Context, req *connect.Request[v1.AddWorkspaceProjectRequest]) (*connect.Response[v1.AddWorkspaceProjectResponse], error) {
	w, err := h.store.AddProject(ctx, req.Msg.GetWorkspace(), req.Msg.GetProject())
	if err != nil {
		return nil, workspaceError(err)
	}
	return connect.NewResponse(&v1.AddWorkspaceProjectResponse{Workspace: workspaceToProto(w)}), nil
}

// RemoveProject drops a member project.
func (h *Workspace) RemoveProject(ctx context.Context, req *connect.Request[v1.RemoveWorkspaceProjectRequest]) (*connect.Response[v1.RemoveWorkspaceProjectResponse], error) {
	w, err := h.store.RemoveProject(ctx, req.Msg.GetWorkspace(), req.Msg.GetProject())
	if err != nil {
		return nil, workspaceError(err)
	}
	return connect.NewResponse(&v1.RemoveWorkspaceProjectResponse{Workspace: workspaceToProto(w)}), nil
}

// Rename renames a workspace.
func (h *Workspace) Rename(ctx context.Context, req *connect.Request[v1.RenameWorkspaceRequest]) (*connect.Response[v1.RenameWorkspaceResponse], error) {
	w, err := h.store.Rename(ctx, req.Msg.GetWorkspace(), req.Msg.GetName())
	if err != nil {
		return nil, workspaceError(err)
	}
	return connect.NewResponse(&v1.RenameWorkspaceResponse{Workspace: workspaceToProto(w)}), nil
}

// SetDefaultPrimary sets where new threads in a workspace start.
func (h *Workspace) SetDefaultPrimary(ctx context.Context, req *connect.Request[v1.SetWorkspaceDefaultPrimaryRequest]) (*connect.Response[v1.SetWorkspaceDefaultPrimaryResponse], error) {
	w, err := h.store.SetDefaultPrimary(ctx, req.Msg.GetWorkspace(), req.Msg.GetDefaultPrimary())
	if err != nil {
		return nil, workspaceError(err)
	}
	return connect.NewResponse(&v1.SetWorkspaceDefaultPrimaryResponse{Workspace: workspaceToProto(w)}), nil
}

// Remove forgets a workspace.
func (h *Workspace) Remove(ctx context.Context, req *connect.Request[v1.RemoveWorkspaceRequest]) (*connect.Response[v1.RemoveWorkspaceResponse], error) {
	if err := h.store.Remove(ctx, req.Msg.GetWorkspace()); err != nil {
		return nil, workspaceError(err)
	}
	return connect.NewResponse(&v1.RemoveWorkspaceResponse{}), nil
}

// Watch sends a snapshot, then every workspace event. If the client falls behind and
// events are dropped, it sends a fresh snapshot.
func (h *Workspace) Watch(ctx context.Context, _ *connect.Request[v1.WatchWorkspacesRequest], stream *connect.ServerStream[v1.WorkspaceEvent]) error {
	// Subscribe first so nothing published between snapshot and stream is lost. Each
	// event carries full state, so applying queued older events still converges.
	sub := bus.Subscribe[workspace.Event](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(workspaceEventToProto(h.store.Snapshot())); err != nil {
		return err
	}
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
				ev = h.store.Snapshot()
			}
			if msg := workspaceEventToProto(ev); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// workspaceEventToProto converts a bus event (or a *workspace.Snapshot) to the wire
// event.
func workspaceEventToProto(ev workspace.Event) *v1.WorkspaceEvent {
	switch e := ev.(type) {
	case *workspace.Snapshot:
		return &v1.WorkspaceEvent{Event: &v1.WorkspaceEvent_Snapshot{Snapshot: &v1.WorkspaceSnapshot{Workspaces: workspacesToProto(e)}}}
	case workspace.Updated:
		return &v1.WorkspaceEvent{Event: &v1.WorkspaceEvent_Updated{Updated: workspaceToProto(e.Workspace)}}
	case workspace.Removed:
		return &v1.WorkspaceEvent{Event: &v1.WorkspaceEvent_RemovedId{RemovedId: e.ID}}
	}
	return nil
}

func workspacesToProto(snap *workspace.Snapshot) []*v1.Workspace {
	if snap == nil {
		return nil
	}
	out := make([]*v1.Workspace, len(snap.Workspaces))
	for i, w := range snap.Workspaces {
		out[i] = workspaceToProto(w)
	}
	return out
}

func workspaceToProto(w workspace.Workspace) *v1.Workspace {
	p := &v1.Workspace{Id: w.ID, Name: w.Name, Members: slices.Clone(w.Members), RootPath: w.RootPath,
		DefaultPrimary: w.DefaultPrimary, ManagedDir: w.ManagedDir, Instructions: w.Instructions, Skills: slices.Clone(w.Skills)}
	if !w.CreatedAt.IsZero() {
		p.CreatedAt = timestamppb.New(w.CreatedAt)
	}
	return p
}

// workspaceError maps store errors to Connect codes.
func workspaceError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, workspace.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, workspace.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, workspace.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}
