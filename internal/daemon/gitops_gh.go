package daemon

import (
	"context"
	"log/slog"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// gitopsGitHubStore is the narrow slice of *gh.Store bridged into gitops.
type gitopsGitHubStore interface {
	CachedPullRequests() []gh.PullRequest
	BranchPushed(ctx context.Context, slug, head string) error
}

var _ gitopsGitHubStore = (*gh.Store)(nil)

// gitopsGitHubBridge connects gitops to gh.Store without coupling the two store packages:
// OpenPR reads cached open pull requests directly in memory, and Push / CreatePR watch
// the branch and ask for a poll (spaced, gh.Store.BranchPushed) so PR panels and checks
// update right away.
type gitopsGitHubBridge struct {
	gh  gitopsGitHubStore
	log *slog.Logger
}

var _ gitops.GitHub = (*gitopsGitHubBridge)(nil)

func newGitOpsGitHubBridge(store gitopsGitHubStore, log *slog.Logger) gitops.GitHub {
	if store == nil {
		return nil
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &gitopsGitHubBridge{gh: store, log: log}
}

// OpenBranchPR implements gitops.GitHub. It scans the GitHub store's in-memory cached
// pull requests (dashboards and watched branches) for an open, non-fork pull request
// whose head is branch in slug, preferring the most recently updated match.
func (b *gitopsGitHubBridge) OpenBranchPR(slug, branch string) (string, int, bool) {
	slug = strings.ToLower(strings.TrimSpace(slug))
	branch = strings.TrimSpace(branch)
	if slug == "" || branch == "" {
		return "", 0, false
	}
	var best gh.PullRequest
	found := false
	for _, p := range b.gh.CachedPullRequests() {
		if p.State != gh.PullRequestOpen || p.IsCrossRepository {
			continue
		}
		if p.URL == "" || p.Number <= 0 || p.HeadRef != branch || !strings.EqualFold(p.Repo, slug) {
			continue
		}
		if !found || p.UpdatedAt.After(best.UpdatedAt) || (p.UpdatedAt.Equal(best.UpdatedAt) && p.Number > best.Number) {
			best, found = p, true
		}
	}
	if !found {
		return "", 0, false
	}
	return best.URL, best.Number, true
}

// NotifyBranchChanged implements gitops.GitHub. It registers the branch watch and asks
// for a GitHub poll (non-blocking) so newly pushed commits and newly created pull
// requests appear without waiting for the regular poll interval: at once after a quiet
// stretch, spaced when many pushes come together (gh.Store.BranchPushed). It does not
// use Refresh, which is unspaced and kept for what a person waits on.
func (b *gitopsGitHubBridge) NotifyBranchChanged(ctx context.Context, slug, branch string) {
	if err := b.gh.BranchPushed(ctx, slug, branch); err != nil && ctx.Err() == nil {
		b.log.Debug("gitops: notify github of push", "slug", slug, "branch", branch, "err", err)
	}
}

// configureUpdateSource applies daemon-level GitHub settings (configured gh path and
// User-Agent) to update.Options.Source when it is a *update.GhSource.
func configureUpdateSource(uo *update.Options, cfg settings.Settings) {
	src, ok := uo.Source.(*update.GhSource)
	if !ok {
		return
	}
	src.Gh = settings.ExpandedPath(cfg.Advanced.GhPath)
	src.UserAgent = "code-foundry/" + version.Version
}
