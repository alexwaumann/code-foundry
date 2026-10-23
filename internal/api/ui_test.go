package api

import (
	"context"
	"maps"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

func TestUIEmitFanOut(t *testing.T) {
	mux := http.NewServeMux()
	r := NewUI(bus.New(), theme.NewLive()).Route()
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

// themeVars is every slot (GitHub Dark's values) with patch applied.
func themeVars(patch map[string]string) map[string]string {
	v := theme.DefaultFrame(theme.SchemeDark).Vars
	maps.Copy(v, patch)
	return v
}

func TestUIPublishTheme(t *testing.T) {
	live := theme.NewLive()
	mux := http.NewServeMux()
	r := NewUI(bus.New(), live).Route()
	mux.Handle(r.Path, r.Handler)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := codefoundryv1connect.NewUiServiceClient(srv.Client(), srv.URL)
	ctx := context.Background()

	tests := []struct {
		name     string
		req      *v1.PublishThemeRequest
		wantCode connect.Code // 0: ok
	}{
		{"ok", &v1.PublishThemeRequest{Id: "nord", Scheme: "dark", Vars: themeVars(map[string]string{"--cf-text": "#d8dee9", "--cf-accent-surface": "#88c0d01a"})}, 0},
		{"bad scheme", &v1.PublishThemeRequest{Id: "nord", Scheme: "dim", Vars: themeVars(nil)}, connect.CodeInvalidArgument},
		{"bad value", &v1.PublishThemeRequest{Id: "nord", Scheme: "dark", Vars: themeVars(map[string]string{"--cf-text": "url(x)"})}, connect.CodeInvalidArgument},
		{"partial set", &v1.PublishThemeRequest{Id: "nord", Scheme: "dark", Vars: map[string]string{"--cf-text": "#d8dee9"}}, connect.CodeInvalidArgument},
		{"unknown slot", &v1.PublishThemeRequest{Id: "nord", Scheme: "dark", Vars: themeVars(map[string]string{"--cf-txet": "#d8dee9"})}, connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.PublishTheme(ctx, connect.NewRequest(tt.req))
			if tt.wantCode == 0 && err != nil {
				t.Fatal(err)
			}
			if tt.wantCode != 0 && connect.CodeOf(err) != tt.wantCode {
				t.Fatalf("code %v, want %v", connect.CodeOf(err), tt.wantCode)
			}
		})
	}
	// The refused publishes left the first one current, every var intact.
	got, ok := live.Current()
	if !ok || got.ID != "nord" || got.Scheme != "dark" || got.Vars["--cf-text"] != "#d8dee9" || got.Vars["--cf-accent-surface"] != "#88c0d01a" {
		t.Fatalf("current %+v, %v", got, ok)
	}
}
