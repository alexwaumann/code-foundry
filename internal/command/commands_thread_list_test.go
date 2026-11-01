package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestThreadList(t *testing.T) {
	ago := func(d time.Duration) *timestamppb.Timestamp { return timestamppb.New(time.Now().Add(-d)) }
	projects := []*v1.Project{{Id: "r1", Name: "app", Worktrees: []*v1.Worktree{
		{ProjectId: "r1", Path: "/src/app", Branch: "main"}, {ProjectId: "r1", Path: "/wt/fix", Branch: "cf/fix"}}}}
	busy := &v1.Thread{Id: "s-7754a478e649", Name: "Fix the login", ProjectId: "r1", WorktreePath: "/wt/fix",
		Status: v1.ThreadStatus_THREAD_STATUS_BUSY, StatusReason: "working", LastActivityAt: ago(5 * time.Minute)}
	child := &v1.Thread{Id: "s-867564981c98", ProjectId: "r1", WorktreePath: "/src/app",
		Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "finished", LastActivityAt: ago(3 * time.Hour),
		CreatedBy: "s-7754a478e649", CreatedByName: "Fix the login"}
	renamed := proto.CloneOf(busy)
	renamed.Name = "Fix the login, again"
	home := &v1.Thread{Id: "s-000000000001", Name: "notes", Status: v1.ThreadStatus_THREAD_STATUS_ERROR, StatusReason: "interrupted",
		WorktreePath: "/Users/me", CreatedAt: ago(72 * time.Hour), ArchivedAt: ago(time.Hour)}
	inWorkspace := &v1.Thread{Id: "s-00000000000b", ProjectIds: []string{"r1"}, WorkspaceId: "w-000000000001", WorktreePath: "/cf/workspaces/w-000000000001"}
	inGoneWorkspace := &v1.Thread{Id: "s-00000000000c", WorkspaceId: "w-0000000000ff", WorktreePath: "/cf/workspaces/w-0000000000ff"}
	tests := []struct {
		name       string
		args       map[string]string
		caller     string // the context thread
		threads    []*v1.Thread
		removed    []*v1.RemovedThread
		wantFilter *v1.ThreadFilter
		wantLines  []string // substrings, one per output line
		wantLookup bool     // a creator is looked up in an unfiltered list
		wantCode   connect.Code
	}{
		{name: "defaults", threads: []*v1.Thread{busy, child, home},
			wantFilter: &v1.ThreadFilter{Limit: 50},
			wantLines: []string{
				"s-7754a478e649  busy                  Fix the login  app@cf/fix  5m",
				"s-867564981c98  attention (finished)  (unnamed)      app@main    3h  ↳ Fix the login",
				"s-000000000001  error (interrupted)   notes          no project  3d  [archived]",
			}},
		// The caller's own row says so (W3: an orchestrator took itself for another).
		{name: "the caller's row", caller: "s-7754a478e649", threads: []*v1.Thread{busy, child},
			wantFilter: &v1.ThreadFilter{Limit: 50},
			wantLines: []string{
				"s-7754a478e649  busy                  Fix the login (you)  app@cf/fix  5m",
				"s-867564981c98  attention (finished)  (unnamed)            app@main    3h  ↳ Fix the login",
			}},
		// Residents are asked for with --resident, and marked.
		{name: "residents", args: map[string]string{"resident": "true"}, threads: []*v1.Thread{
			{Id: "s-0000000000e1", Name: "Ember", Kind: v1.ThreadKind_THREAD_KIND_RESIDENT, ResidentName: "ember", WorktreePath: "/home/residents/ember",
				Status: v1.ThreadStatus_THREAD_STATUS_IDLE, StatusReason: "at prompt", LastActivityAt: ago(time.Minute)}},
			wantFilter: &v1.ThreadFilter{IncludeResident: true, Limit: 50},
			wantLines:  []string{"s-0000000000e1  idle  Ember  no project  1m  [resident ember]"}},
		// A thread whose transcript Claude Code deleted cannot continue: marked first.
		{name: "transcript deleted", threads: []*v1.Thread{{Id: "s-0000000000d1", Name: "old work", WorktreePath: "/Users/me",
			Status: v1.ThreadStatus_THREAD_STATUS_IDLE, StatusReason: "at prompt", LastActivityAt: ago(40 * 24 * time.Hour),
			TranscriptMissing: true, ArchivedAt: ago(time.Hour)}},
			wantFilter: &v1.ThreadFilter{Limit: 50},
			wantLines:  []string{"s-0000000000d1  idle  old work  no project  40d  [transcript deleted, archived]"}},
		{name: "a caller not in the list", caller: "s-999999999999", threads: []*v1.Thread{busy},
			wantFilter: &v1.ThreadFilter{Limit: 50}, wantLines: []string{"s-7754a478e649  busy  Fix the login  app@cf/fix  5m"}},
		// The creator is resolved by its id: its current name, not the recorded one.
		{name: "a renamed creator shows its current name", threads: []*v1.Thread{renamed, child},
			wantFilter: &v1.ThreadFilter{Limit: 50},
			wantLines: []string{
				"s-7754a478e649  busy                  Fix the login, again",
				"s-867564981c98  attention (finished)  (unnamed)             app@main    3h  ↳ Fix the login, again",
			}},
		// A creator not in the list (left out by the filter, or removed) is looked up in
		// one unfiltered list; a removed one keeps its recorded name.
		{name: "a creator not in the list", args: map[string]string{"status": "attention"}, threads: []*v1.Thread{child},
			wantFilter: &v1.ThreadFilter{Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, Limit: 50}, wantLookup: true,
			wantLines: []string{"s-867564981c98  attention (finished)  (unnamed)  app@main  3h  ↳ Fix the login"}},
		{name: "every filter", args: map[string]string{"archived": "true", "status": "attention", "state": "disconnected", "project": "app",
			"workspace": "w", "created-by": "user", "label": "a, b", "limit": "0"},
			wantFilter: &v1.ThreadFilter{IncludeArchived: true, Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION,
				State: v1.ThreadState_THREAD_STATE_DISCONNECTED, Project: "app", Workspace: "w", CreatedBy: "user", Labels: []string{"a", "b"}},
			wantLines: []string{"no threads"}},
		{name: "all", args: map[string]string{"all": "true"}, wantFilter: &v1.ThreadFilter{All: true, IncludeRemoved: true, Limit: 50}, wantLines: []string{"no threads"}},
		// --all composes: the other filters go to the daemon with it.
		{name: "all with filters", args: map[string]string{"all": "true", "label": "x", "status": "error"}, threads: []*v1.Thread{home},
			wantFilter: &v1.ThreadFilter{All: true, IncludeRemoved: true, Status: v1.ThreadStatus_THREAD_STATUS_ERROR, Labels: []string{"x"}, Limit: 50},
			wantLines:  []string{"s-000000000001  error (interrupted)  notes  no project  3d  [archived]"}},
		// Removed threads follow, aligned with the others; their creator by current name.
		{name: "all lists removed threads", args: map[string]string{"all": "true"}, threads: []*v1.Thread{busy},
			removed:    []*v1.RemovedThread{{Id: "s-00000000000a", Name: "Slow child", CreatedBy: "s-7754a478e649", RemovedAt: ago(2 * time.Minute)}},
			wantFilter: &v1.ThreadFilter{All: true, IncludeRemoved: true, Limit: 50},
			wantLines: []string{
				"s-7754a478e649  busy  Fix the login  app@cf/fix  5m",
				"s-00000000000a  -     Slow child     -           2m  [removed]  ↳ Fix the login",
			}},
		{name: "only removed threads", args: map[string]string{"all": "true"},
			removed:    []*v1.RemovedThread{{Id: "s-00000000000a", RemovedAt: ago(time.Minute)}},
			wantFilter: &v1.ThreadFilter{All: true, IncludeRemoved: true, Limit: 50},
			wantLines:  []string{"s-00000000000a  -  (unnamed)  -  1m  [removed]"}},
		{name: "empty says archived threads are left out", wantFilter: &v1.ThreadFilter{Limit: 50},
			wantLines: []string{"no threads (archived threads are left out; --archived includes them)"}},
		{name: "the limit is said when reached", args: map[string]string{"limit": "1"}, threads: []*v1.Thread{busy},
			wantFilter: &v1.ThreadFilter{Limit: 1},
			wantLines:  []string{"s-7754a478e649", "(the 1 most recently active; --limit 0 lists all)"}},
		{name: "created-by takes a suffix", args: map[string]string{"created-by": "a478e649"}, threads: []*v1.Thread{busy},
			wantFilter: &v1.ThreadFilter{CreatedBy: "s-7754a478e649", Limit: 50}, wantLines: []string{"s-7754a478e649"}},
		{name: "created-by an unknown suffix", args: map[string]string{"created-by": "ffff"}, wantCode: connect.CodeNotFound},
		{name: "a negative limit", args: map[string]string{"limit": "-1"}, wantCode: connect.CodeInvalidArgument},
		// A thread in its workspace's folder shows the workspace's name, not the folder's (fuzz finding A9).
		{name: "a thread in its workspace folder", threads: []*v1.Thread{inWorkspace, inGoneWorkspace}, wantFilter: &v1.ThreadFilter{Limit: 50},
			wantLines: []string{"s-00000000000b  starting  (unnamed)  shop            -", "s-00000000000c  starting  (unnamed)  w-0000000000ff  -"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Thread{Removed: tt.removed}
			if len(tt.threads) > 0 {
				b.Current, b.Others = tt.threads[0], tt.threads[1:]
			}
			if err := command.RegisterThreadList(reg, command.ThreadListDeps{Thread: b, Project: &commandtest.Project{Projects: projects},
				Workspace: listWorkspaces{ws: []*v1.Workspace{{Id: "w-000000000001", Name: "shop"}}}}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: tt.caller}, "thread.list", tt.args)
			if tt.wantCode == connect.CodeInvalidArgument {
				if !errors.Is(err, command.ErrInvalidArgs) {
					t.Fatalf("err = %v, want an argument error", err)
				}
				return
			}
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want %v", err, tt.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got *v1.ThreadFilter
			// The last but the lookups (filter all, no limit): created-by's suffix lists
			// them all first, a creator left out of the list is looked up after.
			lookup := &v1.ThreadFilter{All: true}
			lookedUp := false
			for _, r := range b.Requests() {
				if l, ok := r.(*v1.ListThreadsRequest); ok {
					if !proto.Equal(l.GetFilter(), lookup) {
						got = l.GetFilter()
					} else if got != nil {
						lookedUp = true
					}
				}
			}
			if lookedUp != tt.wantLookup {
				t.Errorf("looked up creators = %v, want %v", lookedUp, tt.wantLookup)
			}
			if !proto.Equal(got, tt.wantFilter) {
				t.Errorf("filter = %v, want %v", got, tt.wantFilter)
			}
			lines := strings.Split(res.Message, "\n")
			if len(lines) != len(tt.wantLines) {
				t.Fatalf("output =\n%s\nwant %d lines", res.Message, len(tt.wantLines))
			}
			for i, want := range tt.wantLines {
				if !strings.Contains(lines[i], want) {
					t.Errorf("line %d = %q, want %q in it", i, lines[i], want)
				}
			}
			js, ok := res.JSON.(*v1.ListThreadsResponse)
			if !ok {
				t.Fatalf("JSON = %T", res.JSON)
			}
			for _, s := range js.GetThreads() {
				if s.GetIsCaller() != (s.GetId() == tt.caller) {
					t.Errorf("thread %s isCaller = %v", s.GetId(), s.GetIsCaller())
				}
			}
			if busy.GetIsCaller() {
				t.Error("the backend's thread was changed")
			}
		})
	}
}

// listWorkspaces is a WorkspaceBackend whose List answers ws.
type listWorkspaces struct {
	codefoundryv1connect.UnimplementedWorkspaceServiceHandler
	ws []*v1.Workspace
}

func (l listWorkspaces) List(context.Context, *connect.Request[v1.ListWorkspacesRequest]) (*connect.Response[v1.ListWorkspacesResponse], error) {
	return connect.NewResponse(&v1.ListWorkspacesResponse{Workspaces: l.ws}), nil
}
