package gh

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// reviewWorld is the fake GitHub for reviews and comments: on o/r, #1 open by kim, #2
// open by the viewer (octocat), #3 merged by kim.
func reviewWorld(t *testing.T) (*fakeGitHub, *fakeRunner, *Store, *bus.Subscription[PullRequestDetailUpdated]) {
	t.Helper()
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	theirs := fakePR("PR_1", "o/r", 1, t0)
	theirs.Author = "kim"
	g.addPR(theirs)
	g.addPR(fakePR("PR_2", "o/r", 2, t0))
	merged := fakePR("PR_3", "o/r", 3, t0)
	merged.Author, merged.State, merged.MergedAt = "kim", PullRequestMerged, t0
	g.addPR(merged)
	r := (&fakeRunner{}).serve(g)
	b := bus.New()
	events := bus.Subscribe[PullRequestDetailUpdated](b, 64)
	return g, r, startStore(t, testOptions(openTestDB(t), r, b)), events
}

func TestNormalizeReview(t *testing.T) {
	long := strings.Repeat("x", MaxCommentBytes)
	tests := []struct {
		name  string
		in    ReviewSubmission
		want  string // the trimmed body
		error bool
	}{
		{name: "approve without a body", in: ReviewSubmission{Event: ReviewEventApprove}},
		{name: "approve, blank body", in: ReviewSubmission{Event: ReviewEventApprove, Body: " \n\t "}},
		{name: "approve with a body, trimmed", in: ReviewSubmission{Event: ReviewEventApprove, Body: "  lgtm\n"}, want: "lgtm"},
		{name: "request changes needs a body", in: ReviewSubmission{Event: ReviewEventRequestChanges, Body: "  "}, error: true},
		{name: "request changes", in: ReviewSubmission{Event: ReviewEventRequestChanges, Body: "fix x"}, want: "fix x"},
		{name: "comment needs a body", in: ReviewSubmission{Event: ReviewEventComment}, error: true},
		{name: "comment at the limit", in: ReviewSubmission{Event: ReviewEventComment, Body: " " + long + " "}, want: long},
		{name: "comment over the limit", in: ReviewSubmission{Event: ReviewEventComment, Body: long + "y"}, error: true},
		{name: "approve over the limit", in: ReviewSubmission{Event: ReviewEventApprove, Body: long + "é"}, error: true},
		{name: "no event", in: ReviewSubmission{Body: "x"}, error: true},
		{name: "dismiss is not an event here", in: ReviewSubmission{Event: "DISMISS", Body: "x"}, error: true},
		{name: "lower case event", in: ReviewSubmission{Event: "approve"}, error: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NormalizeReview(tt.in)
			if tt.error {
				if !errors.Is(err, ErrInvalidArgument) {
					t.Errorf("err = %v, want invalid argument", err)
				}
				return
			}
			if err != nil || got.Body != tt.want || got.Event != tt.in.Event {
				t.Errorf("got %+v, %v; want body %q", got, err, tt.want)
			}
		})
	}
}

func TestNormalizeComment(t *testing.T) {
	for _, tt := range []struct {
		in, want string
		error    bool
	}{
		{in: "  hello\n", want: "hello"},
		{in: "", error: true},
		{in: "\n \t", error: true},
		{in: strings.Repeat("é", MaxCommentBytes/2), want: strings.Repeat("é", MaxCommentBytes/2)},
		{in: strings.Repeat("é", MaxCommentBytes/2) + "x", error: true}, // bytes, not runes
	} {
		got, err := NormalizeComment(tt.in)
		if tt.error != (err != nil) || got != tt.want || (err != nil && !errors.Is(err, ErrInvalidArgument)) {
			t.Errorf("NormalizeComment(%.20q) = %.20q, %v", tt.in, got, err)
		}
	}
}

func TestDecodeReview(t *testing.T) {
	got, err := decodeReview(fixtureData(t, "add_pull_request_review_synthetic.json"))
	want := SubmittedReview{ID: "PRR_kwDOVAtW7M7Bm4Qz", URL: "https://github.com/alexwaumann/code-foundry/pull/120#pullrequestreview-3245901875",
		State: "CHANGES_REQUESTED", Author: "kim", SubmittedAt: time.Date(2026, 10, 15, 9, 41, 7, 0, time.UTC)}
	if err != nil || got != want {
		t.Errorf("fixture: %+v, %v; want %+v", got, err, want)
	}
	for _, tt := range []struct {
		name, data string
		want       SubmittedReview
		err        string
	}{
		{name: "deleted author", data: `{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_1","url":"u","state":"APPROVED","submittedAt":"2026-10-15T09:00:00Z","author":null}}}`,
			want: SubmittedReview{ID: "PRR_1", URL: "u", State: "APPROVED", SubmittedAt: time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC)}},
		{name: "null payload", data: `{"addPullRequestReview":null}`, err: "no review"},
		{name: "null review", data: `{"addPullRequestReview":{"pullRequestReview":null}}`, err: "no review"},
		{name: "not JSON", data: `{`, err: "decode review"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decodeReview([]byte(tt.data))
			if tt.err != "" {
				if err == nil || !strings.Contains(err.Error(), tt.err) {
					t.Errorf("err = %v, want %q", err, tt.err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
		})
	}
}

func TestDecodeComment(t *testing.T) {
	got, err := decodeComment(fixtureData(t, "add_comment_synthetic.json"))
	want := PostedComment{ID: "IC_kwDOVAtW7M7NQ3fT", URL: "https://github.com/alexwaumann/code-foundry/pull/120#issuecomment-3406284243",
		CreatedAt: time.Date(2026, 10, 15, 9, 42, 30, 0, time.UTC)}
	if err != nil || got != want {
		t.Errorf("fixture: %+v, %v; want %+v", got, err, want)
	}
	for _, data := range []string{`{"addComment":null}`, `{"addComment":{"commentEdge":null}}`, `{"addComment":{"commentEdge":{"node":null}}}`, `[]`} {
		if _, err := decodeComment([]byte(data)); err == nil {
			t.Errorf("decodeComment(%s): want error", data)
		}
	}
}

func TestWriteRefused(t *testing.T) {
	// The captured-style refusal: GitHub's UNPROCESSABLE part next to a null payload.
	_, err := parseGraphQLResponse(httpResult{status: 200, body: fixture(t, "add_pull_request_review_own_synthetic.json")})
	var pe *PartialError
	if !errors.As(err, &pe) {
		t.Fatalf("fixture: %v, want a partial error", err)
	}
	if got := writeRefused(pe); !errors.Is(got, ErrFailedPrecondition) || got.Error() != "failed precondition: Review Can not approve your own pull request" {
		t.Errorf("fixture refusal = %v", got)
	}
	for _, tt := range []struct {
		typ  string
		want error
	}{
		{"UNPROCESSABLE", ErrFailedPrecondition},
		{"", ErrFailedPrecondition},
		{"SOMETHING_NEW", ErrFailedPrecondition},
		{"FORBIDDEN", ErrPermissionDenied},
		{"NOT_FOUND", ErrNotFound},
		{"RATE_LIMITED", ErrRateLimited},
	} {
		got := writeRefused(&PartialError{Errors: []graphQLError{{Type: tt.typ, Message: "GitHub says no"}}})
		if !errors.Is(got, tt.want) || !strings.Contains(got.Error(), "GitHub says no") {
			t.Errorf("type %q: %v, want %v", tt.typ, got, tt.want)
		}
	}
}

// The mutations declare exactly the variables the store sends.
func TestReviewQueryVariables(t *testing.T) {
	for _, tt := range []struct {
		name string
		vars map[string]any
	}{
		{queryAddPullRequestReview, map[string]any{"id": "PR_x", "event": "APPROVE", "body": nil}},
		{queryAddComment, map[string]any{"id": "PR_x", "body": "hi"}},
	} {
		q, err := query(tt.name)
		if err != nil {
			t.Fatal(err)
		}
		checkDoc(t, tt.name, q, tt.vars)
	}
}

func TestSubmitPullRequestReview(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		number int
		req    ReviewSubmission
		setup  func(g *fakeGitHub)
		// want: the result, or err (with errHas in its message).
		want   SubmittedReview
		err    error
		errHas string
		// sent: the mutation's call, when one is sent.
		sent  *fakeReviewCall
		event bool // pull_request_detail_updated sent
	}{
		{name: "approve without a body sends null", number: 1, req: ReviewSubmission{Event: ReviewEventApprove, Body: "  "},
			want: SubmittedReview{ID: "PRR_1", URL: "https://github.com/o/r/pull/1#pullrequestreview-1", State: "APPROVED", Author: "octocat", SubmittedAt: at},
			sent: &fakeReviewCall{op: "AddPullRequestReview", id: "PR_1", event: "APPROVE"}, event: true},
		{name: "request changes, body trimmed", number: 1, req: ReviewSubmission{Event: ReviewEventRequestChanges, Body: "\n please fix x \n"},
			want: SubmittedReview{ID: "PRR_1", URL: "https://github.com/o/r/pull/1#pullrequestreview-1", State: "CHANGES_REQUESTED", Author: "octocat", SubmittedAt: at},
			sent: &fakeReviewCall{op: "AddPullRequestReview", id: "PR_1", event: "REQUEST_CHANGES", body: "please fix x"}, event: true},
		{name: "a comment review on one's own pull request", number: 2, req: ReviewSubmission{Event: ReviewEventComment, Body: "note"},
			want: SubmittedReview{ID: "PRR_1", URL: "https://github.com/o/r/pull/2#pullrequestreview-1", State: "COMMENTED", Author: "octocat", SubmittedAt: at},
			sent: &fakeReviewCall{op: "AddPullRequestReview", id: "PR_2", event: "COMMENT", body: "note"}, event: true},
		{name: "a merged pull request is left to GitHub", number: 3, req: ReviewSubmission{Event: ReviewEventComment, Body: "late"},
			want: SubmittedReview{ID: "PRR_1", URL: "https://github.com/o/r/pull/3#pullrequestreview-1", State: "COMMENTED", Author: "octocat", SubmittedAt: at},
			sent: &fakeReviewCall{op: "AddPullRequestReview", id: "PR_3", event: "COMMENT", body: "late"}, event: true},
		{name: "approving one's own pull request: GitHub's refusal", number: 2, req: ReviewSubmission{Event: ReviewEventApprove},
			err: ErrFailedPrecondition, errHas: "failed precondition: Review Can not approve your own pull request",
			sent: &fakeReviewCall{op: "AddPullRequestReview", id: "PR_2", event: "APPROVE"}, event: true},
		{name: "a refusal without a type is a failed precondition", number: 1, req: ReviewSubmission{Event: ReviewEventApprove},
			setup: func(g *fakeGitHub) { g.refuseReviews("", "Pull request is locked") },
			err:   ErrFailedPrecondition, errHas: "Pull request is locked",
			sent: &fakeReviewCall{op: "AddPullRequestReview", id: "PR_1", event: "APPROVE"}, event: true},
		{name: "FORBIDDEN is permission denied", number: 1, req: ReviewSubmission{Event: ReviewEventApprove},
			setup: func(g *fakeGitHub) { g.refuseReviews("FORBIDDEN", "Resource not accessible by integration") },
			err:   ErrPermissionDenied, errHas: "Resource not accessible",
			sent: &fakeReviewCall{op: "AddPullRequestReview", id: "PR_1", event: "APPROVE"}},
		{name: "GitHub timed out: it may have been posted", number: 1, req: ReviewSubmission{Event: ReviewEventApprove},
			setup: func(g *fakeGitHub) { g.failNext("AddPullRequestReview", fmt.Errorf("%w: HTTP 502", ErrServerTimeout)) },
			err:   ErrServerTimeout, errHas: "GitHub did not confirm the review, and it may have been posted; check GitHub", event: true},
		{name: "unknown pull request: no mutation", number: 99, req: ReviewSubmission{Event: ReviewEventApprove},
			err: ErrNotFound},
		{name: "comment without a body: nothing sent", number: 1, req: ReviewSubmission{Event: ReviewEventComment, Body: " "},
			err: ErrInvalidArgument, errHas: "a body is required"},
		{name: "no event: nothing sent", number: 1, req: ReviewSubmission{Body: "x"}, err: ErrInvalidArgument},
		{name: "too long: nothing sent", number: 1, req: ReviewSubmission{Event: ReviewEventComment, Body: strings.Repeat("x", MaxCommentBytes+1)},
			err: ErrInvalidArgument, errHas: "at most 65536"},
		{name: "bad number", number: 0, req: ReviewSubmission{Event: ReviewEventApprove}, err: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, _, s, events := reviewWorld(t)
			if tt.setup != nil {
				tt.setup(g)
			}
			got, err := s.SubmitPullRequestReview(ctx, "O/R", tt.number, tt.req)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %v, want %v containing %q", err, tt.err, tt.errHas)
				}
			} else if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
			checkReviewCalls(t, g, tt.sent)
			if n := drain(events); (n > 0) != tt.event {
				t.Errorf("detail events = %d, want any: %t", n, tt.event)
			}
		})
	}
}

func TestAddPullRequestComment(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name   string
		number int
		body   string
		setup  func(g *fakeGitHub)
		want   PostedComment
		err    error
		errHas string
		sent   *fakeReviewCall
		event  bool
	}{
		{name: "posted, body trimmed", number: 1, body: "  thanks!\n",
			want: PostedComment{ID: "IC_1", URL: "https://github.com/o/r/pull/1#issuecomment-1", CreatedAt: time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)},
			sent: &fakeReviewCall{op: "AddComment", id: "PR_1", body: "thanks!"}, event: true},
		{name: "on one's own merged pull request too", number: 3, body: "shipped",
			want: PostedComment{ID: "IC_1", URL: "https://github.com/o/r/pull/3#issuecomment-1", CreatedAt: time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)},
			sent: &fakeReviewCall{op: "AddComment", id: "PR_3", body: "shipped"}, event: true},
		{name: "locked: GitHub's refusal", number: 1, body: "x",
			setup: func(g *fakeGitHub) { g.refuseReviews("UNPROCESSABLE", "Unable to create comment because issue is locked.") },
			err:   ErrFailedPrecondition, errHas: "issue is locked", sent: &fakeReviewCall{op: "AddComment", id: "PR_1", body: "x"}, event: true},
		{name: "rate limited keeps its kind", number: 1, body: "x",
			setup: func(g *fakeGitHub) { g.refuseReviews("RATE_LIMITED", "was submitted too quickly") },
			err:   ErrRateLimited, sent: &fakeReviewCall{op: "AddComment", id: "PR_1", body: "x"}},
		{name: "network error: it may have been posted", number: 1, body: "x",
			setup: func(g *fakeGitHub) { g.failNext("AddComment", fmt.Errorf("%w: connection reset", ErrNetwork)) },
			err:   ErrNetwork, errHas: "GitHub did not confirm the comment, and it may have been posted", event: true},
		{name: "empty body: nothing sent", number: 1, body: "\n", err: ErrInvalidArgument},
		{name: "too long: nothing sent", number: 1, body: strings.Repeat("x", MaxCommentBytes+1), err: ErrInvalidArgument},
		{name: "unknown pull request", number: 99, body: "x", err: ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, _, s, events := reviewWorld(t)
			if tt.setup != nil {
				tt.setup(g)
			}
			got, err := s.AddPullRequestComment(ctx, "o/r", tt.number, tt.body)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %v, want %v containing %q", err, tt.err, tt.errHas)
				}
			} else if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
			checkReviewCalls(t, g, tt.sent)
			if n := drain(events); (n > 0) != tt.event {
				t.Errorf("detail events = %d, want any: %t", n, tt.event)
			}
		})
	}
}

// A posted comment is in the next read: the cached detail was invalidated.
func TestAddPullRequestCommentRefetches(t *testing.T) {
	ctx := context.Background()
	_, r, s, _ := reviewWorld(t)
	d, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil || len(d.Comments) != 0 {
		t.Fatalf("before: %d comments, %v", len(d.Comments), err)
	}
	if _, err := s.AddPullRequestComment(ctx, "o/r", 1, "hello"); err != nil {
		t.Fatal(err)
	}
	// The mutation reused the cached node id: one detail fetch so far.
	if n := r.count("PullRequestFull"); n != 1 {
		t.Errorf("detail fetches = %d, want 1", n)
	}
	d, err = s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil || len(d.Comments) != 1 || d.Comments[0].Body != "hello" {
		t.Errorf("after: %+v, %v", d.Comments, err)
	}
	if n := r.count("PullRequestFull"); n != 2 {
		t.Errorf("detail fetches = %d, want 2", n)
	}
}

func checkReviewCalls(t *testing.T, g *fakeGitHub, want *fakeReviewCall) {
	t.Helper()
	calls := g.reviewCalls()
	switch {
	case want == nil && len(calls) > 0:
		t.Errorf("mutations = %+v, want none", calls)
	case want != nil && (len(calls) != 1 || calls[0] != *want):
		t.Errorf("mutations = %+v, want [%+v]", calls, *want)
	}
}
