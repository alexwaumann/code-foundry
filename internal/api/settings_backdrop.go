package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/backdrop"
)

// WithBackdrops serves the backdrop RPCs from store; without it they are Unimplemented.
func (h *Settings) WithBackdrops(store backdrop.Service) *Settings {
	h.backdrops = store
	return h
}

var errNoBackdrops = connect.NewError(connect.CodeUnimplemented, errors.New("backdrop images are not available"))

// ListBackdrops returns the backdrop images, oldest first.
func (h *Settings) ListBackdrops(ctx context.Context, _ *connect.Request[v1.ListBackdropsRequest]) (*connect.Response[v1.ListBackdropsResponse], error) {
	if h.backdrops == nil {
		return nil, errNoBackdrops
	}
	list, err := h.backdrops.List(ctx)
	if err != nil {
		return nil, backdropError(err)
	}
	out := make([]*v1.Backdrop, len(list))
	for i, e := range list {
		out[i] = backdropToProto(e)
	}
	return connect.NewResponse(&v1.ListBackdropsResponse{Backdrops: out}), nil
}

// ImportBackdrop copies a picture in and selects it.
func (h *Settings) ImportBackdrop(ctx context.Context, req *connect.Request[v1.ImportBackdropRequest]) (*connect.Response[v1.ImportBackdropResponse], error) {
	if h.backdrops == nil {
		return nil, errNoBackdrops
	}
	e, err := h.backdrops.Import(ctx, req.Msg.GetPath())
	if err != nil {
		return nil, backdropError(err)
	}
	return connect.NewResponse(&v1.ImportBackdropResponse{Backdrop: backdropToProto(e)}), nil
}

// RemoveBackdrop deletes an image (and unselects it).
func (h *Settings) RemoveBackdrop(ctx context.Context, req *connect.Request[v1.RemoveBackdropRequest]) (*connect.Response[v1.RemoveBackdropResponse], error) {
	if h.backdrops == nil {
		return nil, errNoBackdrops
	}
	if err := h.backdrops.Remove(ctx, req.Msg.GetName()); err != nil {
		return nil, backdropError(err)
	}
	return connect.NewResponse(&v1.RemoveBackdropResponse{}), nil
}

// ReadBackdrop returns an image's bytes.
func (h *Settings) ReadBackdrop(ctx context.Context, req *connect.Request[v1.ReadBackdropRequest]) (*connect.Response[v1.ReadBackdropResponse], error) {
	if h.backdrops == nil {
		return nil, errNoBackdrops
	}
	data, mimeType, err := h.backdrops.Read(ctx, req.Msg.GetName())
	if err != nil {
		return nil, backdropError(err)
	}
	return connect.NewResponse(&v1.ReadBackdropResponse{Data: data, MimeType: mimeType}), nil
}

func backdropToProto(e backdrop.Entry) *v1.Backdrop {
	out := &v1.Backdrop{Name: e.Name, Size: e.Size, Width: int32(e.Width), Height: int32(e.Height)}
	if !e.Added.IsZero() {
		out.AddedAt = timestamppb.New(e.Added)
	}
	return out
}

// backdropError maps the store's errors; a failed selection is the settings store's.
func backdropError(err error) error {
	switch {
	case errors.Is(err, backdrop.ErrInvalidArgument):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, backdrop.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	default:
		return settingsError(err)
	}
}
