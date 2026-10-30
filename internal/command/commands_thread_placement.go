package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// PlacementBackend backs thread.placement.check.
type PlacementBackend interface {
	CheckPlacement(context.Context, *connect.Request[v1.CheckPlacementRequest]) (*connect.Response[v1.CheckPlacementResponse], error)
}

// placementModes are thread.placement.check's --mode values: new worktrees, or each
// project's own checkout.
var placementModes = []string{"worktree", "checkout"}

// threadPlacementCheck is thread.placement.check: where a new thread with these projects,
// branch and mode would go, without making anything (the composer's Work in picker and
// the info card's Run in menu ask it before a send).
func threadPlacementCheck(b PlacementBackend) Command {
	return Command{
		Name:      "thread.placement.check",
		NoPalette: true,
		ReadOnly:  true,
		Title:     "Check Thread Placement",
		Description: "Where a new thread would go, per project, without making anything: a new worktree, an existing " +
			"checkout it would share, a plain folder, or the refusal thread new would give.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "projects", Type: String, Required: true, Description: "Comma-separated projects (id, name, or absolute path), as thread new --projects"},
			{Name: "branch", Type: String, Description: "The branch a new worktree asks for, as thread new --branch (empty: named when the thread is made)"},
			{Name: "mode", Type: Enum, Enum: placementModes, Default: "worktree", Description: "worktree: new worktrees on the branch; checkout: each project's own checkout"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.CheckPlacement(ctx, connect.NewRequest(&v1.CheckPlacementRequest{
				ProjectIds: projectRefs(a.String("projects")), Branch: strings.TrimSpace(a.String("branch")), CheckoutMode: a.String("mode") == "checkout",
			}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: formatPlacement(res.Msg), JSON: res.Msg}, nil
		},
	}
}

// placementWords is how formatPlacement says each outcome.
var placementWords = map[v1.PlacementOutcome]string{
	v1.PlacementOutcome_PLACEMENT_OUTCOME_NEW:     "new worktree",
	v1.PlacementOutcome_PLACEMENT_OUTCOME_SHARE:   "shares",
	v1.PlacementOutcome_PLACEMENT_OUTCOME_FOLDER:  "folder",
	v1.PlacementOutcome_PLACEMENT_OUTCOME_REFUSED: "refused",
}

// formatPlacement is thread.placement.check's answer: the branch, then one line per
// project.
func formatPlacement(m *v1.CheckPlacementResponse) string {
	var sb strings.Builder
	switch {
	case m.GetBranchNamedAtCreate():
		sb.WriteString("branch: named when the thread is made\n")
	case m.GetBranch() != "":
		fmt.Fprintf(&sb, "branch: %s\n", m.GetBranch())
	}
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	for _, p := range m.GetMembers() {
		where := p.GetPath()
		switch {
		case p.GetOutcome() == v1.PlacementOutcome_PLACEMENT_OUTCOME_REFUSED:
			where = p.GetMessage()
		case where == "":
			where = "(path follows the branch)"
		case p.GetBranch() != "":
			where += " (" + p.GetBranch() + ")"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\n", p.GetProjectName(), placementWords[p.GetOutcome()], where)
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}
