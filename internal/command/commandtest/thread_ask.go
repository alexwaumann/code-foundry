package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Ask records the request and answers Current as the creator; AskRepeated says the
// question was just asked.
func (s *Thread) Ask(_ context.Context, r *connect.Request[v1.AskThreadRequest]) (*connect.Response[v1.AskThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.AskThreadResponse{Creator: s.current("s-lead"), Repeated: s.AskRepeated}), nil
}
