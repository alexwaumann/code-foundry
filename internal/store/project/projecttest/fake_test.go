package projecttest_test

import (
	"context"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// The fake fetches like the real store: a base with Fetch and BaseFromOrigin, and a
// branch only origin has with Fetch whatever BaseFromOrigin says.
func TestFakeCreateWorktreeFetches(t *testing.T) {
	for _, c := range []struct {
		name string
		o    project.CreateWorktreeOptions
		want []string // the fetched refs
	}{
		{"new branch from origin", project.CreateWorktreeOptions{Branch: "cf/new", Fetch: true, BaseFromOrigin: true}, []string{"origin/main"}},
		{"new branch from local", project.CreateWorktreeOptions{Branch: "cf/new", Fetch: true}, nil},
		{"origin-only branch, setting off", project.CreateWorktreeOptions{Branch: "shared", Fetch: true}, []string{"origin/shared"}},
		{"origin-only branch, setting on", project.CreateWorktreeOptions{Branch: "shared", Fetch: true, BaseFromOrigin: true}, []string{"origin/shared"}},
		{"origin-only branch without Fetch", project.CreateWorktreeOptions{Branch: "shared"}, nil},
		{"branch local too", project.CreateWorktreeOptions{Branch: "both", Fetch: true}, nil},
		{"origin-only branch as a new branch's base", project.CreateWorktreeOptions{Branch: "cf/x", BaseRef: "shared", Fetch: true}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := projecttest.New(nil)
			f.Put(project.Project{ID: "p1", Path: "/p1", Git: true, DefaultBranch: "main"})
			f.SetRefs("p1", project.Refs{Local: []string{"both", "main"}, Remote: []string{"origin/both", "origin/main", "origin/shared"}})
			var got []string
			c.o.ProjectID = "p1"
			c.o.Progress = func(ev project.WorktreeEvent) {
				if ev.Kind == project.WorktreeFetchStarted {
					got = append(got, ev.Ref)
				}
			}
			if _, err := f.CreateWorktree(context.Background(), c.o); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got, c.want) || len(f.Fetches) != len(c.want) {
				t.Errorf("fetched %v (%d recorded), want %v", got, len(f.Fetches), c.want)
			}
		})
	}
}
