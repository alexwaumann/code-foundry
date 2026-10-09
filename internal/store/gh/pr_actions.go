package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// The detail panel's actions: the reviewer picker and revert. Each is one request on
// the store's worker, so pacing, the rate-limit pauses, and the auth state apply as to
// every other request. Mutations are never retried.

// Query names of the detail panel's documents (queries/).
const (
	queryPullRequestFull    = "pull_request_full"
	queryReviewerCandidates = "reviewer_candidates"
	queryRevertPullRequest  = "revert_pull_request"
)

// restRequestedReviewers is the REST path that requests (POST) and withdraws (DELETE)
// reviews: owner, name, number.
const restRequestedReviewers = "repos/%s/%s/pulls/%d/requested_reviewers"

var (
	// GitHub logins: alphanumerics and single hyphens, up to 39; apps end in "[bot]".
	reviewerLoginRE = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$`)
	teamSlugRE      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
)

// ReviewerCandidates implements Service.
func (s *Store) ReviewerCandidates(ctx context.Context, slug string, number int) (ReviewerCandidates, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return ReviewerCandidates{}, err
	}
	owner, name := splitSlug(k.slug)
	return submitFunc(ctx, s, "candidates|"+k.String(), func(ctx context.Context) (ReviewerCandidates, error) {
		data, err := s.call(ctx, queryReviewerCandidates, map[string]any{"owner": owner, "name": name, "number": k.number})
		if err != nil && !isPartial(err) {
			return ReviewerCandidates{}, err
		}
		return decodeReviewerCandidates(data)
	})
}

// SetReviewRequest implements Service. It returns the pending requests afterwards
// (logins and "org/team").
func (s *Store) SetReviewRequest(ctx context.Context, slug string, number int, r ReviewRequest) ([]string, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return nil, err
	}
	rw, ok := s.opts.Runner.(RESTWriter)
	if !ok {
		return nil, errors.New("gh: the runner cannot send REST writes")
	}
	owner, name := splitSlug(k.slug)
	login := strings.TrimSpace(r.Login)
	body := map[string][]string{"reviewers": {}, "team_reviewers": {}}
	kind := r.Kind
	switch kind {
	case ReviewerTeam:
		if _, team, ok := strings.Cut(login, "/"); ok {
			login = team
		}
		if !teamSlugRE.MatchString(login) {
			return nil, fmt.Errorf("%w: team %q", ErrInvalidArgument, r.Login)
		}
		body["team_reviewers"] = []string{login}
	case ReviewerUser, "":
		kind = ReviewerUser
		if !reviewerLoginRE.MatchString(login) {
			return nil, fmt.Errorf("%w: login %q", ErrInvalidArgument, r.Login)
		}
		body["reviewers"] = []string{login}
	default:
		return nil, fmt.Errorf("%w: reviewer kind %q", ErrInvalidArgument, r.Kind)
	}
	method := http.MethodPost
	if !r.Requested {
		method = http.MethodDelete
	}
	path := fmt.Sprintf(restRequestedReviewers, owner, name, k.number)
	id := fmt.Sprintf("review|%s|%s|%s|%t", k, kind, strings.ToLower(login), r.Requested)
	requested, err := submitFunc(ctx, s, id, func(ctx context.Context) ([]string, error) {
		res, err := s.restWrite(ctx, rw, method, path, body)
		if err != nil {
			return nil, err
		}
		return decodeRequestedReviewers(res, owner)
	})
	if err != nil {
		return nil, err
	}
	s.log.Info("gh review request set", "pr", k.String(), "kind", kind, "login", login, "requested", r.Requested)
	s.invalidateFull(k)
	return requested, nil
}

// RevertPullRequest implements Service. The pull request must be merged; its node id
// comes from the detail (cached, or fetched). A second call within revertMemoTTL
// returns the first's result instead of opening another revert.
func (s *Store) RevertPullRequest(ctx context.Context, slug string, number int) (RevertResult, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return RevertResult{}, err
	}
	if r, ok := s.full.recentRevert(k, s.opts.Now()); ok {
		return r, nil
	}
	d, err := s.FullPullRequest(ctx, k.slug, k.number, false)
	if err == nil && d.PullRequest.State != PullRequestMerged {
		// Merged is final, so only a pull request not yet merged is worth a fresh look.
		d, err = s.FullPullRequest(ctx, k.slug, k.number, true)
	}
	switch {
	case err != nil:
		return RevertResult{}, err
	case d.PullRequest.State != PullRequestMerged && d.LastError != "":
		return RevertResult{}, fmt.Errorf("pull request #%d: cannot confirm it is merged: %s", k.number, d.LastError)
	case d.PullRequest.State != PullRequestMerged:
		return RevertResult{}, fmt.Errorf("%w: pull request #%d is %s, not merged", ErrFailedPrecondition, k.number,
			strings.ToLower(string(d.PullRequest.State)))
	case d.PullRequest.ID == "":
		return RevertResult{}, fmt.Errorf("pull request #%d: no node id", k.number)
	}
	nodeID := d.PullRequest.ID
	res, err := submitFunc(ctx, s, "revert|"+k.String(), func(ctx context.Context) (RevertResult, error) {
		// The worker is serial, so a concurrent second revert sees the first's memo.
		if r, ok := s.full.recentRevert(k, s.opts.Now()); ok {
			return r, nil
		}
		data, err := s.call(ctx, queryRevertPullRequest, map[string]any{"id": nodeID})
		if err != nil {
			return RevertResult{}, err
		}
		r, err := decodeRevert(data)
		if err != nil {
			return RevertResult{}, err
		}
		s.full.rememberRevert(k, r, s.opts.Now())
		return r, nil
	})
	if err != nil {
		return RevertResult{}, err
	}
	s.log.Info("gh pull request reverted", "pr", k.String(), "revert", res.Number)
	s.invalidateFull(k)
	// The revert is the viewer's new pull request: let the dashboard see it soon.
	s.mu.Lock()
	s.pollSoonLocked(s.opts.Now())
	s.mu.Unlock()
	s.nudge()
	return res, nil
}

// restWrite sends one paced REST write and applies its global effects (auth state,
// rate-limit and network pauses), like callDoc does for GraphQL.
func (s *Store) restWrite(ctx context.Context, rw RESTWriter, method, path string, body any) (json.RawMessage, error) {
	if err := s.pace(ctx); err != nil {
		return nil, err
	}
	start := s.opts.Now()
	res, err := rw.RESTWrite(ctx, method, path, body)
	s.lastEnd = s.opts.Now()
	s.log.Debug("gh request", "rest", method+" "+path, "dur", s.lastEnd.Sub(start).Round(time.Millisecond).String(), "err", err)
	s.noteResult(ctx, err, nil)
	return res, err
}
