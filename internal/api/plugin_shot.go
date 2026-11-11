package api

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/shot"
)

// WithShots serves ShotSurface from b, whose capturer is the app's host (UiService.WatchShots).
func (h *Plugin) WithShots(b *shot.Broker) *Plugin {
	h.shots = b
	return h
}

// ShotSurface hands a shot of a surface to the app's host and returns its PNG.
func (h *Plugin) ShotSurface(ctx context.Context, req *connect.Request[v1.ShotSurfaceRequest]) (*connect.Response[v1.ShotSurfaceResponse], error) {
	if h.shots == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon takes no screenshots"))
	}
	m := req.Msg
	if m.GetInstance() == "" && (m.GetRef().GetPlugin() == "" || m.GetRef().GetSurface() == "") {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name the surface: an instance or a ref"))
	}
	w, err := shotSize("width", m.GetWidth(), shot.DefaultWidth, shot.MinWidth, shot.MaxWidth)
	if err != nil {
		return nil, err
	}
	ht, err := shotSize("height", m.GetHeight(), shot.DefaultHeight, shot.MinHeight, shot.MaxHeight)
	if err != nil {
		return nil, err
	}
	res, err := h.shots.Shoot(ctx, &v1.ShotRequest{Ref: m.GetRef(), Instance: m.GetInstance(), MinVersion: m.GetMinVersion(), Width: w, Height: ht})
	if err != nil {
		return nil, shotError(err)
	}
	return connect.NewResponse(&v1.ShotSurfaceResponse{Png: res.PNG, Width: w, Height: ht, ContentHeight: int32(res.ContentHeight)}), nil
}

// shotSize is a viewport side: def for 0, else v within [lo, hi].
func shotSize(name string, v, def, lo, hi int32) (int32, error) {
	switch {
	case v == 0:
		return def, nil
	case v < lo || v > hi:
		return 0, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s %d is out of bounds (%d to %d)", name, v, lo, hi))
	}
	return v, nil
}

// shotError is a failed shot as the CLI prints it: "no screenshot: <why>".
func shotError(err error) error {
	// The app is not open, could not draw it, or sent no PNG: FailedPrecondition.
	code := connect.CodeFailedPrecondition
	switch {
	case errors.Is(err, shot.ErrTimeout), errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	case errors.Is(err, shot.ErrGone), errors.Is(err, shot.ErrBusy):
		code = connect.CodeUnavailable
	case errors.Is(err, shot.ErrTooLarge):
		code = connect.CodeResourceExhausted
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	}
	return connect.NewError(code, fmt.Errorf("no screenshot: %w", err))
}
