package gh

import (
	"fmt"
	"strings"
)

// fakeReview is the fake GitHub's review and comment state: the mutations received and
// a refusal every one of them gets.
type fakeReview struct {
	calls []fakeReviewCall
	// refusalMsg, when set, is the GraphQL error every review and comment gets, with
	// the type refusal (empty: no type).
	refusal, refusalMsg string
}

// fakeReviewCall is one mutation: op, the subject's node id, the event (reviews), and
// the body (nil: sent as null).
type fakeReviewCall struct {
	op, id, event string
	body          any
}

func (g *fakeGitHub) refuseReviews(errType, msg string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.review.refusal, g.review.refusalMsg = errType, msg
}

func (g *fakeGitHub) reviewCalls() []fakeReviewCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]fakeReviewCall(nil), g.review.calls...)
}

// reviewOp answers AddPullRequestReview and AddComment like GitHub: refusals are parts
// next to a null payload; the viewer cannot approve or request changes on their own
// pull request. A comment shows up in the next PullRequestFull. Called with g.mu held.
func (g *fakeGitHub) reviewOp(op string, vars map[string]any, data map[string]any, errs *[]map[string]any) {
	delete(data, "rateLimit") // the mutations do not select it
	field := map[string]string{"AddPullRequestReview": "addPullRequestReview", "AddComment": "addComment"}[op]
	id := vars["id"].(string)
	event, _ := vars["event"].(string)
	g.review.calls = append(g.review.calls, fakeReviewCall{op: op, id: id, event: event, body: vars["body"]})
	refuse := func(errType, msg string) {
		data[field] = nil
		e := map[string]any{"path": []any{field}, "message": msg}
		if errType != "" {
			e["type"] = errType
		}
		*errs = append(*errs, e)
	}
	p, ok := g.prs[id]
	n := len(g.review.calls)
	switch {
	case g.review.refusalMsg != "":
		refuse(g.review.refusal, g.review.refusalMsg)
	case !ok:
		refuse("NOT_FOUND", fmt.Sprintf("Could not resolve to a node with the global id of '%s'", id))
	case op == "AddComment":
		body := vars["body"].(string)
		if g.detail.comments == nil {
			g.detail.comments = map[string][]string{}
		}
		g.detail.comments[id] = append(g.detail.comments[id], body)
		data[field] = map[string]any{"commentEdge": map[string]any{"node": map[string]any{
			"id": fmt.Sprintf("IC_%d", n), "url": fmt.Sprintf("https://github.com/%s/pull/%d#issuecomment-%d", p.Repo, p.Number, n),
			"createdAt": "2026-10-15T12:00:00Z"}}}
	case event != "COMMENT" && p.Author == g.viewer.Login:
		verb := map[string]string{"APPROVE": "approve", "REQUEST_CHANGES": "request changes on"}[event]
		refuse("UNPROCESSABLE", "Review Can not "+verb+" your own pull request")
	default:
		state := map[string]string{"APPROVE": "APPROVED", "REQUEST_CHANGES": "CHANGES_REQUESTED", "COMMENT": "COMMENTED"}[event]
		data[field] = map[string]any{"pullRequestReview": map[string]any{
			"id": fmt.Sprintf("PRR_%d", n), "url": fmt.Sprintf("https://github.com/%s/pull/%d#pullrequestreview-%d", p.Repo, p.Number, n),
			"state": state, "submittedAt": "2026-10-15T12:00:00Z", "author": map[string]any{"login": strings.ToLower(g.viewer.Login)}}}
	}
}
