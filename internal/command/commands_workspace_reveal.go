package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// RegisterWorkspaceReveal registers workspace.reveal: the Projects page's workspace cards
// show the workspace's folder in Finder (docs/notes/workspaces-v2-4-projects-page.md).
// worktree.reveal cannot: it only reveals registered worktrees, and a workspace's folder
// is its root or its managed dir under the config home. reveal may be nil (RevealInFinder),
// as for RegisterSettings: the daemon passes none.
func RegisterWorkspaceReveal(r *Registry, b WorkspaceBackend, reveal RevealFunc) error {
	if reveal == nil {
		reveal = RevealInFinder
	}
	return r.RegisterAll(Command{
		Name:  "workspace.reveal",
		Title: "Reveal Workspace in Finder",
		Description: "Show a workspace's folder in Finder: its root when it has one, else its own folder " +
			"(where its CLAUDE.md, AGENTS.md and .claude/skills live).",
		Category: "Workspace",
		Args: []ArgSpec{
			{Name: "workspace", Type: String, Positional: true, Description: "Workspace id or name (default: the active workspace)"},
		},
		When: func(c Context) bool {
			return c.ActiveWorkspaceID != "" || c.ActiveView == "" || c.ActiveView == "projects"
		},
		Run: func(ctx context.Context, c Context, a Args) (Result, error) {
			ref := strings.TrimSpace(a.String("workspace"))
			if ref == "" {
				ref = c.ActiveWorkspaceID
			}
			if ref == "" {
				return Result{}, InvalidArg("workspace", "name the workspace (an id or a name)")
			}
			w, err := findWorkspace(ctx, b, ref)
			if err != nil {
				return Result{}, err
			}
			dir := workspaceFolder(w)
			if err := reveal(ctx, dir); err != nil {
				return Result{}, err
			}
			return Result{Message: "revealed " + dir, JSON: map[string]string{"path": dir}}, nil
		},
	})
}

// findWorkspace is the workspace ref names: its id, or its name in any case.
func findWorkspace(ctx context.Context, b WorkspaceBackend, ref string) (*v1.Workspace, error) {
	res, err := b.List(ctx, connect.NewRequest(&v1.ListWorkspacesRequest{}))
	if err != nil {
		return nil, err
	}
	for _, w := range res.Msg.GetWorkspaces() {
		if w.GetId() == ref || strings.EqualFold(w.GetName(), ref) {
			return w, nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("workspace %s not found (code-foundry workspace list)", ref))
}

// workspaceFolder is where a thread whose primary is the workspace runs: the root of a
// rooted workspace, else its managed dir.
func workspaceFolder(w *v1.Workspace) string {
	if r := w.GetRootPath(); r != "" {
		return r
	}
	return w.GetManagedDir()
}

// removeWorkspaceConfirm is workspace.remove's prompt for the workspace ref names: a
// synthetic workspace's instructions and skills go with it, a rooted one's root stays.
// "" (the static prompt) when the workspace cannot be read.
func removeWorkspaceConfirm(ctx context.Context, b WorkspaceBackend, ref string) string {
	w, err := findWorkspace(ctx, b, ref)
	if err != nil {
		return ""
	}
	if r := w.GetRootPath(); r != "" {
		return "Remove workspace " + w.GetName() + "? Its root folder " + r + " and everything in it stay; only the workspace and its links go."
	}
	return "Remove workspace " + w.GetName() + "? Its instructions and skills are deleted too."
}
