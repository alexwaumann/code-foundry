package gh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Reviewing and commenting from the detail panel (SubmitPullRequestReview,
// AddPullRequestComment): one GraphQL mutation each, on the pull request's node id from
// the cached detail. Both are paced requests on the store's worker and never retried.
// GitHub decides who may review: the store does not check authorship or access, it
// relays GitHub's refusal (docs/notes/pr-review-submit-1-daemon.md).

// Query names of the review documents (queries/).
const (
	queryAddPullRequestReview = "add_pull_request_review"
	queryAddComment           = "add_comment"
)

// MaxCommentBytes is the longest review or comment body GitHub accepts.
const MaxCommentBytes = 65536

// ReviewEvent is GitHub's PullRequestReviewEvent (DISMISS aside).
type ReviewEvent string

// Review events.
const (
	ReviewEventApprove        ReviewEvent = "APPROVE"
	ReviewEventRequestChanges ReviewEvent = "REQUEST_CHANGES"
	ReviewEventComment        ReviewEvent = "COMMENT"
)

// ReviewSubmission is the review SubmitPullRequestReview sends.
type ReviewSubmission struct {
	Event ReviewEvent
	// Body is Markdown, trimmed by the store. Required for REQUEST_CHANGES and COMMENT.
	Body string
}

// SubmittedReview is the review GitHub created.
type SubmittedReview struct {
	// ID is GitHub's node id.
	ID  string
	URL string
	// State is GitHub's PullRequestReviewState: APPROVED, CHANGES_REQUESTED, COMMENTED.
	State string
	// Author is the viewer's login.
	Author      string
	SubmittedAt time.Time
}

// PostedComment is the comment GitHub created.
type PostedComment struct {
	// ID is GitHub's node id.
	ID        string
	URL       string
	CreatedAt time.Time
}

// SubmitPullRequestReview implements Service. GitHub's refusals (approving one's own
// pull request, a closed or locked one) are ErrFailedPrecondition with its message.
func (s *Store) SubmitPullRequestReview(ctx context.Context, slug string, number int, r ReviewSubmission) (SubmittedReview, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return SubmittedReview{}, err
	}
	if r, err = NormalizeReview(r); err != nil {
		return SubmittedReview{}, err
	}
	vars := map[string]any{"event": string(r.Event), "body": nil}
	if r.Body != "" {
		vars["body"] = r.Body
	}
	res, err := writeOnPullRequest(ctx, s, k, "review|"+string(r.Event), r.Body, "review", queryAddPullRequestReview, vars, decodeReview)
	if err != nil {
		return SubmittedReview{}, err
	}
	s.log.Info("gh pull request review submitted", "pr", k.String(), "event", r.Event, "review", res.ID)
	// The viewer's dashboards (awaiting review, reviewed) move: poll soon.
	s.mu.Lock()
	s.pollSoonLocked(s.opts.Now())
	s.mu.Unlock()
	s.nudge()
	return res, nil
}

// AddPullRequestComment implements Service. Errors as for SubmitPullRequestReview.
func (s *Store) AddPullRequestComment(ctx context.Context, slug string, number int, body string) (PostedComment, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return PostedComment{}, err
	}
	if body, err = NormalizeComment(body); err != nil {
		return PostedComment{}, err
	}
	res, err := writeOnPullRequest(ctx, s, k, "comment", body, "comment", queryAddComment, map[string]any{"body": body}, decodeComment)
	if err != nil {
		return PostedComment{}, err
	}
	s.log.Info("gh pull request comment added", "pr", k.String(), "comment", res.ID)
	return res, nil
}

// writeOnPullRequest sends one of the review mutations for k: vars plus the pull
// request's node id (from the detail, cached or fetched) as $id. Identical writes that
// are queued at once (a double click) coalesce into one mutation; the job id carries a
// hash of the body, never the body. what names the write in errors ("review",
// "comment"). Afterwards, and when GitHub refused (in the pull request's state) or did
// not answer, the detail is invalidated so clients re-read.
func writeOnPullRequest[T any](ctx context.Context, s *Store, k fullKey, op, body, what, doc string, vars map[string]any,
	decode func([]byte) (T, error)) (T, error) {
	var zero T
	d, err := s.FullPullRequest(ctx, k.slug, k.number, false)
	if err != nil {
		return zero, err
	}
	if d.PullRequest.ID == "" {
		return zero, fmt.Errorf("pull request #%d: no node id", k.number)
	}
	vars["id"] = d.PullRequest.ID
	sum := sha256.Sum256([]byte(body))
	id := op + "|" + k.String() + "|" + hex.EncodeToString(sum[:8])
	// The detail is invalidated on the worker: a caller that stopped waiting still
	// leaves clients re-reading once GitHub answered.
	return submitFunc(ctx, s, id, func(ctx context.Context) (T, error) {
		data, err := s.call(ctx, doc, vars)
		var pe *PartialError
		switch {
		case errors.As(err, &pe):
			// GitHub refused the write: nothing was posted, but the pull request may not
			// be what the client showed (closed, locked since).
			if err = writeRefused(pe); errors.Is(err, ErrFailedPrecondition) {
				s.invalidateFull(k)
			}
			return zero, err
		case outcomeUnknown(err):
			s.invalidateFull(k)
			return zero, fmt.Errorf("pull request #%d: GitHub did not confirm the %s, and it may have been posted; "+
				"check GitHub before trying again: %w", k.number, what, err)
		case err != nil:
			return zero, err
		}
		s.invalidateFull(k)
		return decode(data)
	})
}

// NormalizeReview validates a review's event and trims its body: required for
// REQUEST_CHANGES and COMMENT, optional for APPROVE, at most MaxCommentBytes.
// Errors wrap ErrInvalidArgument.
func NormalizeReview(r ReviewSubmission) (ReviewSubmission, error) {
	var err error
	switch r.Event {
	case ReviewEventApprove:
		r.Body, err = commentBody(r.Body, false)
	case ReviewEventRequestChanges, ReviewEventComment:
		r.Body, err = commentBody(r.Body, true)
	default:
		err = fmt.Errorf("%w: review event %q (want APPROVE, REQUEST_CHANGES, or COMMENT)", ErrInvalidArgument, r.Event)
	}
	return r, err
}

// NormalizeComment trims a comment's body, which is required and at most
// MaxCommentBytes. Errors wrap ErrInvalidArgument.
func NormalizeComment(body string) (string, error) { return commentBody(body, true) }

// commentBody trims body and checks it against GitHub's limits.
func commentBody(body string, required bool) (string, error) {
	body = strings.TrimSpace(body)
	switch {
	case required && body == "":
		return "", fmt.Errorf("%w: a body is required", ErrInvalidArgument)
	case len(body) > MaxCommentBytes:
		return "", fmt.Errorf("%w: the body is %d bytes, GitHub accepts at most %d", ErrInvalidArgument, len(body), MaxCommentBytes)
	}
	return body, nil
}

// writeRefused maps GitHub's refusal of a mutation. Rate limits, permissions and a
// missing object keep their kinds; anything else (UNPROCESSABLE, or a part with no or
// an unknown type) is a failed precondition with GitHub's message.
func writeRefused(pe *PartialError) error {
	cls := pe.Unwrap()
	if errors.Is(cls, ErrRateLimited) || errors.Is(cls, ErrPermissionDenied) || errors.Is(cls, ErrNotFound) {
		return cls
	}
	msgs := make([]string, 0, len(pe.Errors))
	for _, e := range pe.Errors {
		msgs = append(msgs, e.Message)
	}
	return fmt.Errorf("%w: %s", ErrFailedPrecondition, strings.Join(msgs, "; "))
}

// decodeReview maps an AddPullRequestReview mutation response.
func decodeReview(data []byte) (SubmittedReview, error) {
	var d struct {
		AddPullRequestReview *struct {
			PullRequestReview *struct {
				ID          string    `json:"id"`
				URL         string    `json:"url"`
				State       string    `json:"state"`
				SubmittedAt time.Time `json:"submittedAt"`
				Author      *struct {
					Login string `json:"login"`
				} `json:"author"`
			} `json:"pullRequestReview"`
		} `json:"addPullRequestReview"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return SubmittedReview{}, fmt.Errorf("decode review: %w", err)
	}
	if d.AddPullRequestReview == nil || d.AddPullRequestReview.PullRequestReview == nil || d.AddPullRequestReview.PullRequestReview.ID == "" {
		return SubmittedReview{}, errors.New("decode review: no review in the response")
	}
	r := d.AddPullRequestReview.PullRequestReview
	out := SubmittedReview{ID: r.ID, URL: r.URL, State: r.State, SubmittedAt: r.SubmittedAt}
	if r.Author != nil {
		out.Author = r.Author.Login
	}
	return out, nil
}

// decodeComment maps an AddComment mutation response.
func decodeComment(data []byte) (PostedComment, error) {
	var d struct {
		AddComment *struct {
			CommentEdge *struct {
				Node *struct {
					ID        string    `json:"id"`
					URL       string    `json:"url"`
					CreatedAt time.Time `json:"createdAt"`
				} `json:"node"`
			} `json:"commentEdge"`
		} `json:"addComment"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return PostedComment{}, fmt.Errorf("decode comment: %w", err)
	}
	if d.AddComment == nil || d.AddComment.CommentEdge == nil || d.AddComment.CommentEdge.Node == nil || d.AddComment.CommentEdge.Node.ID == "" {
		return PostedComment{}, errors.New("decode comment: no comment in the response")
	}
	n := d.AddComment.CommentEdge.Node
	return PostedComment{ID: n.ID, URL: n.URL, CreatedAt: n.CreatedAt}, nil
}
