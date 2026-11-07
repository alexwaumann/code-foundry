package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/browser"
	"github.com/alexwaumann/code-foundry/internal/store/browser/browsertest"
)

const windowOrigin = "wails://localhost"

func newBrowserServer(t *testing.T, enabled func() bool) (codefoundryv1connect.BrowserServiceClient, *browsertest.Chrome, *httptest.Server) {
	t.Helper()
	c := browsertest.New()
	st := browser.New(browser.Options{Dir: t.TempDir(), Launch: c.Launch, Enabled: enabled, Idle: time.Hour, Log: slog.New(slog.DiscardHandler)})
	t.Cleanup(st.Close)
	h := NewBrowser(st)
	h.beat = 20 * time.Millisecond
	route := h.Route(func(o string) bool { return o == windowOrigin })
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := codefoundryv1connect.NewBrowserServiceClient(srv.Client(), srv.URL, connect.WithInterceptors(origin(windowOrigin)))
	return client, c, srv
}

// origin is a client that sets Origin, as a page's fetch does.
type origin string

func (o origin) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, r connect.AnyRequest) (connect.AnyResponse, error) {
		r.Header().Set("Origin", string(o))
		return next(ctx, r)
	}
}

func (o origin) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, s connect.Spec) connect.StreamingClientConn {
		c := next(ctx, s)
		c.RequestHeader().Set("Origin", string(o))
		return c
	}
}

func (origin) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func TestBrowserAnswersBrowserPagesOnly(t *testing.T) {
	_, c, srv := newBrowserServer(t, func() bool { return true })
	tests := []struct {
		name    string
		origins []string
	}{
		{"no Origin, as the CLI and the Unix socket", nil},
		{"a page the API refuses", []string{"http://127.0.0.1:9999"}},
		{"two Origins", []string{windowOrigin, "http://evil.example"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, srv.URL+"/codefoundry.v1.BrowserService/Relaunch", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			for _, o := range tt.origins {
				req.Header.Add("Origin", o)
			}
			res, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			_ = res.Body.Close()
			if res.StatusCode != http.StatusForbidden {
				t.Fatalf("status %d", res.StatusCode)
			}
		})
	}
	if n := c.Launches(); n != 0 {
		t.Fatalf("launches %d", n)
	}
}

func TestBrowserOffIsAPreconditionAndStartsNothing(t *testing.T) {
	client, c, _ := newBrowserServer(t, func() bool { return false })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream, err := client.Watch(ctx, connect.NewRequest(&v1.WatchBrowserRequest{Surface: "thread:a"}))
	if err != nil {
		t.Fatal(err)
	}
	if stream.Receive() {
		t.Fatalf("got %v", stream.Msg())
	}
	if code := connect.CodeOf(stream.Err()); code != connect.CodeFailedPrecondition {
		t.Fatalf("code %v: %v", code, stream.Err())
	}
	if n := c.Launches(); n != 0 {
		t.Fatalf("launches %d", n)
	}
}

func TestBrowserWatchCarriesStateFramesAndHeartbeats(t *testing.T) {
	client, c, _ := newBrowserServer(t, func() bool { return true })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := client.Watch(ctx, connect.NewRequest(&v1.WatchBrowserRequest{Surface: "thread:a", Width: 640, Height: 480}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	var ready, framed, beat bool
	sent := false
	for !ready || !framed || !beat {
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		switch ev := stream.Msg().GetEvent().(type) {
		case *v1.BrowserEvent_State:
			ready = ready || ev.State.GetPhase() == v1.BrowserPhase_BROWSER_PHASE_READY
		case *v1.BrowserEvent_Frame:
			framed = framed || (string(ev.Frame.GetJpeg()) == "frame" && ev.Frame.GetWidth() == 640)
		case *v1.BrowserEvent_Heartbeat:
			beat = true
		}
		if ready && !sent {
			sent = true
			c.Frame("session-target-1", 1, []byte("frame"), 640, 480)
		}
	}
	// Taken means sent: that is when Chrome hears it may send the next.
	for deadline := time.Now().Add(5 * time.Second); len(c.Calls("Page.screencastFrameAck")) == 0; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the frame was never acked")
		}
	}
}

func TestBrowserErrorCodes(t *testing.T) {
	tests := []struct {
		err  error
		code connect.Code
	}{
		{browser.ErrBadURL, connect.CodeInvalidArgument},
		{browser.ErrBadInput, connect.CodeInvalidArgument},
		{browser.ErrNoSurface, connect.CodeNotFound},
		{browser.ErrNotPending, connect.CodeNotFound},
		{browser.ErrDisabled, connect.CodeFailedPrecondition},
		{browser.ErrCrashed, connect.CodeFailedPrecondition},
		{browser.ErrClosed, connect.CodeUnavailable},
		{context.Canceled, connect.CodeCanceled},
		{context.DeadlineExceeded, connect.CodeDeadlineExceeded},
		{errors.New("other"), connect.CodeInternal},
	}
	for _, tt := range tests {
		if got := connect.CodeOf(browserError(tt.err)); got != tt.code {
			t.Errorf("%v: %v, want %v", tt.err, got, tt.code)
		}
	}
}

func TestBrowserInputFromProto(t *testing.T) {
	m := browserInputFromProto(&v1.BrowserInputEvent{Event: &v1.BrowserInputEvent_Mouse{Mouse: &v1.BrowserMouseEvent{Type: "mouseWheel", Button: "none", X: 1, Y: 2, DeltaY: 3}}})
	if m.Mouse == nil || m.Mouse.Type != "mouseWheel" || m.Mouse.DeltaY != 3 {
		t.Fatalf("%+v", m.Mouse)
	}
	k := browserInputFromProto(&v1.BrowserInputEvent{Event: &v1.BrowserInputEvent_Key{Key: &v1.BrowserKeyEvent{Type: "keyDown", Key: "a", Text: "a", Modifiers: 4}}})
	if k.Key == nil || k.Key.Text != "a" || k.Key.Modifiers != 4 {
		t.Fatalf("%+v", k.Key)
	}
	if got := browserInputFromProto(&v1.BrowserInputEvent{Event: &v1.BrowserInputEvent_Text{Text: "é"}}); got.Text != "é" {
		t.Fatalf("%+v", got)
	}
	if got := browserInputFromProto(&v1.BrowserInputEvent{}); got.Mouse != nil || got.Key != nil || got.Text != "" {
		t.Fatalf("%+v", got)
	}
}
