package command

// baseFromOriginArg is thread.new's and project.worktree.new's --base-from-origin: an
// override of projects.base_from_origin for that one new worktree
// (project.CreateWorktreeOptions.BaseFromOrigin, startpoint.go). The setting is the
// default for the user's own threads; a thread new from an agent says where it starts
// when that matters (docs/notes/thread-new-base-origin.md).
var baseFromOriginArg = ArgSpec{Name: "base-from-origin", Type: Enum, Enum: []string{"yes", "no"},
	Description: "Override settings projects.base_from_origin for this worktree (default: the setting). " +
		"yes: the default branch, or a base that is a branch name, is origin's copy, fetched first, unless the local one is ahead. " +
		"no: the local branch, or base exactly as typed (an unpushed local branch works), and nothing is fetched."}

// baseFromOrigin is the --base-from-origin override: nil when not given (the setting).
func baseFromOrigin(a Args) (*bool, error) {
	switch v := a.String("base-from-origin"); v {
	case "":
		return nil, nil
	case "yes", "no":
		on := v == "yes"
		return &on, nil
	default:
		return nil, InvalidArg("base-from-origin", "must be yes or no, not %q", v)
	}
}
