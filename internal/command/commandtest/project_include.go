package commandtest

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// SetIncludeIgnored records the request and returns the project with that id (from
// Projects) with the patterns as given; NotFound for another id.
func (f *Project) SetIncludeIgnored(_ context.Context, r *connect.Request[v1.SetIncludeIgnoredRequest]) (*connect.Response[v1.SetIncludeIgnoredResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	for _, p := range f.Projects {
		if p.GetId() == r.Msg.GetId() {
			out := proto.CloneOf(p)
			out.IncludeIgnored = r.Msg.GetPatterns()
			return connect.NewResponse(&v1.SetIncludeIgnoredResponse{Project: out}), nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("project %q", r.Msg.GetId()))
}
