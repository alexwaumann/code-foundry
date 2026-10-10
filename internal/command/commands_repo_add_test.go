package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestRepoAddAndClone(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	var refs []string
	clone := func(_ context.Context, ref string, _ func(*v1.CloneProgress)) (*v1.Repo, error) {
		refs = append(refs, ref)
		if ref == "octo/taken" {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("/p/octo/taken already exists"))
		}
		return &v1.Repo{Id: "r9", Name: "hello", Path: "/p/octo/hello", Git: true}, nil
	}
	tests := []struct {
		name       string
		cmd        string
		args       map[string]string
		backendErr error
		wantMsg    string
		wantErr    string
		wantRef    string
		wantPath   string // RepoBackend.Register's path
		// wantInvalid: the error wraps command.ErrInvalidArgs.
		wantInvalid bool
	}{
		{name: "repo.add without a folder answers the CLI with a hint", cmd: "repo.add", wantMsg: command.AddProjectHint},
		{name: "repo.add with a folder registers it", cmd: "repo.add", args: map[string]string{"path": "~/src/app/"},
			wantMsg: "registered repo (r1)", wantPath: "/Users/me/src/app"},
		{name: "repo.add refuses a relative folder", cmd: "repo.add", args: map[string]string{"path": "src/app"},
			wantInvalid: true},
		{name: "repo.add refuses ~user", cmd: "repo.add", args: map[string]string{"path": "~bob/app"},
			wantInvalid: true},
		{name: "repo.add backend error passes through", cmd: "repo.add", args: map[string]string{"path": "/tmp"},
			backendErr: connect.NewError(connect.CodeInvalidArgument, errors.New("/tmp is outside your home directory")),
			wantErr:    "outside your home directory", wantPath: "/tmp"},
		{name: "repo.clone", cmd: "repo.clone", args: map[string]string{"repo": "octo/hello"},
			wantMsg: "cloned hello into /p/octo/hello (r9)", wantRef: "octo/hello"},
		{name: "repo.clone passes a URL through", cmd: "repo.clone", args: map[string]string{"repo": "https://github.com/octo/hello.git"},
			wantRef: "https://github.com/octo/hello.git"},
		{name: "repo.clone needs a repo", cmd: "repo.clone", wantErr: "repo"},
		{name: "repo.clone backend error passes through", cmd: "repo.clone", args: map[string]string{"repo": "octo/taken"},
			wantErr: "already exists", wantRef: "octo/taken"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			refs = nil
			repos := &commandtest.Repo{Err: tt.backendErr}
			reg := command.NewRegistry()
			if err := command.RegisterRepoAdd(reg, repos, clone); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			if tt.wantInvalid {
				if !errors.Is(err, command.ErrInvalidArgs) {
					t.Fatalf("err = %v, want ErrInvalidArgs", err)
				}
			} else if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			var gotPath string
			for _, m := range repos.Requests() {
				if r, ok := m.(*v1.RegisterRepoRequest); ok {
					gotPath = r.GetPath()
				}
			}
			if gotPath != tt.wantPath {
				t.Errorf("registered %q, want %q", gotPath, tt.wantPath)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if got := strings.Join(refs, ","); got != tt.wantRef {
				t.Errorf("cloned %q, want %q", got, tt.wantRef)
			}
		})
	}
	t.Run("unconfigured backends are Unimplemented", func(t *testing.T) {
		reg := command.NewRegistry()
		if err := command.RegisterRepoAdd(reg, nil, nil); err != nil {
			t.Fatal(err)
		}
		for name, args := range map[string]map[string]string{"repo.clone": {"repo": "o/r"}, "repo.add": {"path": "/Users/me/x"}} {
			_, err := reg.Invoke(context.Background(), command.Context{}, name, args)
			if connect.CodeOf(err) != connect.CodeUnimplemented {
				t.Fatalf("%s: err = %v", name, err)
			}
		}
	})
}
