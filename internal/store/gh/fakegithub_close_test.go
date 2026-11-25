package gh

import "time"

// fakeClose is whether the viewer may close and reopen pull requests: GitHub's
// viewerCanClose (any state) and viewerCanReopen (closed only).
type fakeClose struct {
	denied bool // the viewer may neither close nor reopen
}

func (g *fakeGitHub) denyClose(denied bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.detail.close.denied = denied
}

// closeSettings adds viewerCanClose and viewerCanReopen to a PullRequestFull pull
// request. Called with g.mu held.
func (g *fakeGitHub) closeSettings(p *PullRequest, repo map[string]any) {
	if pr, ok := repo["pullRequest"].(map[string]any); ok {
		pr["viewerCanClose"] = !g.detail.close.denied
		pr["viewerCanReopen"] = !g.detail.close.denied && p.State == PullRequestClosed
	}
}

// closeOp answers ClosePullRequest and ReopenPullRequest like GitHub: refusals are parts
// next to a null payload. The calls and the refusal every one gets are fakeState's
// (fakegithub_draft_test.go). Called with g.mu held.
func (g *fakeGitHub) closeOp(op string, vars map[string]any, data map[string]any, errs *[]map[string]any) {
	delete(data, "rateLimit") // the mutations do not select it
	field := map[string]string{"ClosePullRequest": "closePullRequest", "ReopenPullRequest": "reopenPullRequest"}[op]
	id := vars["id"].(string)
	st := &g.detail.state
	st.calls = append(st.calls, fakeStateCall{op: op, id: id})
	refuse := func(errType, msg string) {
		data[field] = nil
		*errs = append(*errs, map[string]any{"path": []any{field}, "message": msg, "type": errType})
	}
	p, ok := g.prs[id]
	switch {
	case st.refusalMsg != "":
		refuse(st.refusal, st.refusalMsg)
		return
	case !ok:
		refuse("NOT_FOUND", "Could not resolve to a node with the global id of '"+id+"'")
		return
	case g.detail.close.denied:
		refuse("FORBIDDEN", "Resource not accessible by integration")
		return
	case op == "ClosePullRequest" && p.State == PullRequestOpen:
		p.State = PullRequestClosed
	case op == "ReopenPullRequest" && p.State == PullRequestClosed:
		p.State = PullRequestOpen
	default:
		// GitHub answers a close of a closed pull request with it as it is; reopening a
		// merged one is refused.
		if p.State == PullRequestMerged && op == "ReopenPullRequest" {
			refuse("UNPROCESSABLE", "Could not open the pull request.")
			return
		}
	}
	var closedAt any
	if p.State == PullRequestClosed {
		closedAt = time.Now().UTC().Format(time.RFC3339)
	}
	updatedAt := p.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = time.Now().UTC()
	}
	data[field] = map[string]any{"pullRequest": map[string]any{
		"state":           string(p.State),
		"closedAt":        closedAt,
		"updatedAt":       updatedAt.UTC().Format(time.RFC3339),
		"viewerCanClose":  !g.detail.close.denied,
		"viewerCanReopen": !g.detail.close.denied && p.State == PullRequestClosed,
	}}
}
