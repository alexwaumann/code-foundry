package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
)

func TestFilesystemListDirectories(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"proj/.git", "proj-wt", "other"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	fake := repotest.New(nil)
	proj := filepath.Join(root, "proj")
	fake.Put(repo.Repo{ID: "p", Path: proj, Worktrees: []repo.Worktree{
		{RepoID: "p", Path: proj, IsMain: true},
		{RepoID: "p", Path: filepath.Join(root, "proj-wt")},
	}})

	route := NewFilesystem(root, fake).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL)
	ctx := context.Background()

	tests := []struct {
		name, prefix string
		want         []*v1.DirectoryEntry
		completion   string
		code         connect.Code // zero: success
	}{
		{name: "home", prefix: "~/", completion: "~/", want: []*v1.DirectoryEntry{
			{Path: filepath.Join(root, "other"), Name: "other"},
			{Path: proj, Name: "proj", IsGit: true, Registered: true},
			{Path: filepath.Join(root, "proj-wt"), Name: "proj-wt", Registered: true},
		}},
		{name: "prefix", prefix: "~/P", completion: "~/proj", want: []*v1.DirectoryEntry{
			{Path: proj, Name: "proj", IsGit: true, Registered: true},
			{Path: filepath.Join(root, "proj-wt"), Name: "proj-wt", Registered: true},
		}},
		{name: "outside home", prefix: "/", code: connect.CodeInvalidArgument},
		{name: "relative", prefix: "proj", code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := c.ListDirectories(ctx, connect.NewRequest(&v1.ListDirectoriesRequest{Prefix: tt.prefix}))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Fatalf("err = %v, want code %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := res.Msg
			if got.GetCompletion() != tt.completion {
				t.Errorf("completion = %q, want %q", got.GetCompletion(), tt.completion)
			}
			if len(got.GetEntries()) != len(tt.want) {
				t.Fatalf("entries = %v, want %v", got.GetEntries(), tt.want)
			}
			for i, e := range got.GetEntries() {
				w := tt.want[i]
				if e.GetPath() != w.GetPath() || e.GetName() != w.GetName() || e.GetIsGit() != w.GetIsGit() || e.GetRegistered() != w.GetRegistered() {
					t.Errorf("entry %d = %v, want %v", i, e, w)
				}
			}
		})
	}
}

func TestRepoRegisterOutsideHome(t *testing.T) {
	fake, c := newRepoServer(t)
	fake.AllowedRoot = "/Users/me"
	_, err := c.Register(context.Background(), connect.NewRequest(&v1.RegisterRepoRequest{Path: "/opt/proj"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("Register outside home err = %v, want InvalidArgument", err)
	}
}
