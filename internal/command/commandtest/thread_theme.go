package commandtest

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ShowTheme answers a theme item "theme-1" holding the card as sent.
func (s *Thread) ShowTheme(_ context.Context, r *connect.Request[v1.ShowThreadThemeRequest]) (*connect.Response[v1.ShowThreadThemeResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ShowThreadThemeResponse{Item: &v1.ThreadItem{Id: "theme-1", Payload: &v1.ThreadItem_Theme{
		Theme: proto.CloneOf(r.Msg.GetTheme())}}}), nil
}
