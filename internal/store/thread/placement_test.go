package thread

import (
	"errors"
	"slices"
	"testing"
)

// The inheritance matrix (docs/notes/workspaces-v2-handoff.md §4): a thread made inside
// another copies its set, branch, workspace, primary and mode unless told otherwise;
// like is the same, explicit.
func TestDecidePlacement(t *testing.T) {
	// A multi-project parent in worktree mode on feat/x, running in web.
	wtParent := Thread{ID: "p", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: "/wt/web/feat-x",
		CreatedWorktree: true, Branch: "feat/x", WorkspaceID: "w-1"}
	wtCheckouts := []Checkout{
		{ProjectID: "api", Path: "/wt/api/feat-x"},
		{ProjectID: "web", Path: "/wt/web/feat-x", Primary: true},
	}
	// A single-project parent in a user's own worktree (checkout mode).
	coParent := Thread{ID: "q", ProjectID: "web", ProjectIDs: []string{"web"}, WorktreePath: "/src/web-hotfix"}
	coCheckouts := []Checkout{{ProjectID: "web", Path: "/src/web-hotfix", Primary: true}}
	home := Thread{ID: "h", WorktreePath: "/home/u"}
	// A parent running in its workspace's folder (no project is its primary).
	wsParent := Thread{ID: "w", ProjectIDs: []string{"api", "web"}, WorktreePath: "/cf/workspaces/w-2", WorkspaceID: "w-2"}

	tests := []struct {
		name     string
		src      *Thread
		cos      []Checkout
		explicit bool
		req      placeRequest
		want     placement
		wantErr  error
	}{
		{name: "no thread: one project, its checkout", req: placeRequest{primary: "web"},
			want: placement{projectIDs: []string{"web"}, primary: "web"}},
		{name: "no thread: a set, the first given is the primary", req: placeRequest{projectIDs: []string{"web", "api"}},
			want: placement{projectIDs: []string{"api", "web"}, primary: "web"}},
		{name: "no thread: a set with a new branch", req: placeRequest{projectIDs: []string{"web", "api"}, primary: "api", newBranch: true},
			want: placement{projectIDs: []string{"api", "web"}, primary: "api", worktreeMode: true, newBranch: true}},
		{name: "no thread: a worktree path", req: placeRequest{worktree: "/src/web-2", worktreeProject: "web"},
			want: placement{projectIDs: []string{"web"}, primary: "web", primaryPath: "/src/web-2"}},
		{name: "no thread: primary outside the set", req: placeRequest{projectIDs: []string{"api"}, primary: "web"}, wantErr: ErrInvalidArgument},
		{name: "no thread: nothing", req: placeRequest{}, wantErr: ErrInvalidArgument},

		{name: "inherit everything", src: &wtParent, cos: wtCheckouts, req: placeRequest{},
			want: placement{projectIDs: []string{"api", "web"}, primary: "web", worktreeMode: true, branch: "feat/x", workspaceID: "w-1", from: "p"}},
		{name: "inherit: project alone picks the primary", src: &wtParent, cos: wtCheckouts, req: placeRequest{primary: "api"},
			want: placement{projectIDs: []string{"api", "web"}, primary: "api", worktreeMode: true, branch: "feat/x", workspaceID: "w-1", from: "p"}},
		{name: "inherit: projects narrows", src: &wtParent, cos: wtCheckouts, req: placeRequest{projectIDs: []string{"api"}},
			want: placement{projectIDs: []string{"api"}, primary: "api", worktreeMode: true, branch: "feat/x", workspaceID: "w-1", from: "p"}},
		{name: "inherit: new-worktree branches off (the orchestrate skill's child)", src: &wtParent, cos: wtCheckouts,
			req:  placeRequest{primary: "web", newBranch: true},
			want: placement{projectIDs: []string{"api", "web"}, primary: "web", worktreeMode: true, newBranch: true, workspaceID: "w-1", from: "p"}},
		{name: "inherit: new-worktree=false runs in the checkouts", src: &wtParent, cos: wtCheckouts, req: placeRequest{checkoutMode: true},
			want: placement{projectIDs: []string{"api", "web"}, primary: "web", workspaceID: "w-1", from: "p"}},
		{name: "inherit: a worktree that is one of the parent's checkouts picks the primary", src: &wtParent, cos: wtCheckouts,
			req:  placeRequest{worktree: "/wt/api/feat-x", worktreeProject: "api"},
			want: placement{projectIDs: []string{"api", "web"}, primary: "api", worktreeMode: true, branch: "feat/x", workspaceID: "w-1", from: "p"}},
		{name: "inherit: a project outside the set places it there", src: &wtParent, cos: wtCheckouts, req: placeRequest{primary: "docs"},
			want: placement{projectIDs: []string{"docs"}, primary: "docs"}},
		{name: "inherit: a worktree outside the checkouts places it there", src: &wtParent, cos: wtCheckouts,
			req:  placeRequest{worktree: "/src/web", worktreeProject: "web"},
			want: placement{projectIDs: []string{"web"}, primary: "web", primaryPath: "/src/web"}},
		{name: "inherit: a parent in its own worktree keeps that cwd", src: &coParent, cos: coCheckouts, req: placeRequest{primary: "web"},
			want: placement{projectIDs: []string{"web"}, primary: "web", primaryPath: "/src/web-hotfix", from: "q"}},
		{name: "inherit: nothing from a parent without a project", src: &home, req: placeRequest{primary: "web"},
			want: placement{projectIDs: []string{"web"}, primary: "web"}},
		{name: "inherit: nothing to place from a parent without a project", src: &home, req: placeRequest{}, wantErr: ErrInvalidArgument},

		{name: "like: copies", src: &wtParent, cos: wtCheckouts, explicit: true, req: placeRequest{},
			want: placement{projectIDs: []string{"api", "web"}, primary: "web", worktreeMode: true, branch: "feat/x", workspaceID: "w-1", from: "p"}},
		{name: "like: new branch", src: &wtParent, cos: wtCheckouts, explicit: true, req: placeRequest{newBranch: true},
			want: placement{projectIDs: []string{"api", "web"}, primary: "web", worktreeMode: true, newBranch: true, workspaceID: "w-1", from: "p"}},
		{name: "like: a project outside the set is an error", src: &wtParent, cos: wtCheckouts, explicit: true, req: placeRequest{primary: "docs"},
			wantErr: ErrInvalidArgument},
		{name: "like: a worktree outside the checkouts is an error", src: &wtParent, cos: wtCheckouts, explicit: true,
			req: placeRequest{worktree: "/src/web", worktreeProject: "web"}, wantErr: ErrInvalidArgument},
		{name: "like: projects with a primary outside them", src: &wtParent, cos: wtCheckouts, explicit: true,
			req: placeRequest{projectIDs: []string{"api"}, primary: "web"}, wantErr: ErrInvalidArgument},
		{name: "like: a thread without a project", src: &home, explicit: true, req: placeRequest{},
			want: placement{noProject: true, primaryPath: "/home/u", from: "h"}},
		{name: "workspace: its members, its default primary", src: &wtParent, cos: wtCheckouts,
			req:  placeRequest{workspaceID: "w-2", wsMembers: []string{"web", "docs"}, wsDefault: "web"},
			want: placement{projectIDs: []string{"docs", "web"}, primary: "web", workspaceID: "w-2"}},
		{name: "workspace: its folder by default", req: placeRequest{workspaceID: "w-2", wsMembers: []string{"web"}, wsDefault: "workspace"},
			want: placement{projectIDs: []string{"web"}, workspacePrimary: true, workspaceID: "w-2"}},
		{name: "workspace: its folder asked for, in worktree mode", req: placeRequest{workspaceID: "w-2", wsMembers: []string{"web", "api"}, wsDefault: "web", wsPrimary: true, newBranch: true},
			want: placement{projectIDs: []string{"api", "web"}, workspacePrimary: true, workspaceID: "w-2", worktreeMode: true, newBranch: true}},
		{name: "workspace: projects narrow; a default outside them gives way", req: placeRequest{workspaceID: "w-2", wsMembers: []string{"web", "api"}, wsDefault: "web", projectIDs: []string{"api"}},
			want: placement{projectIDs: []string{"api"}, primary: "api", workspaceID: "w-2"}},
		{name: "workspace: no members runs in its folder", req: placeRequest{workspaceID: "w-2", wsDefault: "workspace"},
			want: placement{workspacePrimary: true, workspaceID: "w-2"}},
		{name: "workspace: a primary outside the set", req: placeRequest{workspaceID: "w-2", wsMembers: []string{"web"}, primary: "api"}, wantErr: ErrInvalidArgument},
		{name: "inherit: a parent in its workspace's folder", src: &wsParent, req: placeRequest{},
			want: placement{projectIDs: []string{"api", "web"}, workspacePrimary: true, workspaceID: "w-2", from: "w"}},
		{name: "inherit: a parent in its workspace's folder, project picks a member", src: &wsParent, req: placeRequest{primary: "api"},
			want: placement{projectIDs: []string{"api", "web"}, primary: "api", workspaceID: "w-2", from: "w"}},
		{name: "like: a thread without a project has no branch", src: &home, explicit: true, req: placeRequest{newBranch: true},
			wantErr: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decidePlacement(tt.src, tt.explicit, tt.req, tt.cos)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !samePlacement(got, tt.want) {
				t.Errorf("placement\n got %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func samePlacement(a, b placement) bool {
	return slices.Equal(a.projectIDs, b.projectIDs) && a.noProject == b.noProject && a.primary == b.primary &&
		a.primaryPath == b.primaryPath && a.worktreeMode == b.worktreeMode && a.branch == b.branch &&
		a.newBranch == b.newBranch && a.workspaceID == b.workspaceID && a.from == b.from && a.workspacePrimary == b.workspacePrimary
}
