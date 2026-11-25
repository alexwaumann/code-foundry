package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Closing and reopening a pull request (SetPullRequestClosed, docs/notes/pr-close-reopen.md):
// GitHub's closePullRequest and reopenPullRequest, run like the draft change
// (pr_draft.go): one mutation on the cached detail's node id, under the pull request's
// merge lock, paced on the worker and never retried, with no write memo (a repeat is
// refused as already done once the detail shows it).
//
// Refused up front, after a fresh look when the cached copy would refuse: closing what
// is not open (closed already, or merged), reopening what is not closed (open, or
// merged: GitHub never reopens a merged pull request), and the viewer lacking
// GitHub's viewerCanClose / viewerCanReopen (PERMISSION_DENIED). Everything else is
// GitHub's call, relayed with its message.

// Query names of the documents (queries/).
const (
	queryClosePullRequest  = "close_pull_request"
	queryReopenPullRequest = "reopen_pull_request"
)

// ClosedResult is what SetPullRequestClosed did.
type ClosedResult struct {
	// State is the pull request's state GitHub reports afterwards.
	State PullRequestState
	// Message says what happened, for people.
	Message string
}

// SetPullRequestClosed implements Service.
func (s *Store) SetPullRequestClosed(ctx context.Context, slug string, number int, closed bool) (ClosedResult, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return ClosedResult{}, err
	}
	unlock, err := s.full.mergeLocks.lock(ctx, k)
	if err != nil {
		return ClosedResult{}, err
	}
	defer unlock()
	refusal := func(d *FullPullRequest) string { return closedRefusal(d, closed) }
	// A cached copy without the permission (a row from before it was fetched reads
	// false) gets a fresh look too.
	look := func(d *FullPullRequest) bool { return refusal(d) != "" || !viewerMay(d, closed) }
	var id string
	if e, ok := s.full.entry(k); ok && e.d.PullRequest.ID != "" && !look(&e.d) {
		id = e.d.PullRequest.ID
	} else if !ok {
		if p, has := s.summaries.get(k); has && !p.Partial && p.ID != "" && p.State != "" && refusal(&FullPullRequest{PullRequest: p}) == "" {
			id = p.ID
		}
	}
	if id == "" {
		d, err := s.freshFor(ctx, k, look, refusal)
		if err != nil {
			return ClosedResult{}, err
		}
		if !viewerMay(&d, closed) {
			return ClosedResult{}, fmt.Errorf("%w: GitHub does not let you %s pull request #%d in %s (it takes the author, or triage access or more)",
				ErrPermissionDenied, closeVerb(closed), k.number, k.slug)
		}
		id = d.PullRequest.ID
	}
	doc, what := queryReopenPullRequest, "reopening it"
	if closed {
		doc, what = queryClosePullRequest, "closing it"
	}
	data, err := s.stateWrite(ctx, k, what, doc, map[string]any{"id": id}, writeRefused, func(ctx context.Context, data []byte) {
		det, err := decodeClosedDetail(data, closed)
		if err != nil {
			s.invalidateFull(k)
			return
		}
		s.patchFull(ctx, k, func(d *FullPullRequest) {
			d.PullRequest.State = det.State
			d.ClosedAt = det.ClosedAt
			if det.ViewerCanClose != nil {
				d.ViewerCanClose = *det.ViewerCanClose
			}
			if det.ViewerCanReopen != nil {
				d.ViewerCanReopen = *det.ViewerCanReopen
			} else if det.State == PullRequestClosed {
				d.ViewerCanReopen = d.ViewerCanClose
			} else {
				d.ViewerCanReopen = false
			}
			if det.State != PullRequestOpen {
				d.AutoMerge, d.AutoMergeMethod = false, ""
			}
		})
		s.markClosed(k, det.State, det.UpdatedAt)
	})
	if err != nil {
		return ClosedResult{}, err
	}
	res, err := decodeClosed(data, closed)
	if err != nil {
		return ClosedResult{}, fmt.Errorf("pull request #%d: GitHub accepted %s, but its answer could not be read: %w", k.number, what, err)
	}
	want := PullRequestOpen
	if closed {
		want = PullRequestClosed
	}
	switch {
	case res.State != want:
		res.Message = fmt.Sprintf("GitHub accepted %s (#%d), but reports it %s", what, k.number, strings.ToLower(string(res.State)))
	case closed:
		res.Message = fmt.Sprintf("Closed #%d", k.number)
	default:
		res.Message = fmt.Sprintf("Reopened #%d", k.number)
	}
	s.log.Info("gh pull request closed set", "pr", k.String(), "closed", closed, "state", res.State)
	// The dashboards list open pull requests: poll soon.
	s.pollSoon()
	return res, nil
}

// closedRefusal says why d cannot be closed (closed) or reopened, or "".
func closedRefusal(d *FullPullRequest, closed bool) string {
	switch st := d.PullRequest.State; {
	case st == PullRequestMerged && closed:
		return "is merged, not open"
	case st == PullRequestMerged:
		return "is merged; a merged pull request cannot be reopened"
	case closed && st != PullRequestOpen:
		return fmt.Sprintf("is %s, not open", strings.ToLower(string(st)))
	case !closed && st == PullRequestOpen:
		return "is already open"
	case !closed && st != PullRequestClosed:
		return fmt.Sprintf("is %s, not closed", strings.ToLower(string(st)))
	}
	return ""
}

// viewerMay reports GitHub's viewerCanClose (closed) or viewerCanReopen on d.
func viewerMay(d *FullPullRequest, closed bool) bool {
	if closed {
		return d.ViewerCanClose
	}
	return d.ViewerCanReopen
}

func closeVerb(closed bool) string {
	if closed {
		return "close"
	}
	return "reopen"
}

type closedDetail struct {
	State           PullRequestState
	ClosedAt        time.Time
	UpdatedAt       time.Time
	ViewerCanClose  *bool
	ViewerCanReopen *bool
}

// decodeClosed maps a ClosePullRequest or ReopenPullRequest response.
func decodeClosed(data []byte, closed bool) (ClosedResult, error) {
	det, err := decodeClosedDetail(data, closed)
	if err != nil {
		return ClosedResult{}, err
	}
	return ClosedResult{State: det.State}, nil
}

func decodeClosedDetail(data []byte, closed bool) (closedDetail, error) {
	type payload struct {
		PullRequest *struct {
			State           string    `json:"state"`
			ClosedAt        time.Time `json:"closedAt"`
			UpdatedAt       time.Time `json:"updatedAt"`
			ViewerCanClose  *bool     `json:"viewerCanClose"`
			ViewerCanReopen *bool     `json:"viewerCanReopen"`
		} `json:"pullRequest"`
	}
	var d struct {
		Close  *payload `json:"closePullRequest"`
		Reopen *payload `json:"reopenPullRequest"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return closedDetail{}, fmt.Errorf("decode close: %w", err)
	}
	p := d.Reopen
	if closed {
		p = d.Close
	}
	if p == nil || p.PullRequest == nil || p.PullRequest.State == "" {
		return closedDetail{}, errors.New("decode close: no pull request in the response")
	}
	return closedDetail{
		State:           PullRequestState(p.PullRequest.State),
		ClosedAt:        p.PullRequest.ClosedAt,
		UpdatedAt:       p.PullRequest.UpdatedAt,
		ViewerCanClose:  p.PullRequest.ViewerCanClose,
		ViewerCanReopen: p.PullRequest.ViewerCanReopen,
	}, nil
}
