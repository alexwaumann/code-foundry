package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/clone/clonetest"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
)

func TestPresentClone(t *testing.T) {
	b := bus.New()
	cloner := clonetest.New("/p")
	cloner.Lines = []clone.Progress{{Line: "Cloning into '/p/octo/hello'..."}, {Line: "Receiving objects:  50%", Transient: true},
		{Line: "Receiving objects: 100%, done."}}
	cloner.Take("octo/taken")
	cloner.Fail("octo/broken", fmt.Errorf("%w: fatal: early EOF", clone.ErrFailed))
	route := api.NewRepo(repotest.New(b), b).WithGitHub(ghtest.New(b), cloner).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := &client.Client{Repo: codefoundryv1connect.NewRepoServiceClient(srv.Client(), srv.URL)}

	tests := []struct {
		name       string
		ref        string
		live, json bool
		wantErr    error // errUsage, errAny, or nil
		stdout     string
		stderr     string
	}{
		{name: "log output: final lines only", ref: "octo/hello",
			stdout: "cloned hello into /p/octo/hello (repo-hello)\n",
			stderr: "Cloning into '/p/octo/hello'...\nReceiving objects: 100%, done.\n"},
		{name: "terminal: the counter is redrawn in place", ref: "https://github.com/octo/world.git", live: true,
			stdout: "cloned world into /p/octo/world (repo-world)\n",
			stderr: "Cloning into '/p/octo/hello'...\n\rReceiving objects:  50%\x1b[K\rReceiving objects: 100%, done.\x1b[K\n"},
		{name: "json", ref: "octo/third", json: true, stdout: `"path":"/p/octo/third"`},
		{name: "ssh refused locally", ref: "git@github.com:octo/hello.git", wantErr: errUsage, stderr: "SSH URLs are not supported"},
		{name: "destination exists", ref: "octo/taken", wantErr: errAny, stderr: ""},
		{name: "gh failed", ref: "octo/broken", wantErr: errAny, stderr: "Receiving objects: 100%, done."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			cl := &cli{stdout: &stdout, stderr: &stderr, interactive: func() bool { return tt.live }}
			err := presentClone(context.Background(), cl, c, map[string]string{"repo": tt.ref}, tt.json)
			switch {
			case tt.wantErr == errAny && err == nil, tt.wantErr != errAny && !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if !strings.Contains(stdout.String(), tt.stdout) {
				t.Errorf("stdout = %q, want containing %q", stdout.String(), tt.stdout)
			}
			if !strings.Contains(stderr.String(), tt.stderr) {
				t.Errorf("stderr = %q, want containing %q", stderr.String(), tt.stderr)
			}
		})
	}
}
