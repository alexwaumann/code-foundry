package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// RemoveWorktree asks the cleanup hold (fuzz finding git 6): a held worktree is
// refused, naming the holder, unless force.
func TestProjectRemoveWorktreeHold(t *testing.T) {
	b := bus.New()
	fake := projecttest.New(b)
	held := "thread fix login is on it"
	route := NewProject(fake, b).WithCleanupHold(func(w project.Worktree) string {
		if strings.HasSuffix(w.Path, "/held") {
			return held
		}
		return ""
	}).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := codefoundryv1connect.NewProjectServiceClient(srv.Client(), srv.URL)
	ctx := context.Background()

	reg, err := c.Register(ctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: "/code/proj"}))
	if err != nil {
		t.Fatal(err)
	}
	id := reg.Msg.GetProject().GetId()
	for _, br := range []string{"held", "free"} {
		if _, err := c.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{ProjectId: id, Branch: br})); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		path  string
		force bool
		want  connect.Code
	}{
		{path: "/worktrees/_local/proj/held", want: connect.CodeFailedPrecondition},
		{path: "/worktrees/_local/proj/free"},
		{path: "/worktrees/_local/proj/held", force: true},
	}
	for _, tc := range cases {
		_, err := c.RemoveWorktree(ctx, connect.NewRequest(&v1.RemoveWorktreeRequest{ProjectId: id, Path: tc.path, Force: tc.force}))
		if got := connect.CodeOf(err); err != nil && got != tc.want || err == nil && tc.want != 0 {
			t.Fatalf("RemoveWorktree(%s, force %v) = %v; want %v", tc.path, tc.force, err, tc.want)
		}
		if err != nil && !strings.Contains(err.Error(), held) {
			t.Errorf("error %q does not name the holder", err)
		}
	}
}
