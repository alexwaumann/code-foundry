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
	r := NewUI(bus.New(), theme.NewLive(), theme.NewReports()).Route()
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
	r := NewUI(bus.New(), live, theme.NewReports()).Route()
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

func TestUIPublishThemeReport(t *testing.T) {
	reports := theme.NewReports()
	mux := http.NewServeMux()
	r := NewUI(bus.New(), theme.NewLive(), reports).Route()
	mux.Handle(r.Path, r.Handler)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := codefoundryv1connect.NewUiServiceClient(srv.Client(), srv.URL)
	ctx := context.Background()

	issue := &v1.ThemeContrastIssue{Slot: "--cf-warning-text", Against: "--cf-warning-surface", Label: "--cf-warning-text on --cf-warning-surface over --cf-surface", Ratio: 3.9, Required: 4.5}
	stale := &v1.ThemeStalePin{Slot: "--cf-sidebar", Pinned: "#0b141c", Basis: "#11111b", Derived: "#181825"}
	tests := []struct {
		name     string
		reports  []*v1.ThemeReport
		wantCode connect.Code // 0: ok
	}{
		{"one", []*v1.ThemeReport{{Id: "ocean-dusk", Version: "ab12", Issues: []*v1.ThemeContrastIssue{issue}, Stale: []*v1.ThemeStalePin{stale}}}, 0},
		{"several, on connect", []*v1.ThemeReport{{Id: "a", Version: "1"}, {Id: "b", Version: "2"}}, 0},
		{"a bad slot refuses the batch", []*v1.ThemeReport{{Id: "c", Version: "1"}, {Id: "d", Version: "1", Issues: []*v1.ThemeContrastIssue{{Slot: "--cf-nope", Against: "--cf-surface", Ratio: 2, Required: 3}}}}, connect.CodeInvalidArgument},
		{"a bad version", []*v1.ThemeReport{{Id: "e", Version: "v1"}}, connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.PublishThemeReport(ctx, connect.NewRequest(&v1.PublishThemeReportRequest{Reports: tt.reports}))
			if tt.wantCode == 0 && err != nil {
				t.Fatal(err)
			}
			if tt.wantCode != 0 && connect.CodeOf(err) != tt.wantCode {
				t.Fatalf("code %v, want %v", connect.CodeOf(err), tt.wantCode)
			}
		})
	}
	got, ok := reports.Get("ocean-dusk")
	if !ok || got.Version != "ab12" || len(got.Issues) != 1 || got.Issues[0].Ratio != 3.9 || got.Issues[0].Label != issue.Label ||
		len(got.Stale) != 1 || got.Stale[0].Derived != "#181825" {
		t.Errorf("kept %+v, %v", got, ok)
	}
	if _, ok := reports.Get("c"); ok {
		t.Error("kept a report of a refused batch")
	}
}
