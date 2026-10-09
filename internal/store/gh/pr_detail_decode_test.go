package gh

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

// The fixtures are real captures of pull_request_full.graphql and
// reviewer_candidates.graphql (2026-10-09, alexwaumann): ghostty-org/ghostty#13779 (open,
// busy: threads, reviews, a bot, a request for an unreadable team) and
// alexwaumann/code-foundry#1 (merged, admin viewer).

func TestDecodeFullPullRequestBusy(t *testing.T) {
	d, page, err := decodeFullPullRequest(fixtureData(t, "pull_request_full_13779.json"))
	if err != nil {
		t.Fatal(err)
	}
	pr := d.PullRequest
	if pr.Number != 13779 || pr.State != PullRequestOpen || pr.Repo != "ghostty-org/ghostty" || pr.ID == "" ||
		pr.HeadSHA != "58a070fb368c8b7fc3a307891e57f92a86811e79" || pr.ReviewDecision != ReviewRequired {
		t.Errorf("summary = %+v", pr)
	}
	if !strings.HasPrefix(d.Body, "This PR is a first step toward making Ghostty usable") {
		t.Errorf("body = %.60q", d.Body)
	}
	if fmt.Sprint(d.Labels) != "[{gtk f173a5}]" {
		t.Errorf("labels = %v", d.Labels)
	}
	if d.ViewerPermission != "READ" || d.ViewerCanUpdate() {
		t.Errorf("permission = %q, can update %v", d.ViewerPermission, d.ViewerCanUpdate())
	}
	if d.MergeCommitSHA != "" || d.MergedBy != "" || !d.ClosedAt.IsZero() {
		t.Errorf("open PR has merge fields: %q %q %v", d.MergeCommitSHA, d.MergedBy, d.ClosedAt)
	}

	// Reviewers: requested first (the unreadable team is skipped), then latest review.
	var got []string
	for _, r := range d.Reviewers {
		got = append(got, fmt.Sprintf("%s:%s:req=%v:stale=%v:bot=%v", r.Login, r.State, r.Requested, r.Stale, r.Bot))
	}
	want := []string{
		"bo2themax::req=true:stale=false:bot=false",
		"jcollie::req=true:stale=false:bot=false",
		"pluiedev:APPROVED:req=false:stale=true:bot=false",
		"copilot-pull-request-reviewer:COMMENTED:req=false:stale=true:bot=true",
	}
	if !slices.Equal(got, want) {
		t.Errorf("reviewers =\n%v\nwant\n%v", got, want)
	}

	if d.CommitCount != 9 || len(d.Commits) != 9 || d.Commits[0].SHA[:7] != "f161941" || d.Commits[0].AuthorLogin != "alex19EP" ||
		d.Commits[0].AuthorName != "Alexander Epaneshnikov" || d.Commits[8].Headline != "unicode: move the generic UTF-8 codepoint helpers out of a11y" {
		t.Errorf("commits = %d/%d %+v", len(d.Commits), d.CommitCount, d.Commits[0])
	}

	// 19 issue comments and 18 reviews, oldest first.
	if len(d.Comments) != 37 || d.CommentsTruncated {
		t.Errorf("comments = %d truncated %v", len(d.Comments), d.CommentsTruncated)
	}
	kinds := map[CommentKind]int{}
	for i, c := range d.Comments {
		kinds[c.Kind]++
		if i > 0 && c.CreatedAt.Before(d.Comments[i-1].CreatedAt) {
			t.Errorf("comment %d out of order", i)
		}
		if c.Kind == CommentReview && c.ReviewState == "" || c.Kind == CommentIssue && c.ReviewState != "" {
			t.Errorf("comment %d: kind %s review state %q", i, c.Kind, c.ReviewState)
		}
		if c.ID == "" || c.URL == "" || c.CreatedAt.IsZero() {
			t.Errorf("comment %d incomplete: %+v", i, c)
		}
	}
	if kinds[CommentIssue] != 19 || kinds[CommentReview] != 18 {
		t.Errorf("comment kinds = %v", kinds)
	}

	if len(d.Threads) != 15 || d.ThreadsTruncated {
		t.Fatalf("threads = %d truncated %v", len(d.Threads), d.ThreadsTruncated)
	}
	first, current, open := d.Threads[0], d.Threads[13], d.Threads[14]
	if first.Path != "src/apprt/gtk/class/surface.zig" || first.Line != 2063 || first.Side != "RIGHT" || !first.Resolved || !first.Outdated ||
		len(first.Comments) != 1 || first.Comments[0].Kind != CommentReviewComment || !first.Comments[0].AuthorBot ||
		first.Comments[0].Path != first.Path {
		t.Errorf("outdated thread = %+v", first)
	}
	if current.Line != 1 || current.Outdated || len(current.Comments) != 2 {
		t.Errorf("current thread = %+v", current)
	}
	if open.Resolved || open.Path != "src/a11y/text.zig" || open.Line != 125 {
		t.Errorf("unresolved thread = %+v", open)
	}

	// No CI on this fork PR.
	if len(page.Runs) != 0 || page.Next.HasNextPage || pr.Checks.State != "" {
		t.Errorf("checks = %+v rollup %+v", page, pr.Checks)
	}
}

func TestDecodeFullPullRequestMerged(t *testing.T) {
	d, page, err := decodeFullPullRequest(fixtureData(t, "pull_request_full_cf_1.json"))
	if err != nil {
		t.Fatal(err)
	}
	pr := d.PullRequest
	if pr.State != PullRequestMerged || pr.ID != "PR_kwDOVAtW7M8AAAABHeFTDg" || pr.Number != 1 || pr.MergedAt.IsZero() {
		t.Errorf("summary = %+v", pr)
	}
	if d.MergeCommitSHA != "1ef770ad823852e60967de188fbbd02663e33409" || d.MergedBy != "alexwaumann" || d.ClosedAt.IsZero() {
		t.Errorf("merge = %q by %q closed %v", d.MergeCommitSHA, d.MergedBy, d.ClosedAt)
	}
	if d.ViewerPermission != "ADMIN" || !d.ViewerCanUpdate() {
		t.Errorf("permission = %q", d.ViewerPermission)
	}
	if d.CommitCount != 8 || len(d.Commits) != 8 || d.Commits[7].SHA != pr.HeadSHA {
		t.Errorf("commits = %d/%d, last %+v", len(d.Commits), d.CommitCount, d.Commits[len(d.Commits)-1])
	}
	if len(d.Reviewers) != 0 || len(d.Comments) != 0 || len(d.Threads) != 0 || len(d.Labels) != 0 {
		t.Errorf("expected an empty conversation: %+v", d)
	}
	if len(page.Runs) != 1 || page.Next.HasNextPage || pr.Checks.Total != 1 || pr.Checks.State != RollupSuccess {
		t.Errorf("checks = %+v rollup %+v", page.Runs, pr.Checks)
	}
}

func TestDecodeFullPullRequestNotFound(t *testing.T) {
	_, _, err := decodeFullPullRequest([]byte(`{"repository":{"viewerPermission":"READ","pullRequest":null}}`))
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v", err)
	}
}

func TestDecodeReviewerCandidates(t *testing.T) {
	c, err := decodeReviewerCandidates(fixtureData(t, "reviewer_candidates_13779.json"))
	if err != nil {
		t.Fatal(err)
	}
	// 94 assignable users, two of them requested; one request is a team the token
	// cannot read (null); the author (alex19EP) is not assignable here.
	if len(c.Candidates) != 94 || c.Truncated {
		t.Fatalf("candidates = %d truncated %v", len(c.Candidates), c.Truncated)
	}
	var head []string
	for _, x := range c.Candidates[:3] {
		head = append(head, fmt.Sprintf("%s:%v:%s", x.Login, x.Requested, x.Kind))
	}
	if want := []string{"bo2themax:true:USER", "jcollie:true:USER", "00-kat:false:USER"}; !slices.Equal(head, want) {
		t.Errorf("order = %v, want %v", head, want)
	}
	for i, x := range c.Candidates {
		if x.ID == "" || x.Login == "" || x.AvatarURL == "" {
			t.Errorf("candidate %d incomplete: %+v", i, x)
		}
		if i > 2 && strings.ToLower(x.Login) < strings.ToLower(c.Candidates[i-1].Login) {
			t.Errorf("candidate %d (%s) out of order", i, x.Login)
		}
	}
}

func TestDecodeReviewerCandidatesShapes(t *testing.T) {
	tests := []struct {
		name, data string
		want       []string
		truncated  bool
		err        error
	}{
		{
			name: "author excluded, team requested, truncated",
			data: `{"repository":{"assignableUsers":{"totalCount":250,"nodes":[
				{"id":"U1","login":"Zed"},{"id":"U2","login":"author"},{"id":"U3","login":"amy"}]},
				"pullRequest":{"author":{"login":"Author"},"reviewRequests":{"nodes":[
				{"requestedReviewer":{"__typename":"Team","id":"T1","slug":"core","name":"Core","organization":{"login":"acme"}}},
				{"requestedReviewer":{"__typename":"User","id":"U1","login":"Zed"}}]}}}}`,
			want:      []string{"acme/core:TEAM:true", "Zed:USER:true", "amy:USER:false"},
			truncated: true,
		},
		{
			name: "deleted author, nothing requested",
			data: `{"repository":{"assignableUsers":{"totalCount":1,"nodes":[{"id":"U1","login":"bob"}]},
				"pullRequest":{"author":null,"reviewRequests":{"nodes":[]}}}}`,
			want: []string{"bob:USER:false"},
		},
		{name: "missing pull request", data: `{"repository":{"assignableUsers":{"nodes":[]},"pullRequest":null}}`, err: ErrNotFound},
		{name: "missing repository", data: `{"repository":null}`, err: ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := decodeReviewerCandidates([]byte(tt.data))
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Errorf("err = %v, want %v", err, tt.err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, x := range c.Candidates {
				got = append(got, fmt.Sprintf("%s:%s:%v", x.Login, x.Kind, x.Requested))
			}
			if !slices.Equal(got, tt.want) || c.Truncated != tt.truncated {
				t.Errorf("got %v truncated %v, want %v %v", got, c.Truncated, tt.want, tt.truncated)
			}
		})
	}
}

func TestDecodeRevertAndRequestedReviewers(t *testing.T) {
	r, err := decodeRevert([]byte(`{"revertPullRequest":{"revertPullRequest":{"number":42,"url":"https://github.com/o/r/pull/42"}}}`))
	if err != nil || r.Number != 42 || r.URL != "https://github.com/o/r/pull/42" {
		t.Errorf("revert = %+v, %v", r, err)
	}
	if _, err := decodeRevert([]byte(`{"revertPullRequest":null}`)); err == nil {
		t.Error("empty revert: want error")
	}
	got, err := decodeRequestedReviewers([]byte(`{"number":7,"requested_reviewers":[{"login":"kim"}],
		"requested_teams":[{"slug":"core"}],"base":{"repo":{"owner":{"login":"Acme"}}}}`), "acme")
	if err != nil || !slices.Equal(got, []string{"kim", "Acme/core"}) {
		t.Errorf("requested = %v, %v", got, err)
	}
	got, err = decodeRequestedReviewers([]byte(`{"requested_reviewers":[],"requested_teams":[{"slug":"x"}]}`), "o")
	if err != nil || !slices.Equal(got, []string{"o/x"}) {
		t.Errorf("requested without base = %v, %v", got, err)
	}
}

// The static documents declare exactly the variables the store sends.
func TestDetailQueryVariables(t *testing.T) {
	for _, tt := range []struct {
		name string
		vars map[string]any
	}{
		{queryPullRequestFull, map[string]any{"owner": "o", "name": "r", "number": 1}},
		{queryReviewerCandidates, map[string]any{"owner": "o", "name": "r", "number": 1}},
		{queryRevertPullRequest, map[string]any{"id": "PR_x"}},
	} {
		q, err := query(tt.name)
		if err != nil {
			t.Fatal(err)
		}
		checkDoc(t, tt.name, q, tt.vars)
	}
}
