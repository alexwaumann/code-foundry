package api

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/shot"
)

// CheckPage hands the page to the app's host with the thread it acts for, and answers the
// host's report; with no app it says so, and a page no thread owns nor the user allowed is
// not rendered (it would run without the bridge).
func TestCheckPage(t *testing.T) {
	e := newPageEnv(t)
	report := &v1.PageCheckReport{Loaded: true, Settled: true, Height: 312}
	tests := []struct {
		name      string
		req       *v1.CheckPageRequest
		noApp     bool
		wantShot  *v1.ShotRequest
		code      connect.Code
		errSubstr string
	}{
		{name: "the asking thread owns it", req: &v1.CheckPageRequest{Path: "owned.html", ThreadId: "t-1"},
			wantShot: &v1.ShotRequest{Width: 720, Height: PageCheckHeight, Page: &v1.PageShot{Path: "owned.html", ThreadId: "t-1", SettleMs: 5000}}},
		{name: "another thread asks: its first owner", req: &v1.CheckPageRequest{Path: "owned.html", ThreadId: "t-9", Width: 400, SettleMs: 1500, Png: true},
			wantShot: &v1.ShotRequest{Width: 400, Height: PageCheckHeight, Page: &v1.PageShot{Path: "owned.html", ThreadId: "t-1", SettleMs: 1500, Png: true}}},
		{name: "a page the user allowed: no thread", req: &v1.CheckPageRequest{Path: "allowed.html", ThreadId: "t-1"},
			wantShot: &v1.ShotRequest{Width: 720, Height: PageCheckHeight, Page: &v1.PageShot{Path: "allowed.html", SettleMs: 5000}}},
		{name: "nobody owns it", req: &v1.CheckPageRequest{Path: "new.html", ThreadId: "t-1"}, code: connect.CodeFailedPrecondition, errSubstr: "view.inline"},
		{name: "refused", req: &v1.CheckPageRequest{Path: "refused.html"}, code: connect.CodeFailedPrecondition},
		{name: "not a page", req: &v1.CheckPageRequest{Path: "notes.txt"}, code: connect.CodeInvalidArgument},
		{name: "settle past the bound", req: &v1.CheckPageRequest{Path: "owned.html", SettleMs: 30000}, code: connect.CodeInvalidArgument},
		{name: "width past the bound", req: &v1.CheckPageRequest{Path: "owned.html", Width: 99}, code: connect.CodeInvalidArgument},
		{name: "no app window", req: &v1.CheckPageRequest{Path: "owned.html"}, noApp: true, code: connect.CodeFailedPrecondition, errSubstr: "no Code Foundry window is open"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := shot.New(shot.WithTimeout(time.Second))
			h := NewPage(e.store, e.root, nil).WithChecks(b)
			got := make(chan *v1.ShotRequest, 1)
			if !tt.noApp {
				reqs, _, disconnect := b.Connect()
				t.Cleanup(disconnect)
				go func() {
					select {
					case r := <-reqs:
						got <- r
						_ = b.Publish(&v1.PublishShotRequest{Id: r.GetId(), PageReport: report})
					case <-time.After(2 * time.Second):
					}
				}()
			}
			m := tt.req
			m.Path = filepath.Join(e.root, m.GetPath())
			res, err := h.CheckPage(context.Background(), connect.NewRequest(m))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code || !strings.Contains(err.Error(), tt.errSubstr) {
					t.Fatalf("err = %v, want %v with %q", err, tt.code, tt.errSubstr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			r := <-got
			r.Id = ""
			want := tt.wantShot
			want.Page.Path = filepath.Join(e.root, want.GetPage().GetPath())
			if r.String() != want.String() {
				t.Errorf("shot request = %v, want %v", r, want)
			}
			if res.Msg.GetReport() != report || res.Msg.GetThreadId() != want.GetPage().GetThreadId() || res.Msg.GetWidth() != want.GetWidth() || res.Msg.GetPath() != want.GetPage().GetPath() {
				t.Errorf("response %v", res.Msg)
			}
		})
	}
}
