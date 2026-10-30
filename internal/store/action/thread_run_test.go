package action

import (
	"context"
	"maps"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// A thread over web and api runs api's terminal action in its api checkout as its own
// run: the terminal is labelled with the thread (its bottom panel), the environment names
// api, and the record makes it the thread's pick for api (the info card's action row).
func TestThreadRunsAMembersAction(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	serve := h.create(CreateOptions{ProjectID: "api", Name: "Serve", Command: "go run .", InTerminal: true})
	h.create(CreateOptions{ProjectID: "api", Name: "Lint", Command: "true"})
	r, err := h.m.Run(ctx, RunOptions{Action: serve.ID, ThreadID: "s2"})
	if err != nil {
		t.Fatal(err)
	}
	spec, ok := h.terms.Spec(r.TerminalID)
	if !ok {
		t.Fatal("no terminal")
	}
	wantLabels := map[string]string{
		termlabel.Kind: termlabel.KindAction, termlabel.Thread: "s2", termlabel.Project: "api", termlabel.Worktree: h.api,
		termlabel.Action: serve.ID, termlabel.ActionName: "Serve", termlabel.ActionRun: r.ID,
	}
	if spec.Cwd != h.api || !maps.Equal(spec.Labels, wantLabels) {
		t.Errorf("terminal cwd %q labels %v, want %s and %v", spec.Cwd, spec.Labels, h.api, wantLabels)
	}
	if env := spec.Env; len(env) != 3 || env[0] != paths.EnvProjectRoot+"="+h.api || env[2] != paths.EnvThread+"=s2" {
		t.Errorf("env = %q", env)
	}
	recs, err := h.m.RunRecords(ctx, "api")
	if err != nil || len(recs) != 1 || recs[0].ThreadID != "s2" || recs[0].ProjectID != "api" {
		t.Fatalf("api records = %+v, %v", recs, err)
	}
	if p := PickAction(h.m.Snapshot().ForProject("api"), recs, "s2"); p.Source != PickThread || p.Action.ID != serve.ID {
		t.Errorf("pick for s2 = %v %s, want thread %s", p.Source, p.Action.Name, serve.Name)
	}
	if err := h.terms.Exit(r.TerminalID, 0); err != nil {
		t.Fatal(err)
	}
	h.wait(r.ID)
}

func TestResolveForThread(t *testing.T) {
	snap := &Snapshot{Actions: []Action{
		{ID: "a-web-test", ProjectID: "web", Name: "Test"},
		{ID: "a-api-test", ProjectID: "api", Name: "Test"},
		{ID: "a-api-build", ProjectID: "api", Name: "Build"},
		{ID: "a-lib-build", ProjectID: "lib", Name: "Build"},
		{ID: "a-lib-lint", ProjectID: "lib", Name: "Lint"},
		{ID: "a-doc-pub", ProjectID: "doc", Name: "Publish"},
	}}
	members := map[string]string{"web": "/w", "api": "/a", "lib": "/l"}
	tests := []struct {
		name, cwd, ref, want, err string
	}{
		{name: "an id of a member's", cwd: "web", ref: "a-lib-build", want: "a-lib-build"},
		{name: "an id outside the set", cwd: "web", ref: "a-doc-pub", err: "not one of thread s's projects"},
		{name: "the cwd's name first", cwd: "web", ref: "test", want: "a-web-test"},
		{name: "two other members have the name", cwd: "web", ref: "Build", err: "is in several of thread s's projects: a-api-build (api), a-lib-build (lib)"},
		{name: "one other member has the name", cwd: "web", ref: "LINT", want: "a-lib-lint"},
		{name: "no member has it", cwd: "web", ref: "publish", err: `no action "publish" in thread s's projects`},
		{name: "no cwd project: one member has it", cwd: "", ref: "lint", want: "a-lib-lint"},
		{name: "empty", cwd: "web", ref: " ", err: "an action id or name is required"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a, err := resolveForThread(snap, tt.cwd, members, "s", tt.ref, func(id string) string { return id })
			if tt.err != "" {
				if err == nil || !strings.Contains(err.Error(), tt.err) {
					t.Fatalf("= %+v, %v; want an error with %q", a, err, tt.err)
				}
				return
			}
			if err != nil || a.ID != tt.want {
				t.Fatalf("= %+v, %v; want %s", a, err, tt.want)
			}
		})
	}
}
