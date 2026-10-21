package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// projects.base_from_origin reaches CreateWorktree and decides ListRefs' default ref
// per call; without WithBaseFromOrigin it is on.
func TestProjectBaseFromOrigin(t *testing.T) {
	b := bus.New()
	fake := projecttest.New(b)
	var on atomic.Bool
	on.Store(true)
	route := NewProject(fake, b).WithBaseFromOrigin(on.Load).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := codefoundryv1connect.NewProjectServiceClient(srv.Client(), srv.URL)
	ctx := context.Background()
	r, _ := fake.Register(ctx, "/code/proj")
	fake.SetRefs(r.ID, project.Refs{Local: []string{"main"}, Remote: []string{"origin/main"}, DefaultRef: "origin/main", DefaultBranch: "main"})

	for _, tt := range []struct {
		on          bool
		wantDefault string
	}{{true, "origin/main"}, {false, "main"}} {
		on.Store(tt.on)
		res, err := c.ListRefs(ctx, connect.NewRequest(&v1.ListRefsRequest{ProjectId: r.ID}))
		if err != nil {
			t.Fatal(err)
		}
		if got := res.Msg.GetDefaultRef(); got != tt.wantDefault {
			t.Errorf("on=%v: default ref = %q, want %q", tt.on, got, tt.wantDefault)
		}
		if _, err := c.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{
			ProjectId: r.ID, Branch: "b-" + tt.wantDefault, BaseRef: "main", Fetch: true,
		})); err != nil {
			t.Fatal(err)
		}
		if got := fake.Creates[len(fake.Creates)-1]; got.BaseFromOrigin != tt.on {
			t.Errorf("on=%v: store got BaseFromOrigin=%v", tt.on, got.BaseFromOrigin)
		}
	}

	// The default handler (no WithBaseFromOrigin) is on.
	route = NewProject(fake, b).Route()
	mux = http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv2 := httptest.NewServer(mux)
	t.Cleanup(srv2.Close)
	c = codefoundryv1connect.NewProjectServiceClient(srv2.Client(), srv2.URL)
	if _, err := c.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{ProjectId: r.ID, Branch: "b-default"})); err != nil {
		t.Fatal(err)
	}
	if got := fake.Creates[len(fake.Creates)-1]; !got.BaseFromOrigin {
		t.Error("default handler passed BaseFromOrigin=false")
	}
}
