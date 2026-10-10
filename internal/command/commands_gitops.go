package command

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// GitOpsBackend is the slice of GitOpsService the git.*, pr.*, worktree.open.* and
// view.open.url commands need, in generated Connect signatures (see TerminalBackend).
type GitOpsBackend interface {
	Fetch(context.Context, *connect.Request[v1.GitFetchRequest]) (*connect.Response[v1.GitFetchResponse], error)
	Pull(context.Context, *connect.Request[v1.GitPullRequest]) (*connect.Response[v1.GitPullResponse], error)
	Push(context.Context, *connect.Request[v1.GitPushRequest]) (*connect.Response[v1.GitPushResponse], error)
	CreatePullRequest(context.Context, *connect.Request[v1.CreatePullRequestRequest]) (*connect.Response[v1.CreatePullRequestResponse], error)
	OpenPullRequest(context.Context, *connect.Request[v1.OpenPullRequestRequest]) (*connect.Response[v1.OpenPullRequestResponse], error)
	OpenEditor(context.Context, *connect.Request[v1.OpenEditorRequest]) (*connect.Response[v1.OpenEditorResponse], error)
	Reveal(context.Context, *connect.Request[v1.RevealRequest]) (*connect.Response[v1.RevealResponse], error)
	OpenUrl(context.Context, *connect.Request[v1.OpenUrlRequest]) (*connect.Response[v1.OpenUrlResponse], error)
}

var (
	_ GitOpsBackend = codefoundryv1connect.GitOpsServiceHandler(nil)
	_ GitOpsBackend = codefoundryv1connect.GitOpsServiceClient(nil)
)

// GitOpsDeps are the git operation commands' dependencies.
type GitOpsDeps struct {
	// Backend runs the operations. Nil registers the commands against
	// UnimplementedGitOpsServiceHandler.
	Backend GitOpsBackend
	// GitHubSlug returns the GitHub "owner/name" of the context's worktree (or repo), or
	// "". pr.* are available only when it is non-empty. Nil means never.
	GitHubSlug func(Context) string
	// LocalOnly reports whether the context's worktree (or repo) belongs to a registered
	// repository with no git remote. git.fetch, git.pull, git.push and pr.* are
	// unavailable then. Nil means never.
	LocalOnly func(Context) bool
	// NotGit reports a project without git: git.fetch, git.pull, git.push and pr.* are
	// unavailable there, explained as such rather than as a missing remote. Nil means
	// never.
	NotGit NotGitFunc
}

// noRemote is why remote operations are unavailable in a local-only repository.
const noRemote = "repository has no remote"

func hasActiveWorktree(c Context) bool { return c.ActiveWorktreePath != "" }

// opResult turns a GitOpsService response into the command's result (see gitOpResult).
func opResult[T any, PT interface {
	*T
	GetOp() *v1.GitOp
}](res *connect.Response[T], err error) (Result, error) {
	if err != nil {
		return Result{}, err
	}
	return gitOpResult(PT(res.Msg).GetOp())
}

// gitOpResult turns a finished operation into the command's result. A failed op is an
// error that carries the op as a Connect error detail, so the GUI (which already shows
// the op from its gitops events) can tell it apart from a request that never ran.
func gitOpResult(op *v1.GitOp) (Result, error) {
	if op.GetState() == v1.GitOpState_GIT_OP_STATE_SUCCEEDED {
		msg := op.GetSummary()
		if u := op.GetUrl(); u != "" && !strings.Contains(msg, u) {
			msg += ": " + u
		}
		return Result{Message: msg, JSON: op}, nil
	}
	msg := op.GetTitle() + " failed: " + op.GetSummary()
	if out := tailLines(op.GetOutput(), 20); out != "" {
		msg += "\n\n" + out
	}
	ce := connect.NewError(connect.CodeUnknown, errors.New(msg))
	if d, derr := connect.NewErrorDetail(op); derr == nil {
		ce.AddDetail(d)
	}
	return Result{}, ce
}

// tailLines returns the last n lines of s, trimmed.
func tailLines(s string, n int) string {
	ls := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(ls) > n {
		ls = append([]string{"…"}, ls[len(ls)-n:]...)
	}
	return strings.TrimSpace(strings.Join(ls, "\n"))
}

// RegisterGitOps registers git.fetch, git.pull, git.push, pr.create, pr.open,
// worktree.open.editor, worktree.reveal, and view.open.url.
func RegisterGitOps(r *Registry, d GitOpsDeps) error {
	b := d.Backend
	if b == nil {
		b = codefoundryv1connect.UnimplementedGitOpsServiceHandler{}
	}
	slug := d.GitHubSlug
	if slug == nil {
		slug = func(Context) string { return "" }
	}
	localOnly := d.LocalOnly
	if localOnly == nil {
		localOnly = func(Context) bool { return false }
	}
	notGit := d.NotGit.or()
	hasRemote := func(c Context) bool { return hasActiveWorktree(c) && !notGit(c) && !localOnly(c) }
	hasGitHub := func(c Context) bool { return hasRemote(c) && slug(c) != "" }
	// whyNoGitHub explains an unavailable pr.* command once a worktree is known.
	whyNoGitHub := func(c Context) string {
		switch {
		case !hasActiveWorktree(c):
			return ""
		case notGit(c):
			return notGitReason
		case localOnly(c):
			return noRemote
		case slug(c) == "":
			return "repository is not on GitHub"
		}
		return ""
	}
	whyNoRemote := func(c Context) string {
		switch {
		case !hasActiveWorktree(c):
			return ""
		case notGit(c):
			return notGitReason
		case localOnly(c):
			return noRemote
		}
		return ""
	}
	wt := ArgSpec{Name: "worktree", Type: Path, Required: true, Context: ContextWorktree, Description: "Worktree path"}
	return r.RegisterAll(
		Command{
			Name:           "git.fetch",
			Title:          "Git: Fetch",
			Description:    "Fetch from the remote and prune deleted branches (git fetch --prune).",
			Category:       "Git",
			Keybindings:    []string{"cmd+shift+f"},
			Args:           []ArgSpec{wt},
			When:           hasRemote,
			WhyUnavailable: whyNoRemote,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Fetch(ctx, connect.NewRequest(&v1.GitFetchRequest{WorktreePath: a.Path("worktree")}))
				return opResult(res, err)
			},
		},
		Command{
			Name:        "git.pull",
			Title:       "Git: Pull",
			Description: "Pull the upstream branch, fast-forward only unless --rebase. A conflicting rebase is aborted.",
			Category:    "Git",
			Keybindings: []string{"cmd+shift+u"},
			Args: []ArgSpec{wt,
				{Name: "rebase", Type: Bool, Description: "Rebase local commits onto the upstream instead of requiring a fast-forward"},
			},
			When:           hasRemote,
			WhyUnavailable: whyNoRemote,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Pull(ctx, connect.NewRequest(&v1.GitPullRequest{WorktreePath: a.Path("worktree"), Rebase: a.Bool("rebase")}))
				return opResult(res, err)
			},
		},
		Command{
			Name:        "git.push",
			Title:       "Git: Push",
			Description: "Push the current branch; a branch without upstream is pushed to origin and tracks it.",
			Category:    "Git",
			Keybindings: []string{"cmd+shift+k"},
			Args: []ArgSpec{wt,
				{Name: "force-with-lease", Type: Bool, Description: "Overwrite the remote branch if it is where we last saw it"},
			},
			When:           hasRemote,
			WhyUnavailable: whyNoRemote,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Push(ctx, connect.NewRequest(&v1.GitPushRequest{WorktreePath: a.Path("worktree"), ForceWithLease: a.Bool("force-with-lease")}))
				return opResult(res, err)
			},
		},
		Command{
			Name:        "pr.create",
			Title:       "Create Pull Request",
			Description: "Push the branch and open a GitHub pull request for it (gh pr create).",
			Category:    "Pull Request",
			Args: []ArgSpec{wt,
				{Name: "title", Type: String, Description: "Title (default: the last commit's subject)"},
				{Name: "body", Type: String, Description: "Description"},
				{Name: "draft", Type: Bool, Description: "Open as a draft"},
				{Name: "base", Type: String, Description: "Base branch (default: the repository's default branch)"},
			},
			When:           hasGitHub,
			WhyUnavailable: whyNoGitHub,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.CreatePullRequest(ctx, connect.NewRequest(&v1.CreatePullRequestRequest{
					WorktreePath: a.Path("worktree"), Title: a.String("title"), Body: a.String("body"), Draft: a.Bool("draft"), Base: a.String("base"),
				}))
				return opResult(res, err)
			},
		},
		Command{
			Name:           "pr.open",
			Title:          "Open Pull Request in Browser",
			Description:    "Open the current branch's pull request on GitHub.",
			Category:       "Pull Request",
			Args:           []ArgSpec{wt},
			When:           hasGitHub,
			WhyUnavailable: whyNoGitHub,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.OpenPullRequest(ctx, connect.NewRequest(&v1.OpenPullRequestRequest{WorktreePath: a.Path("worktree")}))
				return opResult(res, err)
			},
		},
		Command{
			Name:        "worktree.open.editor",
			Title:       "Open Worktree in Editor",
			Description: "Open the worktree in the configured editor (default: $VISUAL/$EDITOR if it is a GUI editor, else Cursor, VS Code, Zed, or Sublime Text).",
			Category:    "Worktree",
			Keybindings: []string{"cmd+shift+o"},
			Args:        []ArgSpec{wt},
			When:        hasActiveWorktree,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.OpenEditor(ctx, connect.NewRequest(&v1.OpenEditorRequest{WorktreePath: a.Path("worktree")}))
				return opResult(res, err)
			},
		},
		Command{
			Name:        "worktree.reveal",
			Title:       "Reveal Worktree in Finder",
			Description: "Show the worktree folder in Finder.",
			Category:    "Worktree",
			Args:        []ArgSpec{wt},
			When:        hasActiveWorktree,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Reveal(ctx, connect.NewRequest(&v1.RevealRequest{WorktreePath: a.Path("worktree")}))
				return opResult(res, err)
			},
		},
		Command{
			Name:        "view.open.url",
			Title:       "Open URL in Browser",
			Description: "Open an http(s) URL in the default browser.",
			Category:    "View",
			Args:        []ArgSpec{{Name: "url", Type: String, Required: true, Description: "http or https URL"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.OpenUrl(ctx, connect.NewRequest(&v1.OpenUrlRequest{Url: a.String("url")}))
				return opResult(res, err)
			},
		},
	)
}
