package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

// refusingRegister fails Register for one path, like a child the store cannot add.
type refusingRegister struct {
	*api.Project
	fail string
}

func (r refusingRegister) Register(ctx context.Context, req *connect.Request[v1.RegisterProjectRequest]) (*connect.Response[v1.RegisterProjectResponse], error) {
	if req.Msg.GetPath() == r.fail {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New(r.fail+": permission denied"))
	}
	return r.Project.Register(ctx, req)
}

func TestProjectAddWorkspace(t *testing.T) {
	const product = "/Users/me/product"
	children := []project.ChildRepo{{Path: product + "/api", Name: "api"}, {Path: product + "/docs", Name: "docs"}, {Path: product + "/web", Name: "web"}}
	folders := map[string]project.Folder{
		product:            {Path: product, ChildRepos: children},
		"/Users/me/repo":   {Path: "/Users/me/repo", IsRepo: true},
		"/Users/me/plain":  {Path: "/Users/me/plain"},
		"/Users/me/single": {Path: "/Users/me/single", ChildRepos: []project.ChildRepo{{Path: "/Users/me/single/one", Name: "one"}}},
	}
	tests := []struct {
		name       string
		folder     string
		registered []string // project paths added before
		workspaces []string // workspace names taken before
		fail       string   // a child path Register refuses
		wantErr    string
		wantCode   connect.Code
		wantName   string
		wantMsg    string   // a substring of the message
		wantAdded  []string // paths Register was called with
		wantCount  int      // projects registered afterwards
	}{
		{name: "a folder of repos becomes a rooted workspace", folder: product, wantName: "product", wantCount: 3,
			wantAdded: []string{product + "/api", product + "/docs", product + "/web"},
			wantMsg:   "created workspace product (w-1): 3 projects"},
		{name: "one repo is enough", folder: "/Users/me/single", wantName: "single", wantCount: 1, wantAdded: []string{"/Users/me/single/one"}},
		{name: "registered children are reused", folder: product, registered: []string{product + "/docs"}, wantName: "product", wantCount: 3,
			wantAdded: []string{product + "/api", product + "/web"}, wantMsg: "added 2 projects, 1 already added (docs)"},
		{name: "a taken name gets a number", folder: product, workspaces: []string{"Product"}, wantName: "product 2", wantCount: 3,
			wantAdded: []string{product + "/api", product + "/docs", product + "/web"}},
		{name: "a repository is refused", folder: "/Users/me/repo", wantCode: connect.CodeFailedPrecondition,
			wantErr: "/Users/me/repo is a git repository: add it as a project"},
		{name: "a folder without repos is refused", folder: "/Users/me/plain", wantCode: connect.CodeFailedPrecondition,
			wantErr: "no git repositories directly inside /Users/me/plain"},
		{name: "a child that fails: the others stay, no workspace", folder: product, fail: product + "/docs", wantCode: connect.CodeInvalidArgument,
			wantErr:   "could not add 1 of 3 repositories in /Users/me/product (docs: /Users/me/product/docs: permission denied); no workspace was made; added and kept as projects: api, web",
			wantAdded: []string{product + "/api", product + "/web"}, wantCount: 2},
		{name: "a folder outside home is refused before anything", folder: "/elsewhere", wantCode: connect.CodeInvalidArgument, wantErr: "outside your home directory"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HOME", "/Users/me")
			b := bus.New()
			projects := projecttest.New(b)
			projects.AllowedRoot = "/Users/me"
			projects.Folders = folders
			for _, p := range tt.registered {
				if _, err := projects.Register(context.Background(), p); err != nil {
					t.Fatal(err)
				}
			}
			spaces := workspacetest.New(b)
			for _, n := range tt.workspaces {
				spaces.Put(workspace.Workspace{ID: "w-old-" + n, Name: n})
			}
			projects.Calls = nil
			var backend command.FolderBackend = api.NewProject(projects, b)
			if tt.fail != "" {
				backend = refusingRegister{Project: api.NewProject(projects, b), fail: tt.fail}
			}
			reg := command.NewRegistry()
			if err := command.RegisterProjectAddWorkspace(reg, backend, api.NewWorkspace(spaces, b)); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, "project.add-workspace", map[string]string{"folder": tt.folder})

			var added []string
			for _, c := range projects.Calls {
				if p, ok := strings.CutPrefix(c, "Register "); ok {
					added = append(added, p)
				}
			}
			slices.Sort(added)
			if !slices.Equal(added, tt.wantAdded) {
				t.Errorf("registered %v, want %v", added, tt.wantAdded)
			}
			if n := len(projects.Snapshot().Projects); n != tt.wantCount {
				t.Errorf("%d projects afterwards, want %d", n, tt.wantCount)
			}
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) || connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v (%v), want %v containing %q", err, connect.CodeOf(err), tt.wantCode, tt.wantErr)
				}
				if n := len(spaces.Snapshot().Workspaces); n != len(tt.workspaces) {
					t.Errorf("%d workspaces after a refusal", n)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			w, ok := spaces.Snapshot().Named(tt.wantName)
			if !ok {
				t.Fatalf("no workspace %q: %+v", tt.wantName, spaces.Snapshot().Workspaces)
			}
			var wantMembers []string
			for _, p := range projects.Snapshot().Projects {
				wantMembers = append(wantMembers, p.ID)
			}
			slices.Sort(wantMembers)
			if w.RootPath != tt.folder || w.DefaultPrimary != workspace.PrimaryWorkspace || !slices.Equal(w.Members, wantMembers) {
				t.Errorf("workspace = %+v, want root %s, primary workspace, members %v", w, tt.folder, wantMembers)
			}
			if got, ok := res.JSON.(*v1.Workspace); !ok || got.GetId() != w.ID {
				t.Errorf("JSON = %#v, want the workspace %s", res.JSON, w.ID)
			}
			if tt.wantMsg != "" && !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want containing %q", res.Message, tt.wantMsg)
			}
		})
	}
}
