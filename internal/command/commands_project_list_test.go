package command_test

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// project.list prints one line per project, marking a project without git, and answers
// --json with the list response.
func TestProjectList(t *testing.T) {
	f := newFixture(t)
	f.project.Projects = []*v1.Project{
		{Id: "r1", Name: "app", Path: "/src/app", Git: true},
		{Id: "r2", Name: "notes", Path: "/src/notes"},
	}
	res, err := f.reg.Invoke(context.Background(), command.Context{}, "project.list", nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := "app (r1) /src/app\nnotes (r2) /src/notes (no git)"; res.Message != want {
		t.Errorf("message = %q, want %q", res.Message, want)
	}
	if js, err := res.EncodeJSON(); err != nil || !strings.Contains(js, `"projects":[`) {
		t.Errorf("json = %s, %v", js, err)
	}
}
