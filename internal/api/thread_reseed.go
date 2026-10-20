package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Reseed gives a thread a fresh Claude session with a seed (docs/notes/ember-1-primitives.md).
func (h *Thread) Reseed(context.Context, *connect.Request[v1.ReseedThreadRequest]) (*connect.Response[v1.ReseedThreadResponse], error) {
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("reseed is not built yet"))
}
