package ghtest

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// reviewNow stamps the fake's reviews and comments.
var reviewNow = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

// SubmitPullRequestReview implements gh.Service: it records "review-submit <key>
// <EVENT> <body>", validates like the real store (gh.NormalizeReview), and needs the
// pull request set with SetFullPullRequest. Approving or requesting changes on the
// viewer's own pull request (SetViewer's login is its author) is refused like GitHub
// does, with FailedPrecondition. A success appends the review to the detail's
// comments, publishes gh.PullRequestDetailUpdated, and answers with id
// "PRR_<number>_<n>".
func (s *Store) SubmitPullRequestReview(_ context.Context, slug string, number int, r gh.ReviewSubmission) (gh.SubmittedReview, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.SubmittedReview{}, err
	}
	if r, err = gh.NormalizeReview(r); err != nil {
		return gh.SubmittedReview{}, err
	}
	s.record("review-submit %s %s %s", key, r.Event, r.Body)
	viewer := s.viewerLogin()
	s.mu.Lock()
	d, err := s.writableDetail(key)
	if err != nil {
		s.mu.Unlock()
		return gh.SubmittedReview{}, err
	}
	if r.Event != gh.ReviewEventComment && viewer != "" && strings.EqualFold(viewer, d.PullRequest.Author) {
		s.mu.Unlock()
		verb := map[gh.ReviewEvent]string{gh.ReviewEventApprove: "approve", gh.ReviewEventRequestChanges: "request changes on"}[r.Event]
		return gh.SubmittedReview{}, fmt.Errorf("%w: Can not %s your own pull request", gh.ErrFailedPrecondition, verb)
	}
	state := map[gh.ReviewEvent]string{
		gh.ReviewEventApprove: "APPROVED", gh.ReviewEventRequestChanges: "CHANGES_REQUESTED", gh.ReviewEventComment: "COMMENTED",
	}[r.Event]
	n := len(d.Comments)
	res := gh.SubmittedReview{
		ID:          fmt.Sprintf("PRR_%d_%d", number, n),
		URL:         fmt.Sprintf("https://github.com/%s/pull/%d#pullrequestreview-%d", strings.Split(key, "#")[0], number, n),
		State:       state,
		Author:      viewer,
		SubmittedAt: reviewNow,
	}
	d.Comments = append(d.Comments, gh.Comment{ID: res.ID, Kind: gh.CommentReview, Author: viewer, Body: r.Body,
		CreatedAt: reviewNow, URL: res.URL, ReviewState: state})
	s.detail.full[key] = d
	s.mu.Unlock()
	s.publishDetail(strings.Split(key, "#")[0], number)
	return res, nil
}

// AddPullRequestComment implements gh.Service: it records "comment <key> <body>",
// validates like the real store (gh.NormalizeComment), and needs the pull request set
// with SetFullPullRequest. A success appends the comment to the detail's comments,
// publishes gh.PullRequestDetailUpdated, and answers with id "IC_<number>_<n>".
func (s *Store) AddPullRequestComment(_ context.Context, slug string, number int, body string) (gh.PostedComment, error) {
	key, err := prKey(slug, number)
	if err != nil {
		return gh.PostedComment{}, err
	}
	if body, err = gh.NormalizeComment(body); err != nil {
		return gh.PostedComment{}, err
	}
	s.record("comment %s %s", key, body)
	viewer := s.viewerLogin()
	s.mu.Lock()
	d, err := s.writableDetail(key)
	if err != nil {
		s.mu.Unlock()
		return gh.PostedComment{}, err
	}
	n := len(d.Comments)
	res := gh.PostedComment{
		ID:        fmt.Sprintf("IC_%d_%d", number, n),
		URL:       fmt.Sprintf("https://github.com/%s/pull/%d#issuecomment-%d", strings.Split(key, "#")[0], number, n),
		CreatedAt: reviewNow,
	}
	d.Comments = append(d.Comments, gh.Comment{ID: res.ID, Kind: gh.CommentIssue, Author: viewer, Body: body,
		CreatedAt: reviewNow, URL: res.URL})
	s.detail.full[key] = d
	s.mu.Unlock()
	s.publishDetail(strings.Split(key, "#")[0], number)
	return res, nil
}

// writableDetail returns the pull request a review or comment goes on, or the store's
// error. Called with s.mu held.
func (s *Store) writableDetail(key string) (gh.FullPullRequest, error) {
	if s.err != nil {
		return gh.FullPullRequest{}, s.err
	}
	d, ok := s.detail.full[key]
	if !ok {
		return gh.FullPullRequest{}, fmt.Errorf("%w: %s", gh.ErrNotFound, key)
	}
	return d, nil
}

// viewerLogin is SetViewer's login, or "".
func (s *Store) viewerLogin() string {
	if v := s.snap.Load().Viewer.Viewer; v != nil {
		return v.Login
	}
	return ""
}
