package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestRepoAddAndClone(t *testing.T) {
	var refs []string
	clone := func(_ context.Context, ref string, _ func(*v1.CloneProgress)) (*v1.Repo, error) {
		refs = append(refs, ref)
		if ref == "octo/taken" {
			return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("/p/octo/taken already exists"))
		}
		return &v1.Repo{Id: "r9", Name: "hello", Path: "/p/octo/hello", Git: true}, nil
	}
	tests := []struct {
		name    string
		cmd     string
		args    map[string]string
		wantMsg string
		wantErr string
		wantRef string
	}{
		{name: "repo.add answers the CLI with a hint", cmd: "repo.add", wantMsg: command.AddProjectHint},
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
			reg := command.NewRegistry()
			if err := command.RegisterRepoAdd(reg, clone); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if got := strings.Join(refs, ","); got != tt.wantRef {
				t.Errorf("cloned %q, want %q", got, tt.wantRef)
			}
		})
	}
	t.Run("unconfigured clone is Unimplemented", func(t *testing.T) {
		reg := command.NewRegistry()
		if err := command.RegisterRepoAdd(reg, nil); err != nil {
			t.Fatal(err)
		}
		_, err := reg.Invoke(context.Background(), command.Context{}, "repo.clone", map[string]string{"repo": "o/r"})
		if connect.CodeOf(err) != connect.CodeUnimplemented {
			t.Fatalf("err = %v", err)
		}
	})
}
