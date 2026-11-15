package command

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// includeCommand is project.files.include: set a project's include patterns, the
// git-ignored files its file search lists too on top of the files.include_ignored
// setting's (docs/notes/file-search-1-includes.md). The whole list at once, like the
// setting: comma-separated, none to clear.
func includeCommand(b ProjectBackend, projectArg ArgSpec) Command {
	projectArg.Positional = true
	return Command{
		Name:  "project.files.include",
		Page:  PageState,
		Title: "Include Ignored Files in Search",
		Description: "Set the git-ignored files a project's Go to File and @ completion list too, on top of the files.include_ignored setting's: " +
			".gitignore-style patterns separated by commas (.env*, docs/scratch/), replacing the project's list; none clears it. " +
			"A name never reaches inside an ignored folder that does not match itself.",
		Category: "Project",
		Args: []ArgSpec{
			projectArg,
			{Name: "patterns", Type: String, Required: true, Positional: true, Description: "Comma-separated patterns, or none"},
		},
		When: hasProject,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			patterns := splitPatterns(a.String("patterns"))
			res, err := b.SetIncludeIgnored(ctx, connect.NewRequest(&v1.SetIncludeIgnoredRequest{Id: a.String("project"), Patterns: patterns}))
			if err != nil {
				return Result{}, err
			}
			p := res.Msg.GetProject()
			msg := "project " + p.GetName() + " includes no ignored files of its own"
			if ps := p.GetIncludeIgnored(); len(ps) > 0 {
				msg = "project " + p.GetName() + " includes ignored files matching " + strings.Join(ps, ", ")
			}
			return Result{Message: msg, JSON: p}, nil
		},
	}
}

// splitPatterns reads the patterns arg: comma-separated, trimmed, blanks dropped, or
// none. Validation is the daemon's.
func splitPatterns(v string) []string {
	if strings.EqualFold(strings.TrimSpace(v), fsx.IncludeNone) {
		return nil
	}
	var out []string
	for p := range strings.SplitSeq(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
