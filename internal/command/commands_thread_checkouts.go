package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// CheckoutsBackend backs thread.checkouts.
type CheckoutsBackend interface {
	Checkouts(context.Context, *connect.Request[v1.ThreadCheckoutsRequest]) (*connect.Response[v1.ThreadCheckoutsResponse], error)
}

// threadCheckouts is thread.checkouts: a thread's project set and where each member is
// (docs/notes/workspaces-v2-1-threads.md). It replaces workspace.members.
func threadCheckouts(b CheckoutsBackend) Command {
	return Command{
		Name:         "thread.checkouts",
		ReadOnly:     true,
		Title:        "Thread Checkouts",
		Description:  "List a thread's projects with path, branch and CLAUDE.md.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "id", Type: String, DefaultToThreadEnv: true, ID: ThreadID, Positional: true,
				Description: "Thread id (default: yours, else the one holding cwd)"},
			{Name: "cwd", Type: Path, DefaultToCwd: true, Description: "A path in one of its checkouts"},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			id := strings.TrimSpace(a.String("id"))
			if id == "" && a.Path("cwd") == "" {
				id = uctx.ActiveThreadID // the palette: the active thread
			}
			res, err := b.Checkouts(ctx, connect.NewRequest(&v1.ThreadCheckoutsRequest{Id: id, Cwd: a.Path("cwd")}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: FormatCheckouts(res.Msg), JSON: res.Msg}, nil
		},
	}
}

// FormatCheckouts renders thread.checkouts for people and for Claude: a line naming the
// thread and its mode, then one aligned line per project, then the workspace.
func FormatCheckouts(m *v1.ThreadCheckoutsResponse) string {
	var b strings.Builder
	t := m.GetThread()
	mode := "each project in its own checkout"
	if t.GetCreatedWorktree() && t.GetBranch() != "" {
		mode = "worktrees on branch " + t.GetBranch()
	}
	if t.GetProjectId() == "" && t.GetWorkspaceId() != "" {
		mode += "; runs in its workspace's folder " + t.GetWorktreePath()
	}
	fmt.Fprintf(&b, "thread %s: %s\n", threadLabel(t), mode)
	if len(m.GetCheckouts()) == 0 {
		b.WriteString("no projects (the thread runs in " + t.GetWorktreePath() + ")")
	} else {
		tw := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)
		fmt.Fprintln(tw, "PROJECT\tPATH\tBRANCH\tINSTRUCTIONS")
		for _, c := range m.GetCheckouts() {
			name := c.GetProjectName()
			if name == "" {
				name = c.GetProjectId() + " (not registered)"
			}
			branch := c.GetBranch()
			if branch == "" {
				branch = "-"
				if !c.GetGit() && c.GetProjectName() != "" {
					branch = "(folder)"
				}
			}
			if c.GetCurrent() {
				branch += " (current)"
			}
			if c.GetMissing() {
				branch += " (missing)"
			}
			path := c.GetPath()
			if path == "" {
				path = "-"
			}
			instr := c.GetInstructions()
			if instr == "" {
				instr = "-"
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", name, path, branch, instr)
		}
		_ = tw.Flush()
	}
	if ws := m.GetWorkspaceId(); ws != "" {
		name := m.GetWorkspaceName()
		if name == "" {
			name = ws + " (gone)"
		}
		dir := m.GetWorkspaceDir()
		if dir == "" {
			dir = "-"
		}
		fmt.Fprintf(&b, "WORKSPACE %s  %s\n", name, dir)
	}
	return strings.TrimRight(b.String(), "\n")
}
