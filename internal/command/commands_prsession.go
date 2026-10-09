package command

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// PullRequestSessionDeps are the dependencies of pr.ask, pr.explain and
// pr.fix.findings: commands that start a Claude session about a pull request. Nil
// backends register the commands against the Unimplemented handlers.
type PullRequestSessionDeps struct {
	// Gh reads the pull request (GetPullRequestDetail).
	Gh GhBackend
	// Repo lists registered repositories (to find the clone of the slug and its
	// worktrees) and creates the head branch's worktree for pr.fix.findings.
	Repo RepoBackend
	// Session starts the session (Create with an initial prompt).
	Session SessionBackend
	// GitOps fetches origin before pr.fix.findings creates a worktree.
	GitOps GitOpsBackend
	// Emitter focuses the new session, as session.new does. Required.
	Emitter Emitter
}

// prSessionKind says which worktree rules a command follows (see pickPRWorktree).
type prSessionKind int

const (
	// prSessionRead (ask, explain): explicit worktree, else the active worktree when it
	// is a clone of the slug, else the head branch's worktree, else the main worktree.
	prSessionRead prSessionKind = iota
	// prSessionFix (fix.findings): explicit worktree, else the head branch's worktree,
	// else a new worktree for the head branch (same-repository pull requests only).
	prSessionFix
)

// prWorktreePick is where a pull request session runs.
type prWorktreePick struct {
	// RepoID is the registered repository; empty for an explicit worktree, which the
	// session store resolves itself.
	RepoID string
	// Path is the worktree; empty when Create.
	Path string
	// Create: create a worktree for the head branch in RepoID first.
	Create bool
	// MainPath is RepoID's main worktree (Create fetches there).
	MainPath string
}

// pickPRWorktree chooses the worktree for a pull request session. repos are the
// registered repositories in RepoService.List order; the clones of slug are those
// whose github_slug matches it (case-insensitively). explicit is the worktree arg,
// active the caller's active worktree. Errors are FailedPrecondition.
func pickPRWorktree(kind prSessionKind, repos []*v1.Repo, slug string, number int, headRef string, crossRepo bool, explicit, active string) (prWorktreePick, error) {
	if explicit != "" {
		return prWorktreePick{Path: filepath.Clean(explicit)}, nil
	}
	var clones []*v1.Repo
	for _, r := range repos {
		if r.GetGithubSlug() != "" && strings.EqualFold(r.GetGithubSlug(), slug) {
			clones = append(clones, r)
		}
	}
	if len(clones) == 0 {
		return prWorktreePick{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
			"no registered repository is a clone of %s: add one with `code-foundry repo register <path>`, or pass --worktree", slug))
	}
	if kind == prSessionRead && active != "" {
		active = filepath.Clean(active)
		for _, r := range clones {
			for _, wt := range r.GetWorktrees() {
				if filepath.Clean(wt.GetPath()) == active {
					return prWorktreePick{RepoID: r.GetId(), Path: wt.GetPath()}, nil
				}
			}
		}
	}
	if headRef != "" {
		for _, r := range clones {
			for _, wt := range r.GetWorktrees() {
				if !wt.GetDetached() && wt.GetBranch() == headRef {
					return prWorktreePick{RepoID: r.GetId(), Path: wt.GetPath()}, nil
				}
			}
		}
	}
	main := func(r *v1.Repo) string {
		for _, wt := range r.GetWorktrees() {
			if wt.GetIsMain() {
				return wt.GetPath()
			}
		}
		return r.GetPath()
	}
	if kind == prSessionRead {
		return prWorktreePick{RepoID: clones[0].GetId(), Path: main(clones[0])}, nil
	}
	switch {
	case headRef == "":
		return prWorktreePick{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
			"#%d has no head branch to check out: pass --worktree", number))
	case crossRepo:
		return prWorktreePick{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
			"#%d comes from a fork and no worktree of %s is on its branch %q: check it out (for example `gh pr checkout %d` in a worktree) and pass --worktree",
			number, slug, headRef, number))
	}
	return prWorktreePick{RepoID: clones[0].GetId(), Create: true, MainPath: main(clones[0])}, nil
}

// stepError prefixes a backend error with the step that failed, keeping its Connect
// code (wrapStep) and the original error for errors.Is/As.
type stepError struct {
	step string
	err  error
}

func (e *stepError) Error() string {
	var ce *connect.Error
	if errors.As(e.err, &ce) {
		return e.step + ": " + ce.Message()
	}
	return e.step + ": " + e.err.Error()
}

func (e *stepError) Unwrap() error { return e.err }

// wrapStep wraps err with step. A Connect error stays a Connect error with its code
// (internal/api forwards *connect.Error as is); anything else is wrapped with %w.
func wrapStep(step string, err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return connect.NewError(ce.Code(), &stepError{step: step, err: err})
	}
	return fmt.Errorf("%s: %w", step, err)
}

// RegisterPullRequestSessions registers pr.ask, pr.explain and pr.fix.findings. Each
// reads the pull request, picks (or, for fix.findings, creates) a worktree, starts a
// session there with a prompt about the pull request, and focuses it.
func RegisterPullRequestSessions(r *Registry, d PullRequestSessionDeps) error {
	if d.Emitter == nil {
		return errors.New("register pull request sessions: Emitter is required")
	}
	if d.Gh == nil {
		d.Gh = codefoundryv1connect.UnimplementedGhServiceHandler{}
	}
	if d.Repo == nil {
		d.Repo = codefoundryv1connect.UnimplementedRepoServiceHandler{}
	}
	if d.Session == nil {
		d.Session = codefoundryv1connect.UnimplementedSessionServiceHandler{}
	}
	if d.GitOps == nil {
		d.GitOps = codefoundryv1connect.UnimplementedGitOpsServiceHandler{}
	}
	slug := ArgSpec{Name: "repo-slug", Type: String, Required: true, Positional: true, Description: `GitHub repository, "owner/name"`}
	number := ArgSpec{Name: "number", Type: Int, Required: true, Positional: true, Description: "Pull request number"}
	// Not context-bound: an explicit worktree must be told apart from the active one,
	// which pr.ask and pr.explain use only when it is a clone of the slug and
	// pr.fix.findings ignores.
	worktree := ArgSpec{Name: "worktree", Type: Path, Description: "Worktree to start the session in (default: picked from the registered clones of repo-slug and the pull request's branch)"}
	model := ArgSpec{Name: "model", Type: Enum, Enum: SessionModels, Description: "Model (default: settings sessions.default_model, else Claude's default)"}
	effort := ArgSpec{Name: "effort", Type: Enum, Enum: SessionEfforts, Description: "Effort level (default: settings sessions.default_effort, else Claude's default)"}

	start := func(ctx context.Context, uctx Context, a Args, kind prSessionKind, prompt func(*v1.PullRequestDetail) string) (Result, error) {
		if err := checkPullRequestArgs(a); err != nil {
			return Result{}, err
		}
		s, n := strings.TrimSpace(a.String("repo-slug")), a.Int("number")
		res, err := d.Gh.GetPullRequestDetail(ctx, connect.NewRequest(&v1.GetPullRequestDetailRequest{
			RepoSlug: s, Number: int32(n), Refresh: kind == prSessionFix,
		}))
		if err != nil {
			return Result{}, wrapStep(fmt.Sprintf("read #%d", n), err)
		}
		detail := res.Msg.GetDetail()
		pr := detail.GetPullRequest()
		if pr == nil {
			return Result{}, connect.NewError(connect.CodeNotFound, fmt.Errorf("pull request %s#%d was not returned", s, n))
		}
		var repos []*v1.Repo
		if a.Path("worktree") == "" {
			list, err := d.Repo.List(ctx, connect.NewRequest(&v1.ListReposRequest{}))
			if err != nil {
				return Result{}, wrapStep("list repositories", err)
			}
			repos = list.Msg.GetRepos()
		}
		pick, err := pickPRWorktree(kind, repos, s, n, pr.GetHeadRef(), pr.GetIsCrossRepository(), a.Path("worktree"), uctx.ActiveWorktreePath)
		if err != nil {
			return Result{}, err
		}
		if pick.Create {
			if pick.Path, err = createPRWorktree(ctx, d, pick, pr.GetHeadRef()); err != nil {
				return Result{}, err
			}
		}
		created, err := d.Session.Create(ctx, connect.NewRequest(&v1.CreateSessionRequest{
			RepoId: pick.RepoID, WorktreePath: pick.Path, Model: a.String("model"), Effort: a.String("effort"),
			InitialPrompt: prompt(detail),
		}))
		if err != nil {
			return Result{}, wrapStep("start session", err)
		}
		sess := created.Msg.GetSession()
		d.Emitter.Emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusSession_{FocusSession: &v1.UiIntent_FocusSession{SessionId: sess.GetId()}}})
		return Result{Message: fmt.Sprintf("Started session %s for PR #%d", sessionLabel(sess), n), JSON: sess}, nil
	}

	return r.RegisterAll(
		Command{
			Name:        "pr.ask",
			Title:       "Ask About Pull Request",
			Description: "Start a Claude session that answers a question about a pull request without changing code.",
			Category:    "Pull Request",
			Args: []ArgSpec{slug, number,
				{Name: "question", Type: String, Required: true, Positional: true, Description: "What to ask"},
				worktree, model, effort,
			},
			When: hasPullRequest,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				q := sanitizeQuestion(a.String("question"))
				if q == "" {
					return Result{}, InvalidArg("question", "question is required")
				}
				return start(ctx, uctx, a, prSessionRead, func(d *v1.PullRequestDetail) string {
					return AskPRPrompt(prPromptInfo(d.GetPullRequest()), q)
				})
			},
		},
		Command{
			Name:        "pr.explain",
			Title:       "Explain Pull Request",
			Description: "Start a Claude session that walks through a pull request for a first-time reviewer.",
			Category:    "Pull Request",
			Args:        []ArgSpec{slug, number, worktree, model, effort},
			When:        hasPullRequest,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				return start(ctx, uctx, a, prSessionRead, func(d *v1.PullRequestDetail) string {
					return ExplainPRPrompt(prPromptInfo(d.GetPullRequest()))
				})
			},
		},
		Command{
			Name:        "pr.fix.findings",
			Title:       "Fix Pull Request Findings",
			Description: "Start a Claude session on the pull request's branch that fixes its unresolved review comments and failing checks.",
			Category:    "Pull Request",
			Args:        []ArgSpec{slug, number, worktree, model, effort},
			When:        hasPullRequest,
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				return start(ctx, uctx, a, prSessionFix, FixFindingsPRPrompt)
			},
		},
	)
}

// createPRWorktree fetches origin in the repository's main worktree, then creates a
// worktree for the head branch from origin/<head>. CreateWorktree checks out an
// existing local branch of that name as is; otherwise it creates the branch at
// origin/<head> (without an upstream: the gitops push sets it on the first push), and
// fails if origin has no such branch rather than branching from the default branch.
func createPRWorktree(ctx context.Context, d PullRequestSessionDeps, pick prWorktreePick, headRef string) (string, error) {
	fetched, err := d.GitOps.Fetch(ctx, connect.NewRequest(&v1.GitFetchRequest{WorktreePath: pick.MainPath}))
	if err != nil {
		return "", wrapStep("fetch origin", err)
	}
	if _, err := gitOpResult(fetched.Msg.GetOp()); err != nil {
		return "", wrapStep("fetch origin", err)
	}
	res, err := d.Repo.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{
		RepoId: pick.RepoID, Branch: headRef, BaseRef: "origin/" + headRef,
	}))
	if err != nil {
		return "", wrapStep("create a worktree for "+headRef, err)
	}
	return res.Msg.GetWorktree().GetPath(), nil
}
