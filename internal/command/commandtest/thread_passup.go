package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// PassUp records the request and answers Current as the worker; PassUpAsk says it was a
// thread ask.
func (s *Thread) PassUp(_ context.Context, r *connect.Request[v1.PassUpQuestionRequest]) (*connect.Response[v1.PassUpQuestionResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.PassUpQuestionResponse{Worker: s.current(r.Msg.GetWorkerId()), ThreadAsk: s.PassUpAsk, Question: "Which?"}), nil
}
