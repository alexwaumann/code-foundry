package daemon

import (
	"context"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

type fakeGitOpsGHStore struct {
	mu     sync.Mutex
	prs    []gh.PullRequest
	pushed []string
}

func (f *fakeGitOpsGHStore) CachedPullRequests() []gh.PullRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.prs)
}

func (f *fakeGitOpsGHStore) BranchPushed(_ context.Context, slug, head string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pushed = append(f.pushed, slug+"|"+head)
	return nil
}

func TestGitOpsGitHubBridgeOpenBranchPR(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	store := &fakeGitOpsGHStore{
		prs: []gh.PullRequest{
			// Merged PR on same branch: must be ignored.
			{Repo: "acme/app", HeadRef: "feat/a", Number: 10, URL: "https://github.com/acme/app/pull/10", State: gh.PullRequestMerged, UpdatedAt: t0.Add(time.Hour)},
			// Closed PR on same branch: must be ignored.
			{Repo: "acme/app", HeadRef: "feat/a", Number: 11, URL: "https://github.com/acme/app/pull/11", State: gh.PullRequestClosed, UpdatedAt: t0.Add(time.Hour)},
			// Cross-repo (fork) PR with same branch name: must be ignored.
			{Repo: "acme/app", HeadRef: "feat/a", Number: 12, URL: "https://github.com/acme/app/pull/12", State: gh.PullRequestOpen, IsCrossRepository: true, UpdatedAt: t0.Add(2 * time.Hour)},
			// Two open PRs on feat/a: newer UpdatedAt wins.
			{Repo: "acme/app", HeadRef: "feat/a", Number: 13, URL: "https://github.com/acme/app/pull/13", State: gh.PullRequestOpen, UpdatedAt: t0},
			{Repo: "acme/app", HeadRef: "feat/a", Number: 14, URL: "https://github.com/acme/app/pull/14", State: gh.PullRequestOpen, UpdatedAt: t0.Add(10 * time.Minute)},
			// Only closed PR on feat/closed: cache miss.
			{Repo: "acme/app", HeadRef: "feat/closed", Number: 15, URL: "https://github.com/acme/app/pull/15", State: gh.PullRequestClosed, UpdatedAt: t0},
		},
	}
	bridge := newGitOpsGitHubBridge(store, slog.New(slog.DiscardHandler))

	tests := []struct {
		name    string
		slug    string
		branch  string
		wantURL string
		wantNum int
		wantOK  bool
	}{
		{"case-insensitive slug picks newest open PR", "Acme/App", "feat/a", "https://github.com/acme/app/pull/14", 14, true},
		{"branch with only closed PR is miss", "acme/app", "feat/closed", "", 0, false},
		{"unknown branch is miss", "acme/app", "feat/none", "", 0, false},
		{"other repo is miss", "other/app", "feat/a", "", 0, false},
		{"empty slug is miss", "", "feat/a", "", 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, n, ok := bridge.OpenBranchPR(tt.slug, tt.branch)
			if u != tt.wantURL || n != tt.wantNum || ok != tt.wantOK {
				t.Errorf("OpenBranchPR(%q, %q) = (%q, %d, %v), want (%q, %d, %v)",
					tt.slug, tt.branch, u, n, ok, tt.wantURL, tt.wantNum, tt.wantOK)
			}
		})
	}
}

func TestGitOpsGitHubBridgeNotifyBranchChanged(t *testing.T) {
	store := &fakeGitOpsGHStore{}
	bridge := newGitOpsGitHubBridge(store, slog.New(slog.DiscardHandler))
	bridge.NotifyBranchChanged(context.Background(), "acme/app", "feat/push")

	// The spaced push path only: Refresh (unspaced, for a person waiting) is not
	// part of the bridge's store interface.
	if !slices.Equal(store.pushed, []string{"acme/app|feat/push"}) {
		t.Errorf("pushed = %v, want [acme/app|feat/push]", store.pushed)
	}
}

func TestConfigureUpdateSource(t *testing.T) {
	src := &update.GhSource{Repo: "acme/app"}
	uo := update.Options{Source: src}
	var cfg settings.Settings
	cfg.Advanced.GhPath = "/opt/homebrew/bin/gh"
	configureUpdateSource(&uo, cfg)
	if src.Gh != "/opt/homebrew/bin/gh" {
		t.Errorf("src.Gh = %q, want /opt/homebrew/bin/gh", src.Gh)
	}
	if !strings.HasPrefix(src.UserAgent, "code-foundry/") {
		t.Errorf("src.UserAgent = %q, want code-foundry/ prefix", src.UserAgent)
	}
	// Non-GhSource is a no-op.
	uoDir := update.Options{Source: update.DirSource{Dir: "/tmp"}}
	configureUpdateSource(&uoDir, cfg)
}
