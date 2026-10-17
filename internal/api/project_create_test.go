package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
	"github.com/alexwaumann/code-foundry/internal/store/newproject"
	"github.com/alexwaumann/code-foundry/internal/store/newproject/newprojecttest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

func newCreateServer(t *testing.T, configured bool) (*newprojecttest.Fake, *ghtest.Store, codefoundryv1connect.ProjectServiceClient) {
	t.Helper()
	b := bus.New()
	newProjects, owners := newprojecttest.New("/home/me/.code-foundry/projects"), ghtest.New(b)
	h := NewProject(projecttest.New(b), b)
	if configured {
		h.WithNewProjects(newProjects, owners)
	}
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return newProjects, owners, codefoundryv1connect.NewProjectServiceClient(srv.Client(), srv.URL)
}

func TestCreateProject(t *testing.T) {
	_, _, c := newCreateServer(t, true)
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateProjectRequest{Name: "demo"}))
	if err != nil {
		t.Fatal(err)
	}
	if r := res.Msg.GetProject(); r.GetPath() != "/home/me/.code-foundry/projects/demo" || !r.GetGit() || r.GetName() != "demo" {
		t.Errorf("project = %v", r)
	}
	tests := []struct {
		name string
		code connect.Code
	}{
		{"demo", connect.CodeAlreadyExists},
		{"", connect.CodeInvalidArgument},
		{".hidden", connect.CodeInvalidArgument},
		{"a/b", connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%q", tt.name), func(t *testing.T) {
			_, err := c.Create(ctx, connect.NewRequest(&v1.CreateProjectRequest{Name: tt.name}))
			if connect.CodeOf(err) != tt.code {
				t.Errorf("err = %v, want %v", err, tt.code)
			}
		})
	}
}

func TestListPublishOwners(t *testing.T) {
	_, owners, c := newCreateServer(t, true)
	owners.SetPublishOwners(
		gh.PublishOwner{Login: "dev", Allowed: []string{"PUBLIC", "PRIVATE"}, Known: true},
		gh.PublishOwner{Login: "octo-org", Org: true, Allowed: []string{"PUBLIC", "INTERNAL"}, Known: true},
		gh.PublishOwner{Login: "acme", Org: true, Allowed: gh.AllVisibilities},
	)
	res, err := c.ListPublishOwners(context.Background(), connect.NewRequest(&v1.ListPublishOwnersRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, o := range res.Msg.GetOwners() {
		got = append(got, fmt.Sprintf("%s %s %v %t", o.GetLogin(), o.GetKind(), o.GetAllowed(), o.GetKnown()))
	}
	want := []string{
		"dev PUBLISH_OWNER_KIND_USER [REPOSITORY_VISIBILITY_PUBLIC REPOSITORY_VISIBILITY_PRIVATE] true",
		"octo-org PUBLISH_OWNER_KIND_ORGANIZATION [REPOSITORY_VISIBILITY_PUBLIC REPOSITORY_VISIBILITY_INTERNAL] true",
		"acme PUBLISH_OWNER_KIND_ORGANIZATION [REPOSITORY_VISIBILITY_PUBLIC REPOSITORY_VISIBILITY_INTERNAL REPOSITORY_VISIBILITY_PRIVATE] false",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("owners:\n got %v\nwant %v", got, want)
	}
	// allow_stale serves the fake's list as cached, never stale.
	res, err = c.ListPublishOwners(context.Background(), connect.NewRequest(&v1.ListPublishOwnersRequest{AllowStale: true}))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Msg.GetOwners()) != 3 || res.Msg.GetStale() {
		t.Errorf("allow_stale: %d owners, stale=%t", len(res.Msg.GetOwners()), res.Msg.GetStale())
	}
	owners.SetError(fmt.Errorf("%w: run gh auth login", gh.ErrNotAuthenticated))
	if _, err := c.ListPublishOwners(context.Background(), connect.NewRequest(&v1.ListPublishOwnersRequest{})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("unauthenticated: err = %v", err)
	}
	// With nothing cached, allow_stale fetches and fails the same way.
	owners.SetPublishOwners()
	if _, err := c.ListPublishOwners(context.Background(), connect.NewRequest(&v1.ListPublishOwnersRequest{AllowStale: true})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("unauthenticated, allow_stale: err = %v", err)
	}
}

func TestDeleteProject(t *testing.T) {
	newProjects, _, c := newCreateServer(t, true)
	ctx := context.Background()
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateProjectRequest{Name: "demo"})); err != nil {
		t.Fatal(err)
	}
	newProjects.AddProject(project.Project{ID: "r1", Name: "elsewhere", Path: "/home/me/elsewhere", Git: true})
	tests := []struct {
		name string
		id   string
		code connect.Code
	}{
		{"a created project", "repo-demo", 0},
		{"again: gone", "repo-demo", connect.CodeNotFound},
		{"outside the projects directory", "r1", connect.CodeFailedPrecondition},
		{"unknown", "nope", connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.Delete(ctx, connect.NewRequest(&v1.DeleteProjectRequest{Id: tt.id}))
			if (err == nil) != (tt.code == 0) || (err != nil && connect.CodeOf(err) != tt.code) {
				t.Fatalf("err = %v, want %v", err, tt.code)
			}
		})
	}
	want := []string{"create demo", "delete repo-demo", "delete repo-demo", "delete r1", "delete nope"}
	if got := newProjects.Calls(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestPublishProject(t *testing.T) {
	newProjects, _, c := newCreateServer(t, true)
	newProjects.AddProject(project.Project{ID: "r1", Name: "demo", Path: "/home/me/demo", Git: true})
	ghTail := "GraphQL: Visibility can't be private. (createRepository)"
	newProjects.FailPublish("octo-org/demo", &newproject.GhError{Tail: ghTail})
	newProjects.FailPublish("me/taken", fmt.Errorf("%w: demo is being published", newproject.ErrFailedPrecondition))
	ctx := context.Background()

	res, err := c.Publish(ctx, connect.NewRequest(&v1.PublishProjectRequest{ProjectId: "r1", Owner: "me",
		Visibility: v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PUBLIC}))
	if err != nil {
		t.Fatal(err)
	}
	if r := res.Msg.GetProject(); r.GetGithubSlug() != "me/demo" || len(r.GetRemotes()) != 1 {
		t.Errorf("project = %v", r)
	}

	tests := []struct {
		name string
		req  *v1.PublishProjectRequest
		code connect.Code
		msg  string // the exact message, when it matters
	}{
		{"gh refuses: verbatim", &v1.PublishProjectRequest{ProjectId: "r1", Owner: "octo-org", Visibility: v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PRIVATE},
			connect.CodeUnknown, ghTail},
		{"precondition", &v1.PublishProjectRequest{ProjectId: "r1", Owner: "me", Name: "taken", Visibility: v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PUBLIC},
			connect.CodeFailedPrecondition, ""},
		{"no visibility", &v1.PublishProjectRequest{ProjectId: "r1", Owner: "me"}, connect.CodeInvalidArgument, ""},
		{"unknown project", &v1.PublishProjectRequest{ProjectId: "nope", Owner: "me", Visibility: v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PUBLIC},
			connect.CodeNotFound, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.Publish(ctx, connect.NewRequest(tt.req))
			if connect.CodeOf(err) != tt.code {
				t.Fatalf("err = %v, want %v", err, tt.code)
			}
			var ce *connect.Error
			if tt.msg != "" && (!errors.As(err, &ce) || ce.Message() != tt.msg) {
				t.Errorf("message = %q, want %q", ce.Message(), tt.msg)
			}
		})
	}
	want := []string{"publish r1 me/demo public", "publish r1 octo-org/demo private", "publish r1 me/taken public"}
	if got := newProjects.Calls(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestNewProjectsNotConfigured(t *testing.T) {
	_, _, c := newCreateServer(t, false)
	ctx := context.Background()
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateProjectRequest{Name: "x"})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("create: %v", err)
	}
	if _, err := c.ListPublishOwners(ctx, connect.NewRequest(&v1.ListPublishOwnersRequest{})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("owners: %v", err)
	}
	if _, err := c.Publish(ctx, connect.NewRequest(&v1.PublishProjectRequest{})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("publish: %v", err)
	}
	if _, err := c.Delete(ctx, connect.NewRequest(&v1.DeleteProjectRequest{Id: "x"})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("delete: %v", err)
	}
}
