package command_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestRepoCreateAndPublish(t *testing.T) {
	// r-plain has no git, r-origin has origin; anything else is a git project without it.
	notGit := func(c command.Context) bool { return c.ActiveRepoID == "r-plain" }
	hasOrigin := func(c command.Context) bool { return c.ActiveRepoID == "r-origin" }
	ghErr := connect.NewError(connect.CodeUnknown, errors.New("GraphQL: Name already exists on this account (createRepository)"))
	tests := []struct {
		name     string
		cmd      string
		uctx     command.Context
		args     map[string]string
		err      error
		wantMsg  string
		wantErr  string
		wantCall string // the backend request, as text
	}{
		{name: "create", cmd: "repo.create", args: map[string]string{"name": "demo"},
			wantMsg: "created demo in /p/demo (repo-demo)", wantCall: `name:"demo"`},
		{name: "create needs a name", cmd: "repo.create", wantErr: "name"},
		{name: "publish with the active project", cmd: "repo.github.publish", uctx: command.Context{ActiveRepoID: "r1"},
			args:     map[string]string{"owner": "alexwaumann", "visibility": "public"},
			wantMsg:  "published demo to https://github.com/alexwaumann/demo (public)",
			wantCall: `repo_id:"r1" owner:"alexwaumann" visibility:REPOSITORY_VISIBILITY_PUBLIC`},
		{name: "publish with an explicit repo and name", cmd: "repo.github.publish",
			args:     map[string]string{"repo": "r2", "owner": "octo-org", "name": "app", "visibility": "internal"},
			wantMsg:  "published demo to https://github.com/octo-org/app (internal)",
			wantCall: `repo_id:"r2" owner:"octo-org" name:"app" visibility:REPOSITORY_VISIBILITY_INTERNAL`},
		{name: "publish needs a visibility", cmd: "repo.github.publish", uctx: command.Context{ActiveRepoID: "r1"},
			args: map[string]string{"owner": "me"}, wantErr: "visibility"},
		{name: "publish refuses other visibilities", cmd: "repo.github.publish", uctx: command.Context{ActiveRepoID: "r1"},
			args: map[string]string{"owner": "me", "visibility": "secret"}, wantErr: "visibility"},
		{name: "publish is unavailable without git", cmd: "repo.github.publish", uctx: command.Context{ActiveRepoID: "r-plain"},
			args: map[string]string{"owner": "me", "visibility": "public"}, wantErr: "project is not a git repository"},
		{name: "publish is unavailable with origin", cmd: "repo.github.publish", uctx: command.Context{ActiveRepoID: "r-origin"},
			args: map[string]string{"owner": "me", "visibility": "public"}, wantErr: "project already has an origin remote"},
		{name: "gh's error passes through as is", cmd: "repo.github.publish", uctx: command.Context{ActiveRepoID: "r1"},
			args: map[string]string{"owner": "me", "visibility": "private"}, err: ghErr,
			wantErr:  "GraphQL: Name already exists on this account (createRepository)",
			wantCall: `repo_id:"r1" owner:"me" visibility:REPOSITORY_VISIBILITY_PRIVATE`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := &commandtest.Projects{Err: tt.err}
			reg := command.NewRegistry()
			if err := command.RegisterProjects(reg, command.ProjectDeps{Backend: b, NotGit: notGit, HasOrigin: hasOrigin}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.uctx, tt.cmd, tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
				}
				if tt.err != nil && connect.CodeOf(err) != connect.CodeOf(tt.err) {
					t.Errorf("code = %v, want %v", connect.CodeOf(err), connect.CodeOf(tt.err))
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			var call string
			if reqs := b.Requests(); len(reqs) > 0 {
				call = strings.Join(strings.Fields(fmt.Sprint(reqs[0])), " ")
			}
			if call != tt.wantCall {
				t.Errorf("request = %q, want %q", call, tt.wantCall)
			}
		})
	}
}

func TestRepoCreateUnconfigured(t *testing.T) {
	reg := command.NewRegistry()
	if err := command.RegisterProjects(reg, command.ProjectDeps{}); err != nil {
		t.Fatal(err)
	}
	_, err := reg.Invoke(context.Background(), command.Context{}, "repo.create", map[string]string{"name": "x"})
	if connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Fatalf("err = %v", err)
	}
	// Without predicates, publish is available for any project.
	if _, ok := reg.Get("repo.github.publish"); !ok {
		t.Fatal("not registered")
	}
	for _, l := range reg.List(command.Context{ActiveRepoID: "r"}, false) {
		if l.Name == "repo.github.publish" {
			return
		}
	}
	t.Error("repo.github.publish unavailable with a project and no predicates")
}
