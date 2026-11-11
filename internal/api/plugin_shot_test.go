package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/shot"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/plugintest"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

var shotPNG = []byte("\x89PNG\r\n\x1a\nbody")

func newShotServer(t *testing.T, b *shot.Broker) (codefoundryv1connect.PluginServiceClient, codefoundryv1connect.UiServiceClient) {
	t.Helper()
	bs := bus.New()
	mux := http.NewServeMux()
	for _, r := range []Route{
		NewPlugin(plugintest.New(bs), bs).WithShots(b).Route(),
		NewUI(bs, theme.NewLive(), theme.NewReports()).WithShots(b).Route(),
	} {
		mux.Handle(r.Path, r.Handler)
	}
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return codefoundryv1connect.NewPluginServiceClient(srv.Client(), srv.URL), codefoundryv1connect.NewUiServiceClient(srv.Client(), srv.URL)
}

// capture holds WatchShots until ctx ends and answers each request with answer; nil: never.
func capture(ctx context.Context, t *testing.T, ui codefoundryv1connect.UiServiceClient, answer func(*v1.ShotRequest) *v1.PublishShotRequest) <-chan *v1.ShotRequest {
	t.Helper()
	stream, err := ui.WatchShots(ctx, connect.NewRequest(&v1.WatchShotsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	// The headers arrive once the stream is the capturer (ResponseHeader waits for them).
	stream.ResponseHeader()
	seen := make(chan *v1.ShotRequest, 4)
	go func() {
		defer func() { _ = stream.Close() }()
		for stream.Receive() {
			r := stream.Msg()
			seen <- r
			if answer == nil {
				continue
			}
			a := answer(r)
			a.Id = r.GetId()
			if _, err := ui.PublishShot(ctx, connect.NewRequest(a)); err != nil && ctx.Err() == nil {
				t.Errorf("publish: %v", err)
			}
		}
	}()
	return seen
}

func TestShotSurface(t *testing.T) {
	ref := &v1.SurfaceRef{Plugin: "hello", Surface: "main", Context: &v1.UiContext{ActiveThreadId: "s-1"}}
	tests := []struct {
		name string
		// noCapturer: no WatchShots stream.
		noCapturer bool
		answer     func(*v1.ShotRequest) *v1.PublishShotRequest
		req        *v1.ShotSurfaceRequest
		wantCode   connect.Code
		wantMsg    string
		want       *v1.ShotSurfaceResponse
		// wantReq is what the capturer is asked (id aside).
		wantReq *v1.ShotRequest
	}{
		{name: "no app open", noCapturer: true, req: &v1.ShotSurfaceRequest{Ref: ref},
			wantCode: connect.CodeFailedPrecondition, wantMsg: "no screenshot: the app is not open (code-foundry gui)"},
		{name: "the default viewport, and the PNG back",
			answer: func(*v1.ShotRequest) *v1.PublishShotRequest { return &v1.PublishShotRequest{Png: shotPNG, ContentHeight: 1640} },
			req:    &v1.ShotSurfaceRequest{Ref: ref, Instance: "hello/main/thread:s-1", MinVersion: 3},
			want:   &v1.ShotSurfaceResponse{Png: shotPNG, Width: 420, Height: 900, ContentHeight: 1640},
			wantReq: &v1.ShotRequest{Ref: ref, Instance: "hello/main/thread:s-1", MinVersion: 3, Width: 420, Height: 900}},
		{name: "a size of its own",
			answer: func(*v1.ShotRequest) *v1.PublishShotRequest { return &v1.PublishShotRequest{Png: shotPNG, ContentHeight: 300} },
			req:    &v1.ShotSurfaceRequest{Instance: "hello/main/global", Width: 600, Height: 1200},
			want:   &v1.ShotSurfaceResponse{Png: shotPNG, Width: 600, Height: 1200, ContentHeight: 300}},
		{name: "the app's reason",
			answer:   func(*v1.ShotRequest) *v1.PublishShotRequest { return &v1.PublishShotRequest{Error: "the surface sent no view"} },
			req:      &v1.ShotSurfaceRequest{Ref: ref},
			wantCode: connect.CodeFailedPrecondition, wantMsg: "no screenshot: the surface sent no view"},
		{name: "no answer in time", req: &v1.ShotSurfaceRequest{Ref: ref},
			wantCode: connect.CodeDeadlineExceeded, wantMsg: "no screenshot: the app did not answer in time"},
		{name: "too narrow", noCapturer: true, req: &v1.ShotSurfaceRequest{Ref: ref, Width: 100},
			wantCode: connect.CodeInvalidArgument, wantMsg: "width 100 is out of bounds (280 to 1600)"},
		{name: "too tall", noCapturer: true, req: &v1.ShotSurfaceRequest{Ref: ref, Height: 5000},
			wantCode: connect.CodeInvalidArgument, wantMsg: "height 5000 is out of bounds (200 to 4000)"},
		{name: "no surface named", noCapturer: true, req: &v1.ShotSurfaceRequest{Ref: &v1.SurfaceRef{Plugin: "hello"}},
			wantCode: connect.CodeInvalidArgument, wantMsg: "name the surface"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			plugins, ui := newShotServer(t, shot.New(shot.WithTimeout(300*time.Millisecond)))
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			var seen <-chan *v1.ShotRequest
			if !tt.noCapturer {
				seen = capture(ctx, t, ui, tt.answer)
			}
			res, err := plugins.ShotSurface(ctx, connect.NewRequest(tt.req))
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v %q", err, tt.wantCode, tt.wantMsg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := res.Msg; string(got.GetPng()) != string(tt.want.GetPng()) || got.GetWidth() != tt.want.GetWidth() ||
				got.GetHeight() != tt.want.GetHeight() || got.GetContentHeight() != tt.want.GetContentHeight() {
				t.Errorf("response %v, want %v", got, tt.want)
			}
			if tt.wantReq != nil {
				got := <-seen
				if got.GetId() == "" || got.GetRef().GetPlugin() != tt.wantReq.GetRef().GetPlugin() ||
					got.GetRef().GetContext().GetActiveThreadId() != "s-1" || got.GetInstance() != tt.wantReq.GetInstance() ||
					got.GetMinVersion() != tt.wantReq.GetMinVersion() || got.GetWidth() != tt.wantReq.GetWidth() || got.GetHeight() != tt.wantReq.GetHeight() {
					t.Errorf("capturer asked %v, want %v", got, tt.wantReq)
				}
			}
		})
	}
}

func TestPublishShot(t *testing.T) {
	_, ui := newShotServer(t, shot.New())
	ctx := context.Background()
	for _, tt := range []struct {
		name string
		req  *v1.PublishShotRequest
		want connect.Code
	}{
		{"an id no one waits on", &v1.PublishShotRequest{Id: "shot-nope", Png: shotPNG}, connect.CodeNotFound},
		{"no id", &v1.PublishShotRequest{Png: shotPNG}, connect.CodeNotFound},
	} {
		if _, err := ui.PublishShot(ctx, connect.NewRequest(tt.req)); connect.CodeOf(err) != tt.want {
			t.Errorf("%s: err = %v, want %v", tt.name, err, tt.want)
		}
	}
}

// The capturer's stream ending mid-request fails the shot at once, not at the timeout.
func TestShotCapturerLeaves(t *testing.T) {
	plugins, ui := newShotServer(t, shot.New())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	capCtx, leave := context.WithCancel(ctx)
	seen := capture(capCtx, t, ui, nil)
	go func() {
		<-seen
		leave()
	}()
	start := time.Now()
	_, err := plugins.ShotSurface(ctx, connect.NewRequest(&v1.ShotSurfaceRequest{Instance: "hello/main/global"}))
	if connect.CodeOf(err) != connect.CodeUnavailable || !strings.Contains(err.Error(), "the app closed before it answered") {
		t.Fatalf("err = %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("took %v", d)
	}
}
