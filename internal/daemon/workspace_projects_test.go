package daemon

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

func TestWorkspaceInUse(t *testing.T) {
	w := workspace.Workspace{ID: "w-1", Name: "shop", ManagedDir: "/cfg/workspaces/w-1"}
	archived := time.Unix(1, 0)
	tests := []struct {
		name    string
		threads []thread.Thread
		want    string // "" for no error
	}{
		{name: "nobody there", threads: []thread.Thread{{ID: "s-1", WorktreePath: "/src/web"}}},
		{name: "one thread", threads: []thread.Thread{{ID: "s-1", Name: "t", WorktreePath: "/cfg/workspaces/w-1"}},
			want: "thread t (s-1) runs in its folder; archive it or move it with thread run-in"},
		{name: "two, one unnamed", threads: []thread.Thread{
			{ID: "s-1", Name: "t", WorktreePath: "/cfg/workspaces/w-1"}, {ID: "s-2", WorktreePath: "/cfg/workspaces/w-1/sub"}},
			want: "threads t (s-1), s-2 run in its folder; archive them or move them with thread run-in"},
		{name: "archived or removing", threads: []thread.Thread{
			{ID: "s-1", WorktreePath: "/cfg/workspaces/w-1", ArchivedAt: archived}, {ID: "s-2", WorktreePath: "/cfg/workspaces/w-1", Removing: true}}},
		{name: "another workspace's folder", threads: []thread.Thread{{ID: "s-1", WorktreePath: "/cfg/workspaces/w-10"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := workspaceInUse(&thread.Snapshot{Threads: tt.threads}, w)
			if got := ""; err != nil {
				got = err.Error()
				if got != tt.want {
					t.Fatalf("err %q, want %q", got, tt.want)
				}
			} else if tt.want != "" {
				t.Fatalf("no error, want %q", tt.want)
			}
		})
	}
}

// Unregistered members leave their workspaces at start and when the project store
// removes a project.
func TestWorkspaceProjectsGlue(t *testing.T) {
	b := bus.New()
	ws := workspacetest.New(b)
	ws.Put(workspace.Workspace{ID: "w-1", Name: "a", Members: []string{"r-gone", "r-web"}, DefaultPrimary: "r-gone"})
	ws.Put(workspace.Workspace{ID: "w-2", Name: "b", Members: []string{"r-api", "r-web"}, DefaultPrimary: "r-web"})
	projects := &project.Snapshot{Projects: []project.Project{{ID: "r-web"}, {ID: "r-api"}}}
	if got := unregisteredMembers(ws.Snapshot(), projects); !slices.Equal(got, []string{"r-gone"}) {
		t.Fatalf("unregisteredMembers = %v", got)
	}
	stop := startWorkspaceProjects(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), ws, func() *project.Snapshot { return projects }, b)
	defer stop()
	if w, _ := ws.Snapshot().Workspace("w-1"); w.Member("r-gone") || w.DefaultPrimary != workspace.PrimaryWorkspace {
		t.Fatalf("at start: %+v", w)
	}
	bus.Publish[project.Event](b, project.ProjectRemoved{ID: "r-web"})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if w, _ := ws.Snapshot().Workspace("w-2"); !w.Member("r-web") {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	for _, id := range []string{"w-1", "w-2"} {
		if w, _ := ws.Snapshot().Workspace(id); w.Member("r-web") {
			t.Errorf("%s still has r-web: %+v", id, w)
		}
	}
	if calls := strings.Join(ws.Calls(), ","); !strings.Contains(calls, "ProjectRemoved r-gone") || !strings.Contains(calls, "ProjectRemoved r-web") {
		t.Errorf("calls %s", calls)
	}
}
