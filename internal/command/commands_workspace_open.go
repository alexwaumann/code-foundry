package command

import (
	"cmp"
	"context"
	"fmt"
	"os/exec"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// OpenWithFunc opens path with the app whose bundle id is bundleID.
type OpenWithFunc func(ctx context.Context, bundleID, path string) error

// OpenWithApp runs `open -b bundleID path`.
func OpenWithApp(ctx context.Context, bundleID, path string) error {
	if out, err := exec.CommandContext(ctx, "open", "-b", bundleID, path).CombinedOutput(); err != nil {
		return fmt.Errorf("open -b %s %s: %w: %s", bundleID, path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// WorkspaceOpenDeps are workspace.open.editor's dependencies.
type WorkspaceOpenDeps struct {
	// Workspace finds the workspace. Nil works like Terminal.
	Workspace WorkspaceBackend
	// Editors lists the installed editor apps (GitOpsService.ListEditorApps): only one of
	// them opens the folder. Nil works like Terminal.
	Editors GitOpsBackend
	// Open opens the folder. Nil: OpenWithApp.
	Open OpenWithFunc
}

// RegisterWorkspaceOpen registers workspace.open.editor: the workspace page's Open in
// list (its Folder row's ⋯, the page's ⋯ and the index row's menu) opens the workspace's
// folder in an installed editor (docs/notes/workspace-page-polish.md). worktree.open.editor
// cannot: it opens registered worktrees only, and a workspace's folder is its root or its
// managed dir under the config home. The app is a bundle id from worktree.editors, so the
// palette does not list it (the page offers each app by name).
func RegisterWorkspaceOpen(r *Registry, d WorkspaceOpenDeps) error {
	open := d.Open
	if open == nil {
		open = OpenWithApp
	}
	return r.RegisterAll(Command{
		Name:        "workspace.open.editor",
		NoPalette:   true,
		Title:       "Open Workspace in Editor",
		Description: "Open a workspace's folder (its root when it has one, else its own folder) in an installed editor app.",
		Category:    "Workspace",
		Args: []ArgSpec{
			{Name: "workspace", Type: String, Positional: true, Description: "Workspace id or name (default: the active workspace)"},
			{Name: "app", Type: String, Required: true, Description: "The editor app's bundle id (`worktree editors` lists them)"},
		},
		When: func(c Context) bool {
			return c.ActiveWorkspaceID != "" || c.ActiveView == "" || c.ActiveView == "projects"
		},
		Run: func(ctx context.Context, c Context, a Args) (Result, error) {
			if d.Workspace == nil || d.Editors == nil {
				return Result{}, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("workspace.open.editor is not available here"))
			}
			ref := cmp.Or(strings.TrimSpace(a.String("workspace")), c.ActiveWorkspaceID)
			if ref == "" {
				return Result{}, InvalidArg("workspace", "name the workspace (an id or a name)")
			}
			bundle := strings.TrimSpace(a.String("app"))
			if bundle == "" {
				return Result{}, InvalidArg("app", "name the editor app by its bundle id (worktree editors lists them)")
			}
			w, err := findWorkspace(ctx, d.Workspace, ref)
			if err != nil {
				return Result{}, err
			}
			app, err := installedEditor(ctx, d.Editors, bundle)
			if err != nil {
				return Result{}, err
			}
			dir := workspaceFolder(w)
			if err := open(ctx, app.GetBundleId(), dir); err != nil {
				return Result{}, err
			}
			return Result{Message: "opened " + dir + " in " + app.GetName(), JSON: map[string]string{"path": dir, "app": app.GetBundleId()}}, nil
		},
	})
}

// installedEditor is the installed editor app with the bundle id, looking again once
// (an app installed since the daemon last looked).
func installedEditor(ctx context.Context, b GitOpsBackend, bundle string) (*v1.EditorApp, error) {
	var names []string
	for _, refresh := range []bool{false, true} {
		res, err := b.ListEditorApps(ctx, connect.NewRequest(&v1.ListEditorAppsRequest{Refresh: refresh}))
		if err != nil {
			return nil, err
		}
		names = names[:0]
		for _, app := range res.Msg.GetApps() {
			if app.GetBundleId() == bundle {
				return app, nil
			}
			names = append(names, app.GetBundleId())
		}
	}
	return nil, InvalidArg("app", "no installed editor has bundle id %q (installed: %s)", bundle, cmp.Or(strings.Join(names, ", "), "none"))
}
