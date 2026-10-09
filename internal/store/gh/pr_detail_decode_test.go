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

	// 19 issue comments and 18 reviews, oldest first. 14 of the reviews are COMMENTED
	// with an empty body: GitHub's record of each inline comment and thread reply, whose
	// text is in the threads. They are left out.
	if len(d.Comments) != 23 || d.CommentsTruncated {
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
	if kinds[CommentIssue] != 19 || kinds[CommentReview] != 4 {
		t.Errorf("comment kinds = %v", kinds)
	}
	if d.LabelsTruncated || d.ReviewersTruncated || d.ChecksTruncated {
		t.Errorf("truncated: labels %v reviewers %v checks %v", d.LabelsTruncated, d.ReviewersTruncated, d.ChecksTruncated)
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
	// Every inline comment names its review, so a client can group them.
	reviews := 0
	for _, th := range d.Threads {
		for _, c := range th.Comments {
			if !strings.HasPrefix(c.ReviewID, "PRR_") {
				t.Errorf("thread %s comment %s: review id %q", th.ID, c.ID, c.ReviewID)
			}
			reviews++
		}
	}
	if reviews != 28 {
		t.Errorf("inline comments = %d, want 28", reviews)
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

// Synthetic shapes the captures do not cover.
func TestDecodeFullPullRequestShapes(t *testing.T) {
	const head = `"id":"PR_1","number":7,"title":"t","url":"https://github.com/o/r/pull/7","state":"MERGED",` +
		`"headRefName":"h","headRefOid":"abc","baseRefName":"main","repository":{"nameWithOwner":"o/r"}`
	wrap := func(fields string) []byte {
		return []byte(`{"repository":{"viewerPermission":"WRITE","pullRequest":{` + head + `,` + fields + `}}}`)
	}
	tests := []struct {
		name   string
		fields string
		check  func(t *testing.T, d FullPullRequest)
	}{
		{
			name: "null authors: comments, reviews, thread comments",
			fields: `"issueComments":{"totalCount":1,"nodes":[{"id":"IC_1","author":null,"body":"ghost says hi","createdAt":"2026-01-01T00:00:00Z","url":"u1"}]},
				"reviewList":{"totalCount":1,"nodes":[{"id":"PRR_1","author":null,"body":"lgtm","state":"APPROVED","createdAt":"2026-01-02T00:00:00Z","submittedAt":"2026-01-02T00:00:00Z","url":"u2"}]},
				"reviewers":{"totalCount":1,"nodes":[{"author":null,"state":"APPROVED","submittedAt":"2026-01-02T00:00:00Z","commit":{"oid":"abc"}}]},
				"reviewThreads":{"totalCount":1,"nodes":[{"id":"T1","path":"a.go","line":3,"diffSide":"RIGHT","comments":{"totalCount":1,
					"nodes":[{"id":"C1","author":null,"body":"nit","createdAt":"2026-01-02T00:00:00Z","url":"u3","path":"a.go","pullRequestReview":null}]}}]}`,
			check: func(t *testing.T, d FullPullRequest) {
				if len(d.Comments) != 2 || d.Comments[0].Author != "" || d.Comments[0].Body != "ghost says hi" ||
					d.Comments[1].Author != "" || d.Comments[1].ReviewState != "APPROVED" {
					t.Errorf("comments = %+v", d.Comments)
				}
				if len(d.Reviewers) != 0 {
					t.Errorf("a deleted reviewer is listed: %+v", d.Reviewers)
				}
				if c := d.Threads[0].Comments[0]; c.Author != "" || c.Body != "nit" || c.ReviewID != "" {
					t.Errorf("thread comment = %+v", c)
				}
			},
		},
		{
			name: "PENDING drafts and empty COMMENTED reviews are left out",
			fields: `"reviewList":{"totalCount":4,"nodes":[
					{"id":"PRR_draft","author":{"login":"me"},"body":"draft","state":"PENDING","createdAt":"2026-01-01T00:00:00Z","url":"u"},
					{"id":"PRR_inline","author":{"login":"kim"},"body":" \n","state":"COMMENTED","createdAt":"2026-01-02T00:00:00Z","url":"u"},
					{"id":"PRR_said","author":{"login":"kim"},"body":"see inline","state":"COMMENTED","createdAt":"2026-01-03T00:00:00Z","url":"u"},
					{"id":"PRR_ok","author":{"login":"ana"},"body":"","state":"APPROVED","createdAt":"2026-01-04T00:00:00Z","url":"u"}]},
				"reviewers":{"totalCount":2,"nodes":[
					{"author":{"login":"me"},"state":"PENDING","submittedAt":null,"commit":{"oid":"abc"}},
					{"author":{"login":"ana"},"state":"APPROVED","submittedAt":"2026-01-04T00:00:00Z","commit":{"oid":"abc"}}]},
				"reviewThreads":{"totalCount":1,"nodes":[{"id":"T1","path":"a.go","line":3,"diffSide":"RIGHT","comments":{"totalCount":1,
					"nodes":[{"id":"C1","author":{"login":"kim"},"body":"nit","createdAt":"2026-01-02T00:00:00Z","url":"u","pullRequestReview":{"id":"PRR_inline"}}]}}]}`,
			check: func(t *testing.T, d FullPullRequest) {
				var ids []string
				for _, c := range d.Comments {
					ids = append(ids, c.ID)
				}
				if !slices.Equal(ids, []string{"PRR_said", "PRR_ok"}) {
					t.Errorf("comments = %v", ids)
				}
				if len(d.Reviewers) != 1 || d.Reviewers[0].Login != "ana" {
					t.Errorf("reviewers = %+v", d.Reviewers)
				}
				if c := d.Threads[0].Comments[0]; c.ReviewID != "PRR_inline" || c.Path != "a.go" {
					t.Errorf("thread comment = %+v", c)
				}
			},
		},
		{
			name: "team and user requested, a stale review re-requested",
			fields: `"reviewers":{"totalCount":1,"nodes":[{"author":{"__typename":"User","login":"kim"},"state":"CHANGES_REQUESTED","submittedAt":"2026-01-02T00:00:00Z","commit":{"oid":"old"}}]},
				"requestedReviewers":{"totalCount":2,"nodes":[
					{"requestedReviewer":{"__typename":"Team","id":"T_1","slug":"core","name":"Core","organization":{"login":"acme"}}},
					{"requestedReviewer":{"__typename":"User","id":"U_kim","login":"Kim"}}]}`,
			check: func(t *testing.T, d FullPullRequest) {
				var got []string
				for _, r := range d.Reviewers {
					got = append(got, fmt.Sprintf("%s:team=%v:%s:req=%v:stale=%v", r.Login, r.Team, r.State, r.Requested, r.Stale))
				}
				want := []string{"kim:team=false:CHANGES_REQUESTED:req=true:stale=true", "acme/core:team=true::req=true:stale=false"}
				if !slices.Equal(got, want) {
					t.Errorf("reviewers = %v, want %v", got, want)
				}
			},
		},
		{
			name:   "merged by a deleted account",
			fields: `"mergeCommit":{"oid":"m1"},"mergedBy":null,"closedAt":"2026-01-05T00:00:00Z"`,
			check: func(t *testing.T, d FullPullRequest) {
				if d.MergeCommitSHA != "m1" || d.MergedBy != "" || d.ClosedAt.IsZero() || !d.ViewerCanUpdate() {
					t.Errorf("merge = %q by %q at %v", d.MergeCommitSHA, d.MergedBy, d.ClosedAt)
				}
			},
		},
		{
			name: "every truncation flag",
			fields: `"labels":{"totalCount":21,"nodes":[{"name":"a","color":"fff"}]},
				"reviewers":{"totalCount":51,"nodes":[]},
				"requestedReviewers":{"totalCount":0,"nodes":[]},
				"issueComments":{"totalCount":101,"nodes":[]},
				"reviewList":{"totalCount":0,"nodes":[]},
				"reviewThreads":{"totalCount":51,"nodes":[{"id":"T1","path":"a.go","comments":{"totalCount":21,"nodes":[]}}]}`,
			check: func(t *testing.T, d FullPullRequest) {
				if !d.LabelsTruncated || !d.ReviewersTruncated || !d.CommentsTruncated || !d.ThreadsTruncated || !d.Threads[0].CommentsTruncated {
					t.Errorf("flags: labels %v reviewers %v comments %v threads %v thread comments %v", d.LabelsTruncated,
						d.ReviewersTruncated, d.CommentsTruncated, d.ThreadsTruncated, d.Threads[0].CommentsTruncated)
				}
			},
		},
		{
			name:   "pending requests alone truncate reviewers; reviews alone truncate comments",
			fields: `"requestedReviewers":{"totalCount":51,"nodes":[]},"reviewList":{"totalCount":101,"nodes":[]}`,
			check: func(t *testing.T, d FullPullRequest) {
				if !d.ReviewersTruncated || !d.CommentsTruncated || d.LabelsTruncated || d.ThreadsTruncated {
					t.Errorf("flags: reviewers %v comments %v labels %v threads %v", d.ReviewersTruncated, d.CommentsTruncated,
						d.LabelsTruncated, d.ThreadsTruncated)
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, _, err := decodeFullPullRequest(wrap(tt.fields))
			if err != nil {
				t.Fatal(err)
			}
			tt.check(t, d)
		})
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
