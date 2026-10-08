package api

import (
	"context"
	"os"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/durationpb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// Health implements codefoundryv1connect.HealthServiceHandler.
type Health struct {
	started time.Time
	pid     int32
	info    version.Info
	now     func() time.Time
}

var _ codefoundryv1connect.HealthServiceHandler = (*Health)(nil)

// NewHealth returns a HealthService handler for a daemon that started at started.
func NewHealth(started time.Time, info version.Info) *Health {
	return &Health{started: started, pid: int32(os.Getpid()), info: info, now: time.Now}
}

// Route mounts the service.
func (h *Health) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewHealthServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Ping reports pid, version, and uptime.
func (h *Health) Ping(context.Context, *connect.Request[v1.PingRequest]) (*connect.Response[v1.PingResponse], error) {
	return connect.NewResponse(&v1.PingResponse{
		Pid:     h.pid,
		Version: h.info.Version,
		Uptime:  durationpb.New(h.now().Sub(h.started)),
	}), nil
}

// Version reports build information.
func (h *Health) Version(context.Context, *connect.Request[v1.VersionRequest]) (*connect.Response[v1.VersionResponse], error) {
	return connect.NewResponse(&v1.VersionResponse{
		Version:   h.info.Version,
		Commit:    h.info.Commit,
		GoVersion: h.info.GoVersion,
	}), nil
}
