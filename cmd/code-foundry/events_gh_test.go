package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
)

// `events --json --source gh` prints a pull request's changes as protojson.
func TestRunEventsPullRequestChanged(t *testing.T) {
	b := bus.New()
	store := ghtest.New(b)
	route := api.NewEvents(api.EventsDeps{Bus: b, Gh: store}).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := &client.Client{Events: codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)}
	lw := newLineWriter()
	cl := &cli{stdout: lw, stderr: &bytes.Buffer{}, connect: func(context.Context) (*client.Client, error) { return c, nil }}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runEvents(ctx, cl, []string{"--source", "gh", "--json"}) }()
	for range 3 { // the gh snapshot: viewer, polled, dashboard
		lw.next(t)
	}
	store.ChangePullRequest(gh.PullRequestChanged{
		Slug: "o/r", Number: 7, URL: "https://github.com/o/r/pull/7", HeadRef: "cf/login",
		PullRequest: gh.PullRequest{Number: 7, Repo: "o/r", HeadRef: "cf/login", HeadSHA: "def", State: gh.PullRequestOpen},
		Changes:     []gh.Change{{Kind: gh.ChangeHeadPushed, OldHeadSHA: "abc", NewHeadSHA: "def"}},
	})
	var ev struct {
		Gh struct {
			PullRequestChanged struct {
				RepoSlug string `json:"repoSlug"`
				Number   int    `json:"number"`
				HeadRef  string `json:"headRef"`
				Changes  []struct {
					Kind       string `json:"kind"`
					OldHeadSha string `json:"oldHeadSha"`
					NewHeadSha string `json:"newHeadSha"`
				} `json:"changes"`
			} `json:"pullRequestChanged"`
		} `json:"gh"`
		Seq   string `json:"seq"`
		Epoch string `json:"epoch"`
	}
	line := lw.next(t)
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		t.Fatal(err)
	}
	p := ev.Gh.PullRequestChanged
	if p.RepoSlug != "o/r" || p.Number != 7 || p.HeadRef != "cf/login" || len(p.Changes) != 1 ||
		p.Changes[0].Kind != "PULL_REQUEST_CHANGE_KIND_HEAD_PUSHED" || p.Changes[0].OldHeadSha != "abc" || p.Changes[0].NewHeadSha != "def" ||
		ev.Seq == "" || ev.Epoch == "" {
		t.Errorf("line %s", line)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
