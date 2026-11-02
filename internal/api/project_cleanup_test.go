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
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// CleanupWorktrees reports only what it removed, each with its kind; a worktree it keeps
// is not listed. With a path, a kept worktree fails the call with why (a dry run lists
// nothing instead: the real run fetches first).
func TestProjectCleanupWorktreesReportsRemovedOnly(t *testing.T) {
	b := bus.New()
	fake := projecttest.New(b)
	mux := http.NewServeMux()
	route := NewProject(fake, b).Route()
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
	now := time.Now()
	paths := map[string]string{}
	for _, br := range []string{"cf/merged", "cf/squashed", "cf/empty", "cf/ahead", "cf/dirty"} {
		w, err := fake.CreateWorktree(ctx, project.CreateWorktreeOptions{ProjectID: id, Branch: br})
		if err != nil {
			t.Fatal(err)
		}
		paths[br] = w.Path
		w.Managed, w.Head, w.CreatedHead, w.CreatedAt = true, "c2", "c1", now.Add(-time.Hour)
		w.Status = project.Status{BaseRef: "origin/main", RefreshedAt: now}
		switch br {
		case "cf/squashed":
			w.Status.BaseAhead, w.Status.BaseMerged = 2, true
		case "cf/empty":
			w.Head = "c1"
		case "cf/ahead":
			w.Status.BaseAhead = 1
		case "cf/dirty":
			w.Status.Modified, w.Status.Dirty = 1, true
		}
		fake.UpdateWorktree(w)
	}

	dry, err := c.CleanupWorktrees(ctx, connect.NewRequest(&v1.CleanupWorktreesRequest{Project: id, DryRun: true}))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]v1.CleanupKind{}
	for _, r := range dry.Msg.GetRemoved() {
		got[r.GetWorktree().GetBranch()] = r.GetKind()
	}
	want := map[string]v1.CleanupKind{
		"cf/merged":   v1.CleanupKind_CLEANUP_KIND_MERGED,
		"cf/squashed": v1.CleanupKind_CLEANUP_KIND_SQUASH_MERGED,
		"cf/empty":    v1.CleanupKind_CLEANUP_KIND_NO_COMMITS,
	}
	if len(got) != len(want) {
		t.Fatalf("removed = %v, want %v", got, want)
	}
	for br, k := range want {
		if got[br] != k {
			t.Errorf("%s kind = %v, want %v", br, got[br], k)
		}
	}

	tests := []struct {
		name    string
		path    string
		dry     bool
		wantErr string
	}{
		{name: "dirty, real run", path: paths["cf/dirty"], wantErr: "cf/dirty was not removed: uncommitted changes"},
		{name: "unmerged, real run", path: paths["cf/ahead"], wantErr: "cf/ahead was not removed: 1 commit not in origin/main"},
		{name: "unmerged, dry run", path: paths["cf/ahead"], dry: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := c.CleanupWorktrees(ctx, connect.NewRequest(&v1.CleanupWorktreesRequest{Project: id, Path: tt.path, DryRun: tt.dry}))
			if tt.wantErr != "" {
				if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want FailedPrecondition %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || len(res.Msg.GetRemoved()) != 0 {
				t.Fatalf("= %v, %v; want nothing removed and no error", res, err)
			}
		})
	}
}
