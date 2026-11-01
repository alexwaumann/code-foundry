package commandtest

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Rename records the request and returns the project with that id (from Projects)
// under the new name; NotFound for another id.
func (f *Project) Rename(_ context.Context, r *connect.Request[v1.RenameProjectRequest]) (*connect.Response[v1.RenameProjectResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	for _, p := range f.Projects {
		if p.GetId() == r.Msg.GetId() {
			out := proto.CloneOf(p)
			out.Name = r.Msg.GetName()
			return connect.NewResponse(&v1.RenameProjectResponse{Project: out}), nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("project %q", r.Msg.GetId()))
}
