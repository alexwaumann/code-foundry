package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
)

func TestUIEmitFanOut(t *testing.T) {
	mux := http.NewServeMux()
	r := NewUI(bus.New()).Route()
	mux.Handle(r.Path, r.Handler)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := codefoundryv1connect.NewUiServiceClient(srv.Client(), srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	notify := &v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{Title: "hi"}}}
	emit := func() uint32 {
		t.Helper()
		res, err := c.Emit(ctx, connect.NewRequest(&v1.EmitIntentRequest{Intent: notify}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg.GetDelivered()
	}

	if n := emit(); n != 0 {
		t.Fatalf("delivered %d with no watchers", n)
	}

	var streams []*connect.ServerStreamForClient[v1.UiIntent]
	for range 2 {
		s, err := c.WatchIntents(ctx, connect.NewRequest(&v1.WatchIntentsRequest{}))
		if err != nil {
			t.Fatal(err)
		}
		s.ResponseHeader() // the server flushes headers once it has subscribed
		streams = append(streams, s)
	}
	if n := emit(); n != 2 {
		t.Fatalf("delivered %d, want 2", n)
	}
	for i, s := range streams {
		if !s.Receive() {
			t.Fatalf("watcher %d: %v", i, s.Err())
		}
		if !proto.Equal(s.Msg(), notify) {
			t.Fatalf("watcher %d got %v", i, s.Msg())
		}
	}

	_, err := c.Emit(ctx, connect.NewRequest(&v1.EmitIntentRequest{}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty intent err = %v, want invalid_argument", err)
	}
	_, err = c.Emit(ctx, connect.NewRequest(&v1.EmitIntentRequest{Intent: &v1.UiIntent{}}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("intent without a case err = %v, want invalid_argument", err)
	}
}
