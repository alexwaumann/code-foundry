package gh

import "fmt"

// fakeBody is the fake GitHub's description reads and writes for
// SetPullRequestCheckbox: the operations in order ("read id", "write id"), the bodies
// written, and a refusal every write gets.
type fakeBody struct {
	ops     []string
	written []string
	// refusalMsg, when set, is the GraphQL error every write gets, with the type refusal.
	refusal, refusalMsg string
}

func (g *fakeGitHub) refuseBodyWrites(errType, msg string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.detail.bodies.refusal, g.detail.bodies.refusalMsg = errType, msg
}

func (g *fakeGitHub) bodyOps() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.detail.bodies.ops...)
}

func (g *fakeGitHub) bodiesWritten() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.detail.bodies.written...)
}

func (g *fakeGitHub) body(id string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.detail.body[id]
}

// bodyOp answers PullRequestBody and UpdatePullRequestBody like GitHub: a description
// can be edited in any state, and refusals are parts next to a null payload. Called with
// g.mu held.
func (g *fakeGitHub) bodyOp(op string, vars map[string]any, data map[string]any, errs *[]map[string]any) {
	st := &g.detail.bodies
	if op == "PullRequestBody" {
		owner, name, number := vars["owner"].(string), vars["name"].(string), vars["number"].(int)
		p := g.findPR(owner, name, number)
		if p == nil {
			data["repository"] = map[string]any{"pullRequest": nil}
			*errs = append(*errs, map[string]any{"type": "NOT_FOUND", "path": []any{"repository"},
				"message": fmt.Sprintf("Could not resolve to a PullRequest with the number of %d.", number)})
			return
		}
		st.ops = append(st.ops, "read "+p.ID)
		var body any
		if b, ok := g.detail.body[p.ID]; ok {
			body = b // GitHub's null for one that was never set
		}
		data["repository"] = map[string]any{"pullRequest": map[string]any{"id": p.ID, "body": body}}
		return
	}
	delete(data, "rateLimit") // the mutation does not select it
	id, body := vars["id"].(string), vars["body"].(string)
	st.ops = append(st.ops, "write "+id)
	if st.refusalMsg != "" {
		data["updatePullRequest"] = nil
		e := map[string]any{"path": []any{"updatePullRequest"}, "message": st.refusalMsg}
		if st.refusal != "" {
			e["type"] = st.refusal
		}
		*errs = append(*errs, e)
		return
	}
	st.written = append(st.written, body)
	if g.detail.body == nil {
		g.detail.body = map[string]string{}
	}
	g.detail.body[id] = body
	data["updatePullRequest"] = map[string]any{"pullRequest": map[string]any{"id": id}}
}
