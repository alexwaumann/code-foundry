package command

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

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
	// is a clone of the slug, else the head's worktree, else the main worktree.
	prSessionRead prSessionKind = iota
	// prSessionFix (fix.findings): explicit worktree, else the head's worktree, else a
	// new worktree for the head branch (same-repository pull requests only).
	prSessionFix
)

// prHead is the pull request's head as the worktree rules need it.
type prHead struct {
	Ref   string // branch name, on the base repository or the fork
	SHA   string // commit
	Cross bool   // the branch lives on a fork
}

func prHeadOf(pr *v1.PullRequest) prHead {
	return prHead{Ref: pr.GetHeadRef(), SHA: pr.GetHeadSha(), Cross: pr.GetIsCrossRepository()}
}

// checkedOutIn reports whether wt has h checked out. A same-repository head matches
// by branch name. A fork's branch name says nothing (a contributor's "main" is not
// ours), so a fork's head matches a worktree at its head commit, or one whose upstream
// is <remote>/<ref> on a remote other than origin (`gh pr checkout` with a remote for
// the fork). origin/<ref> never matches a fork's head.
func (h prHead) checkedOutIn(wt *v1.Worktree) bool {
	if !h.Cross {
		return h.Ref != "" && !wt.GetDetached() && wt.GetBranch() == h.Ref
	}
	if h.SHA != "" && strings.EqualFold(wt.GetHead(), h.SHA) {
		return true
	}
	if h.Ref == "" {
		return false
	}
	remote, ok := strings.CutSuffix(wt.GetStatus().GetUpstream(), "/"+h.Ref)
	return ok && remote != "" && remote != "origin"
}

// clonesOf returns the registered repositories whose github_slug is slug
// (case-insensitively), in order.
func clonesOf(repos []*v1.Repo, slug string) []*v1.Repo {
	var clones []*v1.Repo
	for _, r := range repos {
		if r.GetGithubSlug() != "" && strings.EqualFold(r.GetGithubSlug(), slug) {
			clones = append(clones, r)
		}
	}
	return clones
}

// headWorktree is the first worktree of clones that has h checked out, or nil.
func headWorktree(clones []*v1.Repo, h prHead) *v1.Worktree {
	for _, r := range clones {
		for _, wt := range r.GetWorktrees() {
			if h.checkedOutIn(wt) {
				if wt.GetRepoId() == "" {
					wt = proto.CloneOf(wt)
					wt.RepoId = r.GetId()
				}
				return wt
			}
		}
	}
	return nil
}

// worktreeStatus is the status of the registered worktree at path, or nil.
func worktreeStatus(repos []*v1.Repo, path string) *v1.GitStatus {
	path = filepath.Clean(path)
	for _, r := range repos {
		for _, wt := range r.GetWorktrees() {
			if filepath.Clean(wt.GetPath()) == path {
				return wt.GetStatus()
			}
		}
	}
	return nil
}

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
func pickPRWorktree(kind prSessionKind, repos []*v1.Repo, slug string, number int, head prHead, explicit, active string) (prWorktreePick, error) {
	if explicit != "" {
		return prWorktreePick{Path: filepath.Clean(explicit)}, nil
	}
	clones := clonesOf(repos, slug)
	if len(clones) == 0 {
		return prWorktreePick{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
			"no registered repository is a clone of %s: add one with `code-foundry repo add <folder>`, or pass --worktree", slug))
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
	if wt := headWorktree(clones, head); wt != nil {
		return prWorktreePick{RepoID: wt.GetRepoId(), Path: wt.GetPath()}, nil
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
	case head.Ref == "":
		return prWorktreePick{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
			"#%d has no head branch to check out: pass --worktree", number))
	case head.Cross:
		return prWorktreePick{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf(
			"#%d comes from a fork and no worktree of %s has its head checked out: check it out (for example `gh pr checkout %d` in a worktree) and pass --worktree",
			number, slug, number))
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

	start := func(ctx context.Context, uctx Context, a Args, kind prSessionKind, prompt func(*v1.PullRequestDetail, PRCheckout) string) (Result, error) {
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
		// Check the size before anything changes on disk. The worst-case checkout bounds
		// the prompt built below, whatever the worktree's state turns out to be.
		if p := prompt(detail, PRCheckout{Behind: math.MaxInt32, Dirty: true}); len(p) > MaxPRPromptBytes {
			return Result{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(
				"the prompt for #%d would be %d KiB, over the %d KiB a session can start with", n, (len(p)+1023)>>10, MaxPRPromptBytes>>10))
		}
		explicit := a.Path("worktree")
		var repos []*v1.Repo
		if explicit == "" || kind == prSessionFix {
			list, err := d.Repo.List(ctx, connect.NewRequest(&v1.ListReposRequest{}))
			switch {
			case err == nil:
				repos = list.Msg.GetRepos()
			case explicit == "":
				return Result{}, wrapStep("list repositories", err)
			} // An explicit worktree only loses its status line in the prompt.
		}
		head := prHeadOf(pr)
		pick, err := pickPRWorktree(kind, repos, s, n, head, explicit, uctx.ActiveWorktreePath)
		if err != nil {
			return Result{}, err
		}
		status := worktreeStatus(repos, pick.Path)
		if pick.Create {
			wt, err := createPRWorktree(ctx, d, pick, s, head)
			if err != nil {
				return Result{}, err
			}
			pick.RepoID, pick.Path, status = cmp.Or(wt.GetRepoId(), pick.RepoID), wt.GetPath(), wt.GetStatus()
		}
		created, err := d.Session.Create(ctx, connect.NewRequest(&v1.CreateSessionRequest{
			RepoId: pick.RepoID, WorktreePath: pick.Path, Model: a.String("model"), Effort: a.String("effort"),
			InitialPrompt: prompt(detail, prCheckoutOf(status)),
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
				return start(ctx, uctx, a, prSessionRead, func(d *v1.PullRequestDetail, _ PRCheckout) string {
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
				return start(ctx, uctx, a, prSessionRead, func(d *v1.PullRequestDetail, _ PRCheckout) string {
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

// createPRWorktree fetches the head branch from origin in the repository's main
// worktree, then creates a worktree for it from origin/<head>. CreateWorktree checks
// out an existing local branch of that name as is; otherwise it creates the branch at
// origin/<head>, tracking it, and fails if origin has no such branch rather than
// branching from the default branch. When the create fails as a precondition (another
// run created the worktree since the pick), the repositories are listed once more and
// a worktree now on the head is used instead.
func createPRWorktree(ctx context.Context, d PullRequestSessionDeps, pick prWorktreePick, slug string, head prHead) (*v1.Worktree, error) {
	step := "fetch origin/" + head.Ref
	fetched, err := d.GitOps.Fetch(ctx, connect.NewRequest(&v1.GitFetchRequest{WorktreePath: pick.MainPath, Remote: "origin", Branch: head.Ref}))
	if err != nil {
		return nil, wrapStep(step, err)
	}
	if _, err := gitOpResult(fetched.Msg.GetOp()); err != nil {
		return nil, wrapStep(step, err)
	}
	res, err := d.Repo.CreateWorktree(ctx, connect.NewRequest(&v1.CreateWorktreeRequest{
		RepoId: pick.RepoID, Branch: head.Ref, BaseRef: "origin/" + head.Ref,
	}))
	if err == nil {
		return res.Msg.GetWorktree(), nil
	}
	if connect.CodeOf(err) == connect.CodeFailedPrecondition {
		if list, lerr := d.Repo.List(ctx, connect.NewRequest(&v1.ListReposRequest{})); lerr == nil {
			if wt := headWorktree(clonesOf(list.Msg.GetRepos(), slug), head); wt != nil {
				return wt, nil
			}
		}
	}
	return nil, wrapStep("create a worktree for "+head.Ref, err)
}
