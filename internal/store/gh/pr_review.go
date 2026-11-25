package gh

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Reviewing and commenting from the detail panel (SubmitPullRequestReview,
// AddPullRequestComment): one GraphQL mutation each, on the pull request's node id from
// the cached detail. Both are paced requests on the store's worker and never retried;
// the same review or comment sent again within writeMemoTTL gets the first's outcome
// instead of posting twice.
// GitHub decides who may review: the store does not check authorship or access, it
// relays GitHub's refusal (docs/notes/pr-review-submit-1-daemon.md).

// Query names of the review documents (queries/).
const (
	queryAddPullRequestReview = "add_pull_request_review"
	queryAddComment           = "add_comment"
)

// MaxCommentChars is the longest review or comment body GitHub accepts, in characters
// ("Body is too long (maximum is 65536 characters)").
const MaxCommentChars = 65536

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
	res, err := writeOnPullRequest(ctx, s, k, &s.full.reviews, "review|"+string(r.Event), r.Body, "review", queryAddPullRequestReview, vars, decodeReview,
		func(ctx context.Context, _ SubmittedReview, data []byte) {
			det, err := decodeReviewDetail(data, r.Body)
			if err != nil {
				s.invalidateFull(k)
				return
			}
			s.reviewers.invalidatePR(k)
			s.patchFull(ctx, k, func(d *FullPullRequest) {
				patchPullRequestReview(d, det)
			})
			s.markReviewDecision(k, det.ReviewDecision, det.UpdatedAt)
		})
	if err != nil {
		return SubmittedReview{}, err
	}
	s.log.Info("gh pull request review submitted", "pr", k.String(), "event", r.Event, "review", res.ID)
	// The viewer's dashboards (awaiting review, reviewed) move: poll soon.
	s.pollSoon()
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
	res, err := writeOnPullRequest(ctx, s, k, &s.full.comments, "comment", body, "comment", queryAddComment, map[string]any{"body": body}, decodeComment,
		func(ctx context.Context, _ PostedComment, data []byte) {
			det, err := decodeCommentDetail(data, body)
			if err != nil {
				s.invalidateFull(k)
				return
			}
			s.patchFull(ctx, k, func(d *FullPullRequest) {
				if !slices.ContainsFunc(d.Comments, func(c Comment) bool { return c.ID == det.Comment.ID }) {
					d.Comments = append(slices.Clone(d.Comments), det.Comment)
					d.PullRequest.Comments++
				}
				advanceUpdatedAt(&d.PullRequest.UpdatedAt, cmp.Or(det.UpdatedAt, det.Comment.CreatedAt))
			})
		})
	if err != nil {
		return PostedComment{}, err
	}
	s.log.Info("gh pull request comment added", "pr", k.String(), "comment", res.ID)
	// Its updatedAt moved: the poll refetches it for the lists soon.
	s.pollSoon()
	return res, nil
}

// writeKey identifies one write for its memo: the pull request, and op ("review|EVENT",
// "comment") with a hash of the body.
type writeKey struct {
	k   fullKey
	sig string
}

// writeOnPullRequest sends one of the review mutations for k: vars plus the pull
// request's node id as $id. what names the write in errors ("review", "comment").
//
// The same write (op and body) within writeMemoTTL returns the first's outcome: its
// result or, when GitHub did not answer, the error saying it may have been posted. The
// memo is checked and written on the serial worker, so a duplicate sent while the first
// is in flight (a double click, or a retry after the caller gave up waiting) waits for
// it and gets its answer. Refusals are not remembered: nothing was posted.
//
// Afterwards, and when GitHub refused in the pull request's state, could not find it,
// or did not answer, the detail is invalidated so clients re-read.
func writeOnPullRequest[T any](ctx context.Context, s *Store, k fullKey, memo *writeMemos[writeKey, T], op, body, what, doc string,
	vars map[string]any, decode func([]byte) (T, error), onSuccess func(context.Context, T, []byte)) (T, error) {
	var zero T
	sum := sha256.Sum256([]byte(body))
	wk := writeKey{k: k, sig: op + "|" + hex.EncodeToString(sum[:8])}
	if m, ok := memo.recent(wk, s.opts.Now()); ok {
		return m.res, m.err
	}
	id, err := s.nodeID(ctx, k)
	if err != nil {
		return zero, err
	}
	vars["id"] = id
	// The job id carries the hash, never the body. Patching/invalidation runs on the
	// worker too: a caller that stopped waiting still leaves clients updated.
	return submitFunc(ctx, s, op+"|"+k.String()+"|"+wk.sig, func(ctx context.Context) (T, error) {
		if m, ok := memo.recent(wk, s.opts.Now()); ok {
			return m.res, m.err
		}
		data, err := s.call(ctx, doc, vars)
		var pe *PartialError
		switch {
		case errors.As(err, &pe):
			// GitHub refused the write: nothing was posted, but the pull request may not
			// be what the client showed (closed, locked, or gone since).
			if err = writeRefused(pe); errors.Is(err, ErrFailedPrecondition) || errors.Is(err, ErrNotFound) {
				s.invalidateFull(k)
			}
			return zero, err
		case outcomeUnknown(err):
			now := s.opts.Now()
			err = fmt.Errorf("pull request #%d: GitHub did not confirm the %s, and it may have been posted; "+
				"check GitHub before trying again (until %s the same %s returns this error): %w",
				k.number, what, now.Add(writeMemoTTL).Local().Format(time.TimeOnly), what, err)
			memo.remember(wk, writeMemo[T]{err: err, at: now})
			s.invalidateFull(k)
			return zero, err
		case err != nil:
			return zero, err
		}
		res, err := decode(data)
		if err != nil {
			// Posted, but unreadable: invalidate so clients re-read, and still never post again.
			s.invalidateFull(k)
			err = fmt.Errorf("pull request #%d: GitHub posted the %s but its answer could not be read: %w", k.number, what, err)
		} else if onSuccess != nil {
			onSuccess(ctx, res, data)
		} else {
			s.invalidateFull(k)
		}
		memo.remember(wk, writeMemo[T]{res: res, err: err, at: s.opts.Now()})
		return res, err
	})
}

// nodeID returns k's GraphQL node id from in-memory detail cache, summary cache, or
// SQLite detail cache (whatever its age: the id never changes), or fetches the detail
// when nothing is cached; that fetch must succeed.
func (s *Store) nodeID(ctx context.Context, k fullKey) (string, error) {
	if e, ok := s.full.entry(k); ok && e.d.PullRequest.ID != "" {
		return e.d.PullRequest.ID, nil
	}
	if p, ok := s.summaries.get(k); ok && p.ID != "" {
		return p.ID, nil
	}
	if e, ok := s.cachedFull(ctx, k); ok && e.d.PullRequest.ID != "" {
		return e.d.PullRequest.ID, nil
	}
	d, err := s.fetchFullJob(ctx, k)
	if err != nil {
		return "", err
	}
	if d.PullRequest.ID == "" {
		return "", fmt.Errorf("pull request #%d: no node id", k.number)
	}
	return d.PullRequest.ID, nil
}

// NormalizeReview validates a review's event and trims its body: required for
// REQUEST_CHANGES and COMMENT, optional for APPROVE, at most MaxCommentChars.
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
// MaxCommentChars. Errors wrap ErrInvalidArgument.
func NormalizeComment(body string) (string, error) { return commentBody(body, true) }

// commentBody trims body and checks it against GitHub's limits.
func commentBody(body string, required bool) (string, error) {
	body = strings.TrimSpace(body)
	switch {
	case required && body == "":
		return "", fmt.Errorf("%w: a body is required", ErrInvalidArgument)
	case utf8.RuneCountInString(body) > MaxCommentChars:
		return "", fmt.Errorf("%w: the body is %d characters, GitHub accepts at most %d", ErrInvalidArgument,
			utf8.RuneCountInString(body), MaxCommentChars)
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

// loggedVars is vars for the debug log: a review's or comment's body (the user's text,
// up to 64 KB) becomes its size.
func loggedVars(vars map[string]any) map[string]any {
	body, ok := vars["body"].(string)
	if !ok {
		return vars
	}
	out := maps.Clone(vars)
	out["body"] = fmt.Sprintf("<%d bytes>", len(body))
	return out
}

type reviewDetail struct {
	Submitted      SubmittedReview
	Body           string
	AuthorBot      bool
	AuthorAvatar   string
	CommitSHA      string
	ReviewDecision ReviewDecision
	UpdatedAt      time.Time
}

// decodeReview maps an AddPullRequestReview mutation response.
func decodeReview(data []byte) (SubmittedReview, error) {
	det, err := decodeReviewDetail(data, "")
	if err != nil {
		return SubmittedReview{}, err
	}
	return det.Submitted, nil
}

func decodeReviewDetail(data []byte, fallbackBody string) (reviewDetail, error) {
	var d struct {
		AddPullRequestReview *struct {
			PullRequestReview *struct {
				ID          string     `json:"id"`
				URL         string     `json:"url"`
				State       string     `json:"state"`
				Body        string     `json:"body"`
				SubmittedAt time.Time  `json:"submittedAt"`
				Author      *actorJSON `json:"author"`
				Commit      *oidJSON   `json:"commit"`
				PullRequest *struct {
					ReviewDecision ReviewDecision `json:"reviewDecision"`
					UpdatedAt      time.Time      `json:"updatedAt"`
				} `json:"pullRequest"`
			} `json:"pullRequestReview"`
		} `json:"addPullRequestReview"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return reviewDetail{}, fmt.Errorf("decode review: %w", err)
	}
	if d.AddPullRequestReview == nil || d.AddPullRequestReview.PullRequestReview == nil || d.AddPullRequestReview.PullRequestReview.ID == "" {
		return reviewDetail{}, errors.New("decode review: no review in the response")
	}
	r := d.AddPullRequestReview.PullRequestReview
	out := reviewDetail{
		Submitted: SubmittedReview{ID: r.ID, URL: r.URL, State: r.State, SubmittedAt: r.SubmittedAt},
		Body:      cmp.Or(r.Body, fallbackBody),
	}
	if r.Author != nil {
		out.Submitted.Author = r.Author.Login
		out.AuthorBot = r.Author.Typename == "Bot"
		out.AuthorAvatar = r.Author.AvatarURL
	}
	if r.Commit != nil {
		out.CommitSHA = r.Commit.Oid
	}
	if r.PullRequest != nil {
		out.ReviewDecision = r.PullRequest.ReviewDecision
		out.UpdatedAt = r.PullRequest.UpdatedAt
	}
	return out, nil
}

// patchPullRequestReview applies a submitted review onto a FullPullRequest copy.
func patchPullRequestReview(d *FullPullRequest, det reviewDetail) {
	sub := det.Submitted
	if !(sub.State == "PENDING" || (sub.State == "COMMENTED" && strings.TrimSpace(det.Body) == "")) {
		c := Comment{
			ID:           sub.ID,
			Kind:         CommentReview,
			Author:       sub.Author,
			AuthorBot:    det.AuthorBot,
			AuthorAvatar: det.AuthorAvatar,
			Body:         det.Body,
			CreatedAt:    sub.SubmittedAt,
			URL:          sub.URL,
			ReviewState:  sub.State,
		}
		if !slices.ContainsFunc(d.Comments, func(x Comment) bool { return x.ID == c.ID }) {
			d.Comments = append(slices.Clone(d.Comments), c)
		}
	}
	if sub.Author != "" && sub.State != "PENDING" {
		commitSHA := cmp.Or(det.CommitSHA, d.PullRequest.HeadSHA)
		stale := d.PullRequest.HeadSHA != "" && commitSHA != "" && commitSHA != d.PullRequest.HeadSHA
		revs := slices.Clone(d.Reviewers)
		if idx := slices.IndexFunc(revs, func(r Reviewer) bool { return !r.Team && strings.EqualFold(r.Login, sub.Author) }); idx >= 0 {
			revs[idx].State = sub.State
			revs[idx].SubmittedAt = sub.SubmittedAt
			revs[idx].Requested = false
			revs[idx].Stale = stale
			if det.AuthorAvatar != "" {
				revs[idx].AvatarURL = det.AuthorAvatar
			}
		} else {
			revs = append(revs, Reviewer{
				Login:       sub.Author,
				Bot:         det.AuthorBot,
				AvatarURL:   det.AuthorAvatar,
				State:       sub.State,
				SubmittedAt: sub.SubmittedAt,
				Stale:       stale,
			})
		}
		sortReviewers(revs)
		d.Reviewers = revs

		latest := slices.Clone(d.PullRequest.LatestReviews)
		rev := Review{Author: sub.Author, State: sub.State, SubmittedAt: sub.SubmittedAt, CommitSHA: commitSHA}
		if idx := slices.IndexFunc(latest, func(r Review) bool { return strings.EqualFold(r.Author, sub.Author) }); idx >= 0 {
			latest[idx] = rev
		} else {
			latest = append(latest, rev)
		}
		d.PullRequest.LatestReviews = latest
		if len(d.PullRequest.ReviewRequests) > 0 {
			d.PullRequest.ReviewRequests = slices.DeleteFunc(slices.Clone(d.PullRequest.ReviewRequests), func(login string) bool {
				return !strings.Contains(login, "/") && strings.EqualFold(login, sub.Author)
			})
		}
	}
	d.PullRequest.Reviews++
	if det.ReviewDecision != "" {
		d.PullRequest.ReviewDecision = det.ReviewDecision
	}
	advanceUpdatedAt(&d.PullRequest.UpdatedAt, cmp.Or(det.UpdatedAt, sub.SubmittedAt))
}

type commentDetail struct {
	Posted    PostedComment
	Comment   Comment
	UpdatedAt time.Time
}

// decodeComment maps an AddComment mutation response.
func decodeComment(data []byte) (PostedComment, error) {
	det, err := decodeCommentDetail(data, "")
	if err != nil {
		return PostedComment{}, err
	}
	return det.Posted, nil
}

func decodeCommentDetail(data []byte, fallbackBody string) (commentDetail, error) {
	var d struct {
		AddComment *struct {
			CommentEdge *struct {
				Node *struct {
					ID        string     `json:"id"`
					Author    *actorJSON `json:"author"`
					Body      string     `json:"body"`
					URL       string     `json:"url"`
					CreatedAt time.Time  `json:"createdAt"`
					UpdatedAt time.Time  `json:"updatedAt"`
				} `json:"node"`
			} `json:"commentEdge"`
		} `json:"addComment"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return commentDetail{}, fmt.Errorf("decode comment: %w", err)
	}
	if d.AddComment == nil || d.AddComment.CommentEdge == nil || d.AddComment.CommentEdge.Node == nil || d.AddComment.CommentEdge.Node.ID == "" {
		return commentDetail{}, errors.New("decode comment: no comment in the response")
	}
	n := d.AddComment.CommentEdge.Node
	c := Comment{
		ID:        n.ID,
		Kind:      CommentIssue,
		Body:      cmp.Or(n.Body, fallbackBody),
		CreatedAt: n.CreatedAt,
		URL:       n.URL,
	}
	if n.Author != nil {
		c.Author, c.AuthorBot, c.AuthorAvatar = n.Author.Login, n.Author.Typename == "Bot", n.Author.AvatarURL
	}
	return commentDetail{
		Posted:    PostedComment{ID: n.ID, URL: n.URL, CreatedAt: n.CreatedAt},
		Comment:   c,
		UpdatedAt: n.UpdatedAt,
	}, nil
}
