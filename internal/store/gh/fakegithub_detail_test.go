package gh

import (
	"fmt"
	"strings"
	"time"
)

// fakeDetail is what the fake knows beyond the polled fields, for PullRequestFull,
// ReviewerCandidates, and RevertPullRequest. Pull requests come from fakeGitHub.prs.
type fakeDetail struct {
	permission string            // viewerPermission; "WRITE" when empty
	body       map[string]string // by PR id
	comments   map[string][]string
	assignable []ReviewerCandidate
	reverted   []string // PR ids the RevertPullRequest mutation was called for
}

func (g *fakeGitHub) setBody(id, body string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.detail.body == nil {
		g.detail.body = map[string]string{}
	}
	g.detail.body[id] = body
}

func (g *fakeGitHub) addComment(id, body string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.detail.comments == nil {
		g.detail.comments = map[string][]string{}
	}
	g.detail.comments[id] = append(g.detail.comments[id], body)
}

func (g *fakeGitHub) reverts() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.detail.reverted...)
}

// findPR returns the pull request with number in owner/name. Called with g.mu held.
func (g *fakeGitHub) findPR(owner, name string, number int) *PullRequest {
	for _, p := range g.prs {
		if p.Repo == owner+"/"+name && p.Number == number {
			return p
		}
	}
	return nil
}

func (g *fakeGitHub) detailOp(op string, vars map[string]any, data map[string]any, errs *[]map[string]any) {
	notFound := func(alias, msg string) {
		*errs = append(*errs, map[string]any{"type": "NOT_FOUND", "path": []any{alias}, "message": msg})
	}
	switch op {
	case "PullRequestFull":
		owner, name, number := vars["owner"].(string), vars["name"].(string), vars["number"].(int)
		p := g.findPR(owner, name, number)
		perm := cmpString(g.detail.permission, "WRITE")
		if p == nil {
			data["repository"] = map[string]any{"viewerPermission": perm, "pullRequest": nil}
			notFound("repository", fmt.Sprintf("Could not resolve to a PullRequest with the number of %d.", number))
			return
		}
		data["repository"] = map[string]any{"viewerPermission": perm, "pullRequest": g.fullJSON(p)}
	case "ReviewerCandidates":
		owner, name, number := vars["owner"].(string), vars["name"].(string), vars["number"].(int)
		p := g.findPR(owner, name, number)
		users := []any{}
		for _, u := range g.detail.assignable {
			users = append(users, map[string]any{"id": u.ID, "login": u.Login, "name": u.Name, "avatarUrl": u.AvatarURL})
		}
		repo := map[string]any{"assignableUsers": map[string]any{"totalCount": len(users), "nodes": users}, "pullRequest": nil}
		if p != nil {
			repo["pullRequest"] = map[string]any{"author": map[string]any{"login": p.Author}, "reviewRequests": requestsJSON(p)}
		}
		data["repository"] = repo
	case "RevertPullRequest":
		delete(data, "rateLimit") // the mutation does not select it
		id := vars["id"].(string)
		p, ok := g.prs[id]
		if !ok || p.State != PullRequestMerged {
			data["revertPullRequest"] = nil
			*errs = append(*errs, map[string]any{"type": "UNPROCESSABLE", "path": []any{"revertPullRequest"},
				"message": "Pull request is not merged"})
			return
		}
		g.detail.reverted = append(g.detail.reverted, id)
		n := 900 + len(g.detail.reverted)
		data["revertPullRequest"] = map[string]any{"revertPullRequest": map[string]any{
			"number": n, "url": fmt.Sprintf("https://github.com/%s/pull/%d", p.Repo, n)}}
	}
}

func requestsJSON(p *PullRequest) map[string]any {
	nodes := []any{}
	for _, r := range p.ReviewRequests {
		if org, team, ok := strings.Cut(r, "/"); ok {
			nodes = append(nodes, map[string]any{"requestedReviewer": map[string]any{"__typename": "Team", "id": "T_" + team,
				"slug": team, "name": team, "organization": map[string]any{"login": org}}})
		} else {
			nodes = append(nodes, map[string]any{"requestedReviewer": map[string]any{"__typename": "User", "id": "U_" + r, "login": r}})
		}
	}
	return map[string]any{"nodes": nodes}
}

// fullJSON renders p as pull_request_full.graphql's pullRequest.
func (g *fakeGitHub) fullJSON(p *PullRequest) map[string]any {
	m := prJSON(p)
	ts := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	m["body"] = g.detail.body[p.ID]
	if p.State == PullRequestMerged {
		m["closedAt"] = ts(p.MergedAt)
		m["mergeCommit"] = map[string]any{"oid": "merge-" + p.ID}
		m["mergedBy"] = map[string]any{"login": "octocat"}
	}
	m["labels"] = map[string]any{"totalCount": 1, "nodes": []any{map[string]any{"name": "bug", "color": "d73a4a"}}}
	reviewers := []any{}
	for _, r := range p.LatestReviews {
		reviewers = append(reviewers, map[string]any{"author": map[string]any{"__typename": "User", "login": r.Author},
			"state": r.State, "submittedAt": ts(r.SubmittedAt), "commit": map[string]any{"oid": p.HeadSHA}})
	}
	m["reviewers"] = map[string]any{"nodes": reviewers}
	m["requestedReviewers"] = requestsJSON(p)
	m["commits"] = map[string]any{"totalCount": 1, "nodes": []any{map[string]any{"commit": map[string]any{
		"oid": p.HeadSHA, "messageHeadline": "head of " + p.HeadRef, "committedDate": ts(p.UpdatedAt),
		"author": map[string]any{"name": "Octo Cat", "user": map[string]any{"login": p.Author}}}}}}
	comments := []any{}
	for i, body := range g.detail.comments[p.ID] {
		comments = append(comments, map[string]any{"id": fmt.Sprintf("IC_%s_%d", p.ID, i), "body": body,
			"author": map[string]any{"__typename": "User", "login": "kim"}, "createdAt": ts(p.CreatedAt.Add(time.Duration(i) * time.Minute)),
			"url": fmt.Sprintf("https://github.com/%s/pull/%d#issuecomment-%d", p.Repo, p.Number, i)})
	}
	m["issueComments"] = map[string]any{"totalCount": len(comments), "nodes": comments}
	m["reviewList"] = map[string]any{"totalCount": 0, "nodes": []any{}}
	m["reviewThreads"] = map[string]any{"totalCount": 0, "nodes": []any{}}
	if r := rollupOrNil(p.Checks); r != nil {
		rm := r.(map[string]any)
		ctx := rm["contexts"].(map[string]any)
		ctx["nodes"] = []any{}
		ctx["pageInfo"] = map[string]any{"hasNextPage": false, "endCursor": "x"}
		m["checks"] = rm
	}
	return m
}
