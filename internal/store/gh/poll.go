package gh

import (
	"cmp"
	"context"
	"errors"
	"slices"

	"github.com/awaumann/code-foundry/internal/bus"
)

// Jobs run on the worker goroutine (Store.Run). Each request goes through call, which
// paces it and applies global effects; the functions here apply per-job effects:
// snapshot, cache, schedule, and bus events.

// isGlobal reports errors handled by a store-wide pause rather than per-repo backoff.
func isGlobal(err error) bool {
	return errors.Is(err, ErrNotAuthenticated) || errors.Is(err, ErrRateLimited) || errors.Is(err, ErrNetwork)
}

func (s *Store) pollViewer(ctx context.Context) {
	data, err := s.call(ctx, queryViewer, nil)
	var v Viewer
	if err == nil {
		v, _, err = decodeViewer(data)
	}
	if ctx.Err() != nil {
		return
	}
	now := s.opts.Now()
	if err != nil {
		s.mu.Lock()
		s.viewerFailures++
		if !isGlobal(err) {
			s.viewerNext = now.Add(backoff(s.opts.RepoInterval, s.opts.MaxBackoff, s.viewerFailures, s.opts.Rand()))
		}
		s.mu.Unlock()
		s.log.Warn("gh viewer fetch failed", "err", err)
		s.updateViewer(func(vs *ViewerState) { vs.LastError = err.Error() })
		return
	}
	s.mu.Lock()
	s.viewerFailures = 0
	s.viewerNext = now.Add(s.opts.ViewerInterval)
	s.mu.Unlock()
	if err := s.cache.saveViewer(ctx, v, now); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	s.updateViewer(func(vs *ViewerState) {
		vs.Viewer, vs.Authenticated, vs.FetchedAt, vs.LastError = &v, true, now, ""
	})
}

// checkAuth runs while gh is known to be unauthenticated. `gh auth status` validates the
// token locally and with one API call; on success, normal polling resumes and the next
// GraphQL success clears the auth state.
func (s *Store) checkAuth(ctx context.Context) {
	if err := s.pace(ctx); err != nil {
		return
	}
	st, err := s.opts.Runner.AuthStatus(ctx)
	s.lastEnd = s.opts.Now()
	if ctx.Err() != nil {
		return
	}
	now := s.opts.Now()
	s.mu.Lock()
	if err == nil && st.LoggedIn {
		// Resume polling. authFailures is kept so that a token gh accepts but GraphQL
		// rejects keeps backing off instead of looping at AuthRetry.
		s.authBad = false
		s.viewerNext = now
		for _, sc := range s.tracked {
			sc.next = now
		}
		s.mu.Unlock()
		s.log.Info("gh authenticated again; resuming", "login", st.Login)
		return
	}
	s.authFailures++
	s.authNext = now.Add(backoff(s.opts.AuthRetry, s.opts.MaxBackoff, s.authFailures, s.opts.Rand()))
	s.mu.Unlock()
	msg := ErrNotAuthenticated.Error()
	switch {
	case err != nil:
		msg = err.Error()
	case st.Error != "":
		msg += ": " + st.Error
	}
	s.updateViewer(func(vs *ViewerState) { vs.Authenticated, vs.LastError = false, msg })
}

func (s *Store) pollPullRequests(ctx context.Context, slug string) error {
	owner, name := splitSlug(slug)
	var (
		all   []PullRequest
		total int
		after string
		ci    *defaultBranchJSON
	)
	size := cmp.Or(s.pageSizes[slug], s.opts.PageSize)
	for range s.opts.MaxPages {
		vars := map[string]any{"owner": owner, "name": name, "first": size}
		if after != "" {
			vars["after"] = after
		} else {
			vars["withDefaultBranch"] = true // default-branch CI rides on page one
		}
		data, err := s.call(ctx, queryPullRequests, vars)
		if err == nil && after == "" {
			ci = decodeDefaultBranchField(data)
		}
		var page prPage
		if err == nil {
			page, _, err = decodePullRequestsPage(data)
		}
		if err != nil {
			// GitHub gives up on queries that need >10s of server time. Retry soon with
			// half the page size; the smaller size sticks for this repo.
			shrunk := errors.Is(err, ErrServerTimeout) && size > minPageSize
			if shrunk {
				s.pageSizes[slug] = max(minPageSize, size/2)
				s.log.Info("gh query timed out; shrinking page size", "slug", slug, "page_size", s.pageSizes[slug])
			}
			s.repoFailed(ctx, slug, err, shrunk)
			return err
		}
		all = append(all, page.PullRequests...)
		total = page.TotalCount
		if !page.Next.HasNextPage || page.Next.EndCursor == "" {
			break
		}
		after = page.Next.EndCursor
	}
	// A PR updated between pages moves to page one and may appear twice.
	seen := make(map[int]bool, len(all))
	all = slices.DeleteFunc(all, func(p PullRequest) bool {
		dup := seen[p.Number]
		seen[p.Number] = true
		return dup
	})
	s.repoSucceeded(ctx, slug, all, total)
	if ci != nil {
		s.defaultBranchFetched(ctx, slug, ci)
	}
	return nil
}

func (s *Store) repoSucceeded(ctx context.Context, slug string, prs []PullRequest, total int) {
	now := s.opts.Now()
	s.mu.Lock()
	if sc, ok := s.tracked[slug]; ok {
		sc.failures = 0
		sc.next = now.Add(jitter(s.opts.RepoInterval, s.opts.Rand()))
	}
	s.mu.Unlock()
	if err := s.cache.savePullRequests(ctx, slug, prs, total, now); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	r := s.updateRepo(slug, func(r *RepoState) {
		r.PullRequests, r.TotalCount, r.FetchedAt, r.LastError = prs, total, now, ""
	})
	s.publishRepo(r)
}

// repoFailed records a failed poll. retryNow schedules a tracked repo again
// immediately (subject to MinGap) without counting a failure.
func (s *Store) repoFailed(ctx context.Context, slug string, err error, retryNow bool) {
	if ctx.Err() != nil {
		return
	}
	now := s.opts.Now()
	s.mu.Lock()
	sc, ok := s.tracked[slug]
	// Global errors (auth, rate limit, network) leave next as is, already due: the
	// store-wide pause holds every repo, and the repo goes first when it lifts.
	switch {
	case !ok:
	case retryNow:
		sc.next = now
	case !isGlobal(err):
		sc.failures++
		sc.next = now.Add(backoff(s.opts.RepoInterval, s.opts.MaxBackoff, sc.failures, s.opts.Rand()))
	}
	s.mu.Unlock()
	s.log.Warn("gh pull request poll failed", "slug", slug, "err", err)
	changed := false
	r := s.updateRepo(slug, func(r *RepoState) {
		changed = r.LastError != err.Error()
		r.LastError = err.Error()
	})
	if changed {
		s.publishRepo(r)
	}
}

func (s *Store) fetchPullRequest(ctx context.Context, slug string, number int) (PullRequestDetail, error) {
	owner, name := splitSlug(slug)
	var (
		pr    PullRequest
		runs  []CheckRun
		after string
	)
	for range s.opts.MaxPages {
		vars := map[string]any{"owner": owner, "name": name, "number": number}
		if after != "" {
			vars["after"] = after
		}
		data, err := s.call(ctx, queryPullRequest, vars)
		if err != nil {
			return PullRequestDetail{}, err
		}
		p, page, _, err := decodePullRequest(data)
		if err != nil {
			return PullRequestDetail{}, err
		}
		pr = p
		runs = append(runs, page.Runs...)
		if !page.Next.HasNextPage || page.Next.EndCursor == "" {
			break
		}
		after = page.Next.EndCursor
	}
	sortRuns(runs)
	d := PullRequestDetail{PullRequest: pr, Checks: runs, FetchedAt: s.opts.Now()}
	if err := s.cache.saveDetail(ctx, slug, d); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	return d, nil
}

func (s *Store) fetchChecks(ctx context.Context, slug, ref string) (RefChecks, error) {
	owner, name := splitSlug(slug)
	var (
		out   RefChecks
		after string
	)
	for range s.opts.MaxPages {
		vars := map[string]any{"owner": owner, "name": name, "ref": ref}
		if after != "" {
			vars["after"] = after
		}
		data, err := s.call(ctx, queryChecks, vars)
		if err != nil {
			return RefChecks{}, err
		}
		page, _, err := decodeChecks(data)
		if err != nil {
			return RefChecks{}, err
		}
		out.SHA, out.Rollup = page.SHA, page.Rollup
		out.Runs = append(out.Runs, page.Runs...)
		if !page.Next.HasNextPage || page.Next.EndCursor == "" {
			break
		}
		after = page.Next.EndCursor
	}
	sortRuns(out.Runs)
	out.FetchedAt = s.opts.Now()
	if err := s.cache.saveChecks(ctx, slug, ref, out); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	return out, nil
}

// updateRepo applies fn to a copy of slug's state and publishes a new snapshot.
func (s *Store) updateRepo(slug string, fn func(*RepoState)) RepoState {
	s.snapMu.Lock()
	defer s.snapMu.Unlock()
	n := s.snap.Load().clone()
	r := n.Repos[slug]
	r.Slug = slug
	fn(&r)
	n.Repos[slug] = r
	s.snap.Store(n)
	return r
}

// updateViewer applies fn to a copy of the viewer state, publishes a new snapshot, and
// announces it when anything changed.
func (s *Store) updateViewer(fn func(*ViewerState)) {
	s.snapMu.Lock()
	n := s.snap.Load().clone()
	before := n.Viewer
	fn(&n.Viewer)
	after := n.Viewer
	s.snap.Store(n)
	s.snapMu.Unlock()
	if before == after {
		return
	}
	if s.opts.Bus != nil {
		bus.Publish(s.opts.Bus, ViewerUpdated{FetchedAt: after.FetchedAt})
	}
}

func (s *Store) setAuthenticated(ok bool, msg string) {
	s.updateViewer(func(vs *ViewerState) {
		vs.Authenticated = ok
		if msg != "" || ok {
			vs.LastError = msg
		}
	})
}

func (s *Store) publishRepo(r RepoState) {
	if s.opts.Bus != nil {
		bus.Publish(s.opts.Bus, PullRequestsUpdated{Slug: r.Slug, FetchedAt: r.FetchedAt})
	}
}
