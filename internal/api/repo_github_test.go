package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/clone/clonetest"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
)

func newGitHubRepoServer(t *testing.T, configured bool) (*ghtest.Store, *clonetest.Fake, codefoundryv1connect.RepoServiceClient) {
	t.Helper()
	b := bus.New()
	finder, cloner := ghtest.New(b), clonetest.New("/home/me/.code-foundry/projects")
	h := NewRepo(repotest.New(b), b)
	if configured {
		h.WithGitHub(finder, cloner)
	}
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return finder, cloner, codefoundryv1connect.NewRepoServiceClient(srv.Client(), srv.URL)
}

func TestSearchAndLookupGitHub(t *testing.T) {
	finder, cloner, c := newGitHubRepoServer(t, true)
	finder.AddRepositories(
		gh.Repository{Owner: "alexwaumann", Name: "code-foundry", Description: "fleets", Visibility: "PUBLIC",
			URL: "https://github.com/alexwaumann/code-foundry"},
		gh.Repository{Owner: "octo", Name: "old", Visibility: "INTERNAL", Archived: true, Fork: true, URL: "https://github.com/octo/old"},
	)
	cloner.Take("octo/old")
	ctx := context.Background()

	res, err := c.SearchGitHub(ctx, connect.NewRequest(&v1.SearchGitHubRequest{Query: "o"}))
	if err != nil {
		t.Fatal(err)
	}
	got := res.Msg.GetRepositories()
	if len(got) != 2 {
		t.Fatalf("search = %v", got)
	}
	first, second := got[0], got[1]
	if first.GetOwner() != "alexwaumann" || first.GetName() != "code-foundry" || first.GetDescription() != "fleets" ||
		first.GetVisibility() != v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PUBLIC || first.GetIsArchived() ||
		first.GetUrl() != "https://github.com/alexwaumann/code-foundry" ||
		first.GetClonePath() != "/home/me/.code-foundry/projects/alexwaumann/code-foundry" || first.GetClonePathExists() {
		t.Errorf("first = %v", first)
	}
	if second.GetVisibility() != v1.RepositoryVisibility_REPOSITORY_VISIBILITY_INTERNAL || !second.GetIsArchived() ||
		!second.GetIsFork() || !second.GetClonePathExists() {
		t.Errorf("second = %v", second)
	}

	look, err := c.LookupGitHub(ctx, connect.NewRequest(&v1.LookupGitHubRequest{Owner: "AlexWaumann", Name: "Code-Foundry"}))
	if err != nil || look.Msg.GetRepository().GetName() != "code-foundry" {
		t.Fatalf("lookup = %v, %v", look, err)
	}

	tests := []struct {
		name string
		call func() error
		code connect.Code
	}{
		{"empty search", func() error {
			_, err := c.SearchGitHub(ctx, connect.NewRequest(&v1.SearchGitHubRequest{Query: " "}))
			return err
		}, connect.CodeInvalidArgument},
		{"missing repository", func() error {
			_, err := c.LookupGitHub(ctx, connect.NewRequest(&v1.LookupGitHubRequest{Owner: "octo", Name: "nope"}))
			return err
		}, connect.CodeNotFound},
		{"bad slug", func() error {
			_, err := c.LookupGitHub(ctx, connect.NewRequest(&v1.LookupGitHubRequest{Owner: "-x", Name: "y"}))
			return err
		}, connect.CodeInvalidArgument},
		{"rate limited", func() error {
			finder.SetError(&gh.RateLimitError{Msg: "API rate limit exceeded"})
			defer finder.SetError(nil)
			_, err := c.SearchGitHub(ctx, connect.NewRequest(&v1.SearchGitHubRequest{Query: "x"}))
			return err
		}, connect.CodeResourceExhausted},
		{"not logged in", func() error {
			finder.SetError(gh.ErrNotAuthenticated)
			defer finder.SetError(nil)
			_, err := c.LookupGitHub(ctx, connect.NewRequest(&v1.LookupGitHubRequest{Owner: "octo", Name: "old"}))
			return err
		}, connect.CodeFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if code := connect.CodeOf(tt.call()); code != tt.code {
				t.Fatalf("code = %v, want %v", code, tt.code)
			}
		})
	}
}

// cloneEvents reads a Clone stream to its end.
func cloneEvents(t *testing.T, c codefoundryv1connect.RepoServiceClient, owner, name string) (lines []string, r *v1.Repo, err error) {
	t.Helper()
	stream, err := c.Clone(context.Background(), connect.NewRequest(&v1.CloneRepoRequest{Owner: owner, Name: name}))
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = stream.Close() }()
	for stream.Receive() {
		switch ev := stream.Msg().GetEvent().(type) {
		case *v1.CloneRepoEvent_Progress:
			lines = append(lines, fmt.Sprintf("%s|%t", ev.Progress.GetLine(), ev.Progress.GetTransient()))
		case *v1.CloneRepoEvent_Repo:
			r = ev.Repo
		}
	}
	return lines, r, stream.Err()
}

func TestCloneStream(t *testing.T) {
	_, cloner, c := newGitHubRepoServer(t, true)
	cloner.Lines = []clone.Progress{{Line: "Cloning into 'x'..."}, {Line: "Receiving objects:  50%", Transient: true}, {Line: "done."}}
	cloner.Take("octo/taken")
	cloner.Fail("octo/missing", fmt.Errorf("%w: GraphQL: Could not resolve to a Repository", clone.ErrNotFound))
	cloner.Fail("octo/broken", fmt.Errorf("%w: fatal: early EOF", clone.ErrFailed))
	cloner.Fail("octo/unregistered", errors.New("cloned into /x but could not add it as a project: boom"))

	lines, r, err := cloneEvents(t, c, "octo", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(lines, ";") != "Cloning into 'x'...|false;Receiving objects:  50%|true;done.|false" {
		t.Errorf("lines = %v", lines)
	}
	if r.GetPath() != "/home/me/.code-foundry/projects/octo/hello" || !r.GetGit() {
		t.Errorf("repo = %v", r)
	}

	tests := []struct {
		name, repo string
		code       connect.Code
		msg        string
		lines      int
	}{
		{"destination exists", "taken", connect.CodeAlreadyExists, "taken already exists", 0},
		{"missing on GitHub", "missing", connect.CodeNotFound, "Could not resolve", 3},
		{"gh failed: its tail is the message", "broken", connect.CodeUnknown, "fatal: early EOF", 3},
		{"register failed", "unregistered", connect.CodeInternal, "could not add it as a project", 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lines, r, err := cloneEvents(t, c, "octo", tt.repo)
			if connect.CodeOf(err) != tt.code || !strings.Contains(err.Error(), tt.msg) || r != nil || len(lines) != tt.lines {
				t.Fatalf("err = %v (%v), repo %v, %d lines", err, connect.CodeOf(err), r, len(lines))
			}
		})
	}
}

func TestGitHubUnconfigured(t *testing.T) {
	_, _, c := newGitHubRepoServer(t, false)
	ctx := context.Background()
	if _, err := c.SearchGitHub(ctx, connect.NewRequest(&v1.SearchGitHubRequest{Query: "x"})); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("search: %v", err)
	}
	if _, _, err := cloneEvents(t, c, "o", "r"); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("clone: %v", err)
	}
}
