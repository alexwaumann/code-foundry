package gh

import (
	"cmp"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

// JSON shapes of pull_request_full.graphql, reviewer_candidates.graphql,
// revert_pull_request.graphql, and merge_pull_request.graphql, and their mapping to the domain types.

type actorJSON struct {
	Typename  string `json:"__typename"`
	Login     string `json:"login"`
	AvatarURL string `json:"avatarUrl"`
}

type commentJSON struct {
	ID          string     `json:"id"`
	Author      *actorJSON `json:"author"`
	Body        string     `json:"body"`
	State       string     `json:"state"`
	CreatedAt   time.Time  `json:"createdAt"`
	SubmittedAt time.Time  `json:"submittedAt"`
	URL         string     `json:"url"`
	Path        string     `json:"path"`
	// PullRequestReview is the review an inline comment belongs to (review threads).
	PullRequestReview *struct {
		ID string `json:"id"`
	} `json:"pullRequestReview"`
}

type commentsJSON struct {
	TotalCount int           `json:"totalCount"`
	Nodes      []commentJSON `json:"nodes"`
}

type threadJSON struct {
	ID           string       `json:"id"`
	Path         string       `json:"path"`
	Line         *int         `json:"line"`
	OriginalLine *int         `json:"originalLine"`
	DiffSide     string       `json:"diffSide"`
	IsResolved   bool         `json:"isResolved"`
	IsOutdated   bool         `json:"isOutdated"`
	Comments     commentsJSON `json:"comments"`
}

type oidJSON struct {
	Oid string `json:"oid"`
}

type reviewRequestsJSON struct {
	TotalCount int `json:"totalCount"`
	Nodes      []struct {
		RequestedReviewer *requestedReviewerJSON `json:"requestedReviewer"`
	} `json:"nodes"`
}

// pullRequestFullJSON is pull_request_full.graphql's pullRequest: the PullRequestDetail
// fragment plus the detail panel's fields.
type pullRequestFullJSON struct {
	pullRequestJSON
	Body        string     `json:"body"`
	ClosedAt    time.Time  `json:"closedAt"`
	MergeCommit *oidJSON   `json:"mergeCommit"`
	MergedBy    *loginJSON `json:"mergedBy"`
	// AutoMergeRequest is non-null while auto-merge is enabled.
	AutoMergeRequest *struct {
		EnabledAt time.Time `json:"enabledAt"`
	} `json:"autoMergeRequest"`
	Labels *struct {
		TotalCount int     `json:"totalCount"`
		Nodes      []Label `json:"nodes"`
	} `json:"labels"`
	Reviewers *struct {
		TotalCount int `json:"totalCount"`
		Nodes      []struct {
			Author      *actorJSON `json:"author"`
			State       string     `json:"state"`
			SubmittedAt time.Time  `json:"submittedAt"`
			Commit      *oidJSON   `json:"commit"`
		} `json:"nodes"`
	} `json:"reviewers"`
	RequestedReviewers *reviewRequestsJSON `json:"requestedReviewers"`
	Commits            *struct {
		TotalCount int `json:"totalCount"`
		Nodes      []struct {
			Commit struct {
				Oid             string    `json:"oid"`
				MessageHeadline string    `json:"messageHeadline"`
				CommittedDate   time.Time `json:"committedDate"`
				Author          *struct {
					Name string     `json:"name"`
					User *loginJSON `json:"user"`
				} `json:"author"`
			} `json:"commit"`
		} `json:"nodes"`
	} `json:"commits"`
	IssueComments *commentsJSON `json:"issueComments"`
	ReviewList    *commentsJSON `json:"reviewList"`
	ReviewThreads *struct {
		TotalCount int          `json:"totalCount"`
		Nodes      []threadJSON `json:"nodes"`
	} `json:"reviewThreads"`
}

type pullRequestFullData struct {
	RateLimit  *rateLimitJSON `json:"rateLimit"`
	Repository *struct {
		ViewerPermission string `json:"viewerPermission"`
		// Pointers: a row decoded from a response without them knows no methods.
		MergeCommitAllowed *bool                `json:"mergeCommitAllowed"`
		SquashMergeAllowed *bool                `json:"squashMergeAllowed"`
		RebaseMergeAllowed *bool                `json:"rebaseMergeAllowed"`
		PullRequest        *pullRequestFullJSON `json:"pullRequest"`
	} `json:"repository"`
}

// decodeFullPullRequest maps a PullRequestFull response: the detail (without FetchedAt)
// and the first page of head commit checks, whose Next says whether more follow.
func decodeFullPullRequest(data []byte) (FullPullRequest, checksPage, error) {
	var d pullRequestFullData
	if err := json.Unmarshal(data, &d); err != nil {
		return FullPullRequest{}, checksPage{}, fmt.Errorf("decode pull request detail: %w", err)
	}
	if d.Repository == nil || d.Repository.PullRequest == nil {
		return FullPullRequest{}, checksPage{}, fmt.Errorf("decode pull request detail: %w", ErrNotFound)
	}
	p := d.Repository.PullRequest
	out := FullPullRequest{
		PullRequest:      mapPullRequest(&p.pullRequestJSON),
		Body:             p.Body,
		ClosedAt:         p.ClosedAt,
		ViewerPermission: d.Repository.ViewerPermission,
		AutoMerge:        p.AutoMergeRequest != nil,
	}
	for _, m := range []struct {
		allowed *bool
		method  MergeMethod
	}{
		{d.Repository.MergeCommitAllowed, MergeCommit},
		{d.Repository.SquashMergeAllowed, MergeSquash},
		{d.Repository.RebaseMergeAllowed, MergeRebase},
	} {
		if m.allowed != nil && *m.allowed {
			out.MergeMethods = append(out.MergeMethods, m.method)
		}
	}
	if p.MergeCommit != nil {
		out.MergeCommitSHA = p.MergeCommit.Oid
	}
	if p.MergedBy != nil {
		out.MergedBy = p.MergedBy.Login
	}
	if p.Labels != nil {
		out.Labels = p.Labels.Nodes
		out.LabelsTruncated = p.Labels.TotalCount > len(p.Labels.Nodes)
	}
	out.Reviewers = mapReviewers(p)
	if r := p.Reviewers; r != nil && r.TotalCount > len(r.Nodes) {
		out.ReviewersTruncated = true
	}
	if r := p.RequestedReviewers; r != nil && r.TotalCount > len(r.Nodes) {
		out.ReviewersTruncated = true
	}
	if p.Commits != nil {
		out.CommitCount = p.Commits.TotalCount
		for _, n := range p.Commits.Nodes {
			c := Commit{SHA: n.Commit.Oid, Headline: n.Commit.MessageHeadline, CommittedAt: n.Commit.CommittedDate}
			if a := n.Commit.Author; a != nil {
				c.AuthorName = a.Name
				if a.User != nil {
					c.AuthorLogin = a.User.Login
				}
			}
			out.Commits = append(out.Commits, c)
		}
	}
	out.Comments, out.CommentsTruncated = mapConversation(p.IssueComments, p.ReviewList)
	if t := p.ReviewThreads; t != nil {
		out.ThreadsTruncated = t.TotalCount > len(t.Nodes)
		for _, n := range t.Nodes {
			out.Threads = append(out.Threads, mapThread(n))
		}
	}
	page := mapChecksPage(&commitJSON{Oid: p.HeadRefOid, StatusCheckRollup: p.Checks})
	return out, page, nil
}

// mapReviewers merges each reviewer's latest review with the pending review requests.
// Draft (PENDING) reviews are the viewer's own unsubmitted ones and are left out.
func mapReviewers(p *pullRequestFullJSON) []Reviewer {
	var out []Reviewer
	index := map[string]int{}
	if p.Reviewers != nil {
		for _, n := range p.Reviewers.Nodes {
			if n.State == "PENDING" {
				continue
			}
			r := Reviewer{State: n.State, SubmittedAt: n.SubmittedAt}
			if a := n.Author; a != nil {
				r.Login, r.Bot, r.AvatarURL = a.Login, a.Typename == "Bot", a.AvatarURL
			}
			if r.Login == "" {
				continue // deleted account
			}
			r.Stale = n.Commit != nil && n.Commit.Oid != "" && n.Commit.Oid != p.HeadRefOid
			index[strings.ToLower(r.Login)] = len(out)
			out = append(out, r)
		}
	}
	if p.RequestedReviewers != nil {
		for _, n := range p.RequestedReviewers.Nodes {
			rr := n.RequestedReviewer
			login := reviewerName(rr)
			if login == "" {
				continue // a team the token cannot read
			}
			if i, ok := index[strings.ToLower(login)]; ok {
				out[i].Requested = true
				continue
			}
			index[strings.ToLower(login)] = len(out)
			out = append(out, Reviewer{Login: login, Team: rr.Typename == "Team", Bot: rr.Typename == "Bot",
				AvatarURL: rr.AvatarURL, Requested: true})
		}
	}
	slices.SortStableFunc(out, func(a, b Reviewer) int {
		if a.Requested != b.Requested {
			if a.Requested {
				return -1
			}
			return 1
		}
		if c := b.SubmittedAt.Compare(a.SubmittedAt); c != 0 {
			return c
		}
		return strings.Compare(strings.ToLower(a.Login), strings.ToLower(b.Login))
	})
	return out
}

func mapComment(n commentJSON, kind CommentKind) Comment {
	c := Comment{ID: n.ID, Kind: kind, Body: n.Body, CreatedAt: n.CreatedAt, URL: n.URL, Path: n.Path}
	if a := n.Author; a != nil {
		c.Author, c.AuthorBot, c.AuthorAvatar = a.Login, a.Typename == "Bot", a.AvatarURL
	}
	switch kind {
	case CommentReview:
		c.ReviewState = n.State
		if !n.SubmittedAt.IsZero() {
			c.CreatedAt = n.SubmittedAt
		}
	case CommentReviewComment:
		if n.PullRequestReview != nil {
			c.ReviewID = n.PullRequestReview.ID
		}
	}
	return c
}

// mapConversation merges issue comments and submitted reviews, oldest first. Drafts
// (PENDING) are left out, and so are COMMENTED reviews without a body: GitHub records
// every inline comment and thread reply as one, and their text is in the threads.
// truncated covers both streams.
func mapConversation(issue, reviews *commentsJSON) ([]Comment, bool) {
	var out []Comment
	truncated := false
	if issue != nil {
		truncated = issue.TotalCount > len(issue.Nodes)
		for _, n := range issue.Nodes {
			out = append(out, mapComment(n, CommentIssue))
		}
	}
	if reviews != nil {
		truncated = truncated || reviews.TotalCount > len(reviews.Nodes)
		for _, n := range reviews.Nodes {
			if n.State == "PENDING" || n.State == "COMMENTED" && strings.TrimSpace(n.Body) == "" {
				continue
			}
			out = append(out, mapComment(n, CommentReview))
		}
	}
	slices.SortStableFunc(out, func(a, b Comment) int { return a.CreatedAt.Compare(b.CreatedAt) })
	return out, truncated
}

func mapThread(n threadJSON) ReviewThread {
	t := ReviewThread{ID: n.ID, Path: n.Path, Side: n.DiffSide, Resolved: n.IsResolved, Outdated: n.IsOutdated,
		CommentsTruncated: n.Comments.TotalCount > len(n.Comments.Nodes), Comments: []Comment{}}
	if l := cmp.Or(n.Line, n.OriginalLine); l != nil {
		t.Line = *l
	}
	for _, c := range n.Comments.Nodes {
		rc := mapComment(c, CommentReviewComment)
		rc.Path = cmp.Or(rc.Path, n.Path)
		t.Comments = append(t.Comments, rc)
	}
	return t
}

type reviewerCandidatesData struct {
	Repository *struct {
		AssignableUsers struct {
			TotalCount int `json:"totalCount"`
			Nodes      []struct {
				ID        string `json:"id"`
				Login     string `json:"login"`
				Name      string `json:"name"`
				AvatarURL string `json:"avatarUrl"`
			} `json:"nodes"`
		} `json:"assignableUsers"`
		PullRequest *struct {
			Author         *loginJSON          `json:"author"`
			ReviewRequests *reviewRequestsJSON `json:"reviewRequests"`
		} `json:"pullRequest"`
	} `json:"repository"`
}

// decodeReviewerCandidates maps a ReviewerCandidates response: the requested users and
// teams first, then the assignable users, each by login; the author is left out.
func decodeReviewerCandidates(data []byte) (ReviewerCandidates, error) {
	var d reviewerCandidatesData
	if err := json.Unmarshal(data, &d); err != nil {
		return ReviewerCandidates{}, fmt.Errorf("decode reviewer candidates: %w", err)
	}
	if d.Repository == nil || d.Repository.PullRequest == nil {
		return ReviewerCandidates{}, fmt.Errorf("decode reviewer candidates: %w", ErrNotFound)
	}
	pr := d.Repository.PullRequest
	author := ""
	if pr.Author != nil {
		author = strings.ToLower(pr.Author.Login)
	}
	seen := map[string]bool{}
	var requested, others []ReviewerCandidate
	if pr.ReviewRequests != nil {
		for _, n := range pr.ReviewRequests.Nodes {
			rr := n.RequestedReviewer
			login := reviewerName(rr)
			if login == "" || strings.ToLower(login) == author {
				continue
			}
			kind := ReviewerUser
			if rr.Typename == "Team" {
				kind = ReviewerTeam
			}
			seen[strings.ToLower(login)] = true
			requested = append(requested, ReviewerCandidate{ID: rr.ID, Kind: kind, Login: login, Name: rr.Name,
				AvatarURL: rr.AvatarURL, Requested: true})
		}
	}
	users := d.Repository.AssignableUsers
	for _, u := range users.Nodes {
		key := strings.ToLower(u.Login)
		if u.Login == "" || key == author || seen[key] {
			continue
		}
		seen[key] = true
		others = append(others, ReviewerCandidate{ID: u.ID, Kind: ReviewerUser, Login: u.Login, Name: u.Name, AvatarURL: u.AvatarURL})
	}
	byLogin := func(a, b ReviewerCandidate) int {
		return strings.Compare(strings.ToLower(a.Login), strings.ToLower(b.Login))
	}
	slices.SortStableFunc(requested, byLogin)
	slices.SortStableFunc(others, byLogin)
	return ReviewerCandidates{Candidates: append(requested, others...), Truncated: users.TotalCount > len(users.Nodes)}, nil
}

// decodeRevert maps a RevertPullRequest mutation response.
func decodeRevert(data []byte) (RevertResult, error) {
	var d struct {
		RevertPullRequest *struct {
			RevertPullRequest *struct {
				Number int    `json:"number"`
				URL    string `json:"url"`
			} `json:"revertPullRequest"`
		} `json:"revertPullRequest"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return RevertResult{}, fmt.Errorf("decode revert: %w", err)
	}
	if d.RevertPullRequest == nil || d.RevertPullRequest.RevertPullRequest == nil || d.RevertPullRequest.RevertPullRequest.Number == 0 {
		return RevertResult{}, fmt.Errorf("decode revert: no pull request in the response")
	}
	r := d.RevertPullRequest.RevertPullRequest
	return RevertResult{Number: r.Number, URL: r.URL}, nil
}

// mergeOutcome is a MergePullRequest mutation's pull request afterwards.
type mergeOutcome struct {
	Merged bool
	State  PullRequestState
	SHA    string
}

// decodeMerge maps a MergePullRequest mutation response.
func decodeMerge(data []byte) (mergeOutcome, error) {
	var d struct {
		MergePullRequest *struct {
			PullRequest *struct {
				Merged      bool             `json:"merged"`
				State       PullRequestState `json:"state"`
				MergeCommit *oidJSON         `json:"mergeCommit"`
			} `json:"pullRequest"`
		} `json:"mergePullRequest"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return mergeOutcome{}, fmt.Errorf("decode merge: %w", err)
	}
	if d.MergePullRequest == nil || d.MergePullRequest.PullRequest == nil {
		return mergeOutcome{}, fmt.Errorf("decode merge: no pull request in the response")
	}
	p := d.MergePullRequest.PullRequest
	out := mergeOutcome{Merged: p.Merged, State: p.State}
	if p.MergeCommit != nil {
		out.SHA = p.MergeCommit.Oid
	}
	return out, nil
}

// decodeRequestedReviewers maps the REST pull request a requested_reviewers POST or
// DELETE returns to the pending requests: user logins and "org/team" (org is the base
// repository's owner, or owner; REST teams carry no organization).
func decodeRequestedReviewers(body []byte, owner string) ([]string, error) {
	var d struct {
		RequestedReviewers []struct {
			Login string `json:"login"`
		} `json:"requested_reviewers"`
		RequestedTeams []struct {
			Slug string `json:"slug"`
		} `json:"requested_teams"`
		Base struct {
			Repo struct {
				Owner loginJSON `json:"owner"`
			} `json:"repo"`
		} `json:"base"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return nil, fmt.Errorf("decode requested reviewers: %w", err)
	}
	owner = cmp.Or(d.Base.Repo.Owner.Login, owner)
	out := []string{}
	for _, u := range d.RequestedReviewers {
		out = append(out, u.Login)
	}
	for _, t := range d.RequestedTeams {
		out = append(out, owner+"/"+t.Slug)
	}
	return out, nil
}
