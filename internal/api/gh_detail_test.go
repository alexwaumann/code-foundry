package api

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

func detailFixture(at time.Time) gh.FullPullRequest {
	return gh.FullPullRequest{
		PullRequest: gh.PullRequest{
			ID: "PR_7", Number: 7, Title: "fix the thing", Author: "octocat", Repo: "o/r", State: gh.PullRequestOpen,
			HeadSHA: "abc", Checks: gh.CheckRollup{State: gh.RollupFailure, Total: 3, Passed: 2, Failed: 1},
		},
		Body:   "## Summary\nIt fixes the thing.",
		Labels: []gh.Label{{Name: "bug", Color: "d73a4a"}},
		Reviewers: []gh.Reviewer{
			{Login: "acme/core", Team: true, Requested: true},
			{Login: "kim", State: "CHANGES_REQUESTED", SubmittedAt: at, Stale: true, AvatarURL: "https://a/kim"},
			{Login: "dependabot", Bot: true, State: "COMMENTED", SubmittedAt: at},
		},
		Commits:     []gh.Commit{{SHA: "abc", Headline: "fix", AuthorLogin: "octocat", AuthorName: "Octo", CommittedAt: at}},
		CommitCount: 120,
		Comments: []gh.Comment{
			{ID: "IC_1", Kind: gh.CommentIssue, Author: "kim", Body: "why?", CreatedAt: at, URL: "https://c/1"},
			{ID: "PRR_1", Kind: gh.CommentReview, Author: "kim", ReviewState: "CHANGES_REQUESTED", CreatedAt: at},
		},
		CommentsTruncated: true,
		Threads: []gh.ReviewThread{{
			ID: "PRRT_1", Path: "main.go", Line: 12, Side: "LEFT", Outdated: true, CommentsTruncated: true,
			Comments: []gh.Comment{{ID: "PRRC_1", Kind: gh.CommentReviewComment, Author: "github-actions", AuthorBot: true, Path: "main.go", Body: "lint"}},
		}},
		ThreadsTruncated: true,
		Checks:           []gh.CheckRun{{Name: "test", Status: gh.StatusCompleted, Conclusion: gh.ConclusionFailure}},
		ViewerPermission: "WRITE",
		FetchedAt:        at,
		LastError:        "stale",
	}
}

func TestGhGetPullRequestDetail(t *testing.T) {
	store, client, _ := newGhTest(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC)
	store.SetFullPullRequest("o/r", detailFixture(at))
	merged := gh.FullPullRequest{
		PullRequest:    gh.PullRequest{ID: "PR_8", Number: 8, Repo: "o/r", State: gh.PullRequestMerged, MergedAt: at},
		MergeCommitSHA: "def", MergedBy: "kim", ClosedAt: at, ViewerPermission: "READ", FetchedAt: at,
	}
	store.SetFullPullRequest("o/r", merged)

	tests := []struct {
		name    string
		req     *v1.GetPullRequestDetailRequest
		code    connect.Code // 0: success
		check   func(t *testing.T, d *v1.PullRequestDetail)
		recalls []string
	}{
		{
			name: "every field of an open pull request",
			req:  &v1.GetPullRequestDetailRequest{RepoSlug: "O/R", Number: 7},
			check: func(t *testing.T, d *v1.PullRequestDetail) {
				pr := d.GetPullRequest()
				if pr.GetNumber() != 7 || pr.GetRepoSlug() != "o/r" || pr.GetChecks().GetFailed() != 1 ||
					pr.GetState() != v1.PullRequestState_PULL_REQUEST_STATE_OPEN {
					t.Errorf("summary = %v", pr)
				}
				if d.GetBody() != "## Summary\nIt fixes the thing." || d.GetNodeId() != "PR_7" || !d.GetViewerCanUpdate() ||
					d.GetViewerPermission() != "write" || !d.GetFetchedAt().AsTime().Equal(at) || d.GetLastError() != "stale" ||
					d.GetCommitCount() != 120 || !d.GetCommentsTruncated() || !d.GetReviewThreadsTruncated() {
					t.Errorf("detail = %v", d)
				}
				if l := d.GetLabels(); len(l) != 1 || l[0].GetName() != "bug" || l[0].GetColor() != "d73a4a" {
					t.Errorf("labels = %v", l)
				}
				r := d.GetReviewers()
				if len(r) != 3 || !r[0].GetIsTeam() || !r[0].GetRequested() || r[0].GetState() != v1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_UNSPECIFIED ||
					r[1].GetState() != v1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_CHANGES_REQUESTED || !r[1].GetStale() ||
					r[1].GetAvatarUrl() != "https://a/kim" || !r[1].GetSubmittedAt().AsTime().Equal(at) || !r[2].GetIsBot() {
					t.Errorf("reviewers = %v", r)
				}
				if c := d.GetCommits(); len(c) != 1 || c[0].GetSha() != "abc" || c[0].GetAuthorLogin() != "octocat" || c[0].GetAuthorName() != "Octo" {
					t.Errorf("commits = %v", c)
				}
				c := d.GetComments()
				if len(c) != 2 || c[0].GetKind() != v1.PullRequestCommentKind_PULL_REQUEST_COMMENT_KIND_ISSUE_COMMENT ||
					c[0].GetUrl() != "https://c/1" || c[1].GetKind() != v1.PullRequestCommentKind_PULL_REQUEST_COMMENT_KIND_REVIEW ||
					c[1].GetReviewState() != v1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_CHANGES_REQUESTED {
					t.Errorf("comments = %v", c)
				}
				th := d.GetReviewThreads()
				if len(th) != 1 || th[0].GetSide() != v1.DiffSide_DIFF_SIDE_LEFT || th[0].GetLine() != 12 || !th[0].GetIsOutdated() ||
					th[0].GetIsResolved() || !th[0].GetCommentsTruncated() || len(th[0].GetComments()) != 1 ||
					th[0].GetComments()[0].GetKind() != v1.PullRequestCommentKind_PULL_REQUEST_COMMENT_KIND_REVIEW_COMMENT ||
					!th[0].GetComments()[0].GetAuthorIsBot() || th[0].GetComments()[0].GetPath() != "main.go" {
					t.Errorf("threads = %v", th)
				}
				if ch := d.GetChecks(); len(ch) != 1 || ch[0].GetConclusion() != v1.CheckConclusion_CHECK_CONCLUSION_FAILURE {
					t.Errorf("checks = %v", ch)
				}
			},
		},
		{
			name: "merged, read-only viewer, refresh",
			req:  &v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 8, Refresh: true},
			check: func(t *testing.T, d *v1.PullRequestDetail) {
				if d.GetMergeCommitSha() != "def" || d.GetMergedBy() != "kim" || !d.GetClosedAt().AsTime().Equal(at) ||
					d.GetViewerCanUpdate() || d.GetViewerPermission() != "read" || d.GetLastError() != "" ||
					d.GetPullRequest().GetState() != v1.PullRequestState_PULL_REQUEST_STATE_MERGED {
					t.Errorf("merged = %v", d)
				}
			},
			recalls: []string{"refresh-detail o/r#8"},
		},
		{name: "unknown pull request", req: &v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 9}, code: connect.CodeNotFound},
		{name: "bad slug", req: &v1.GetPullRequestDetailRequest{RepoSlug: "nope", Number: 7}, code: connect.CodeInvalidArgument},
		{name: "bad number", req: &v1.GetPullRequestDetailRequest{RepoSlug: "o/r"}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := len(store.Calls())
			res, err := client.GetPullRequestDetail(ctx, connect.NewRequest(tt.req))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Errorf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			tt.check(t, res.Msg.GetDetail())
			if got := store.Calls()[before:]; !slices.Equal(got, tt.recalls) {
				t.Errorf("calls = %v, want %v", got, tt.recalls)
			}
		})
	}
}

func TestGhReviewerCandidatesAndRequests(t *testing.T) {
	store, client, _ := newGhTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	store.SetReviewerCandidates("o/r", 7, gh.ReviewerCandidates{Truncated: true, Candidates: []gh.ReviewerCandidate{
		{ID: "T_1", Kind: gh.ReviewerTeam, Login: "acme/core", Name: "Core", Requested: true},
		{ID: "U_1", Kind: gh.ReviewerUser, Login: "kim", Name: "Kim", AvatarURL: "https://a/kim"},
	}})

	list, err := client.ListReviewerCandidates(ctx, connect.NewRequest(&v1.ListReviewerCandidatesRequest{RepoSlug: "o/r", Number: 7}))
	if err != nil {
		t.Fatal(err)
	}
	c := list.Msg.GetCandidates()
	if !list.Msg.GetTruncated() || len(c) != 2 || c[0].GetKind() != v1.ReviewerKind_REVIEWER_KIND_TEAM || !c[0].GetIsRequested() ||
		c[1].GetKind() != v1.ReviewerKind_REVIEWER_KIND_USER || c[1].GetId() != "U_1" || c[1].GetName() != "Kim" ||
		c[1].GetAvatarUrl() != "https://a/kim" || c[1].GetIsRequested() {
		t.Errorf("candidates = %v", list.Msg)
	}
	if _, err := client.ListReviewerCandidates(ctx, connect.NewRequest(&v1.ListReviewerCandidatesRequest{RepoSlug: "o/r", Number: 8})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown PR err = %v", err)
	}

	stream, err := client.Watch(ctx, connect.NewRequest(&v1.WatchGhRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		req  *v1.SetReviewRequestRequest
		code connect.Code
		want []string // requested afterwards
		call string
	}{
		{name: "request a user (kind unspecified)", req: &v1.SetReviewRequestRequest{RepoSlug: "O/R", Number: 7, Login: "kim", Requested: true},
			want: []string{"acme/core", "kim"}, call: "review o/r#7 USER kim true"},
		{name: "withdraw a team", req: &v1.SetReviewRequestRequest{RepoSlug: "o/r", Number: 7, Login: "acme/core", Kind: v1.ReviewerKind_REVIEWER_KIND_TEAM},
			want: []string{"kim"}, call: "review o/r#7 TEAM acme/core false"},
		{name: "empty login", req: &v1.SetReviewRequestRequest{RepoSlug: "o/r", Number: 7, Requested: true}, code: connect.CodeInvalidArgument},
		{name: "bad slug", req: &v1.SetReviewRequestRequest{RepoSlug: "x", Number: 7, Login: "kim"}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := len(store.Calls())
			res, err := client.SetReviewRequest(ctx, connect.NewRequest(tt.req))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Errorf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := res.Msg.GetRequested(); !slices.Equal(got, tt.want) {
				t.Errorf("requested = %v, want %v", got, tt.want)
			}
			if got := store.Calls()[before:]; !slices.Equal(got, []string{tt.call}) {
				t.Errorf("calls = %v", got)
			}
			// Each change announces the pull request's detail.
			for stream.Receive() {
				if ev := stream.Msg().GetPullRequestDetailUpdated(); ev != nil {
					if ev.GetRepoSlug() != "o/r" || ev.GetNumber() != 7 {
						t.Errorf("event = %v", ev)
					}
					break
				}
			}
		})
	}
}

func TestGhRevertPullRequest(t *testing.T) {
	store, client, _ := newGhTest(t)
	ctx := context.Background()
	at := time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC)
	store.SetFullPullRequest("o/r", detailFixture(at)) // #7 open
	store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_8", Number: 8, State: gh.PullRequestMerged}})
	store.SetRevert("o/r", 8, gh.RevertResult{Number: 31, URL: "https://github.com/o/r/pull/31"})

	tests := []struct {
		name   string
		number int32
		code   connect.Code
		want   string
	}{
		{name: "merged", number: 8, want: "31 https://github.com/o/r/pull/31"},
		{name: "open: failed precondition", number: 7, code: connect.CodeFailedPrecondition},
		{name: "unknown", number: 9, code: connect.CodeNotFound},
		{name: "bad number", number: -1, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := client.RevertPullRequest(ctx, connect.NewRequest(&v1.RevertPullRequestRequest{RepoSlug: "o/r", Number: tt.number}))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Errorf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := fmt.Sprintf("%d %s", res.Msg.GetNumber(), res.Msg.GetUrl()); got != tt.want {
				t.Errorf("revert = %s, want %s", got, tt.want)
			}
		})
	}
}
