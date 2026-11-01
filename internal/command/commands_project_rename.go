package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// renameCommand is project.rename: set a project's display name
// (docs/notes/projects-table-3-rename.md). The project arg resolves before the rename
// (an id, the one project with a name, a path), so the old name works as the ref.
func renameCommand(b ProjectBackend, projectArg ArgSpec) Command {
	projectArg.Positional = true
	return Command{
		Name:  "project.rename",
		Title: "Rename Project",
		Description: "Rename a project. Only its name in Code Foundry changes: the folder, worktrees and branches stay. " +
			"Names are unique among projects, whatever their case, and may not contain / or ,.",
		Category: "Project",
		Args: []ArgSpec{
			projectArg,
			{Name: "name", Type: String, Required: true, Positional: true, Description: "New name"},
		},
		When: hasProject,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.Rename(ctx, connect.NewRequest(&v1.RenameProjectRequest{Id: a.String("project"), Name: a.String("name")}))
			if err != nil {
				return Result{}, err
			}
			p := res.Msg.GetProject()
			return Result{Message: "renamed project " + p.GetId() + " to " + p.GetName(), JSON: p}, nil
		},
	}
}
