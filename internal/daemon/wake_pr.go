package daemon

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Wake subscriptions to pull requests (docs/notes/gh-events-3-pr-wake.md): the thread
// store does not know the GitHub store, so the daemon looks pull requests up in its
// cache (thread.Options.PullRequest), keeps the subscribed ones in the poll
// (thread.Options.WatchPullRequests) and hands it every PullRequestChanged
// (startWakePullRequests).

// prCache is the part of the GitHub store wake subscriptions read and steer.
// *gh.Store implements it.
type prCache interface {
	CachedPullRequest(slug string, number int) (gh.PullRequest, bool)
	WatchPullRequests(refs []gh.PullRequestRef) error
}

var _ prCache = (*gh.Store)(nil)

// prRef splits a thread store target ("owner/name#123") into a gh.PullRequestRef.
func prRef(target string) (gh.PullRequestRef, bool) {
	i := strings.LastIndexByte(target, '#')
	if i < 0 {
		return gh.PullRequestRef{}, false
	}
	n, err := strconv.Atoi(target[i+1:])
	if err != nil || n <= 0 {
		return gh.PullRequestRef{}, false
	}
	return gh.PullRequestRef{Slug: target[:i], Number: n}, true
}

// pullRequestForWake is thread.Options.PullRequest over the GitHub store's cache.
func pullRequestForWake(prs prCache) func(ctx context.Context, target string) (thread.PullRequestInfo, bool) {
	return func(_ context.Context, target string) (thread.PullRequestInfo, bool) {
		r, ok := prRef(target)
		if !ok {
			return thread.PullRequestInfo{}, false
		}
		p, ok := prs.CachedPullRequest(r.Slug, r.Number)
		if !ok {
			return thread.PullRequestInfo{}, false
		}
		info := prInfo(p)
		info.Slug, info.Number = r.Slug, r.Number
		return info, true
	}
}

// watchPullRequestsForWake is thread.Options.WatchPullRequests: the GitHub store keeps
// the subscribed pull requests in its poll.
func watchPullRequestsForWake(log *slog.Logger, prs prCache) func(targets []string) {
	return func(targets []string) {
		refs := make([]gh.PullRequestRef, 0, len(targets))
		for _, t := range targets {
			if r, ok := prRef(t); ok {
				refs = append(refs, r)
			}
		}
		if err := prs.WatchPullRequests(refs); err != nil {
			log.Warn("watch the subscribed pull requests", "targets", targets, "err", err)
		}
	}
}

// prState maps a pull request state for a wake: "open", "merged", "closed".
func prState(s gh.PullRequestState) string { return strings.ToLower(string(s)) }

func prChecks(c gh.CheckRollup) thread.PRChecks {
	return thread.PRChecks{State: string(c.State), Total: c.Total, Passed: c.Passed, Failed: c.Failed, Pending: c.Pending, Skipped: c.Skipped}
}

// prInfo maps the GitHub store's summary.
func prInfo(p gh.PullRequest) thread.PullRequestInfo {
	out := thread.PullRequestInfo{
		Slug: strings.ToLower(p.Repo), Number: p.Number, URL: p.URL, Title: p.Title, State: prState(p.State),
		HeadSHA: p.HeadSHA, HeadRef: p.HeadRef, Draft: p.Draft, ReviewDecision: string(p.ReviewDecision),
		Checks: prChecks(p.Checks), Reviews: p.Reviews, Comments: p.Comments, ReviewRequests: p.ReviewRequests,
		MergedAt: p.MergedAt,
	}
	for _, r := range p.LatestReviews {
		out.LatestReviews = append(out.LatestReviews, thread.PRReview{Author: r.Author, State: r.State, SubmittedAt: r.SubmittedAt})
	}
	return out
}

// prEvent maps a PullRequestChanged.
func prEvent(e gh.PullRequestChanged) thread.PullRequestEvent {
	info := prInfo(e.PullRequest)
	info.Slug, info.Number = strings.ToLower(e.Slug), e.Number
	if info.URL == "" {
		info.URL = e.URL
	}
	if info.HeadRef == "" {
		info.HeadRef = e.HeadRef
	}
	out := thread.PullRequestEvent{PullRequest: info}
	for _, c := range e.Changes {
		out.Changes = append(out.Changes, thread.PullRequestChange{
			Kind: thread.PRChangeKind(c.Kind), OldState: prState(c.OldState), NewState: prState(c.NewState),
			OldHeadSHA: c.OldHeadSHA, NewHeadSHA: c.NewHeadSHA, OldChecks: prChecks(c.OldChecks), NewChecks: prChecks(c.NewChecks),
			OldReviewDecision: string(c.OldReviewDecision), NewReviewDecision: string(c.NewReviewDecision),
			OldCount: c.OldCount, NewCount: c.NewCount, Requested: c.Requested, ViewerRequested: c.Viewer,
			OldDraft: c.OldDraft, NewDraft: c.NewDraft, OldTitle: c.OldTitle, NewTitle: c.NewTitle,
		})
	}
	return out
}

// prWaker is the part of the thread store a pull request's changes go to.
// *thread.Manager implements it.
type prWaker interface {
	PullRequestChanged(e thread.PullRequestEvent)
}

// startWakePullRequests forwards every PullRequestChanged of the GitHub store to the
// thread store's wake subscriptions. The returned func stops it.
func startWakePullRequests(ctx context.Context, log *slog.Logger, threads prWaker, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	events := bus.Subscribe[gh.PullRequestChanged](b, 512) // one per pull request per poll, back to back
	var wg sync.WaitGroup
	wg.Go(func() {
		defer events.Close()
		var dropped uint64
		for {
			select {
			case <-ctx.Done():
				return
			case e, open := <-events.C():
				if !open {
					return
				}
				if d := events.Dropped(); d != dropped {
					dropped = d
					log.Warn("pull request events dropped; a change may not wake its subscribers", "dropped", d)
				}
				threads.PullRequestChanged(prEvent(e))
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
