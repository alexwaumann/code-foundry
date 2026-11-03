package gh

import "strings"

// fakeState is the fake GitHub's draft and auto-merge state beyond the pull requests:
// whether the repository allows auto-merge, the method of each enabled auto-merge (the
// enabled set is fakeMerge.autoMerge), the pull requests GitHub could merge right away
// ("clean status"), the mutations asked for, and a refusal every one gets.
type fakeState struct {
	autoMergeOff bool              // the repository does not allow auto-merge
	methods      map[string]string // auto-merge method by PR id
	clean        map[string]bool   // by PR id
	calls        []fakeStateCall
	// refusalMsg, when set, is the GraphQL error every state mutation gets, with the
	// type refusal.
	refusal, refusalMsg string
}

type fakeStateCall struct{ op, id, method, head string }

func (g *fakeGitHub) disallowAutoMerge() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.detail.state.autoMergeOff = true
}

func (g *fakeGitHub) setClean(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.detail.state.clean == nil {
		g.detail.state.clean = map[string]bool{}
	}
	g.detail.state.clean[id] = true
}

func (g *fakeGitHub) setAutoMerge(id, method string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.setAutoMergeLocked(id, method)
}

func (g *fakeGitHub) setAutoMergeLocked(id, method string) {
	if g.detail.merge.autoMerge == nil {
		g.detail.merge.autoMerge = map[string]bool{}
	}
	if g.detail.state.methods == nil {
		g.detail.state.methods = map[string]string{}
	}
	g.detail.merge.autoMerge[id] = method != ""
	g.detail.state.methods[id] = method
}

func (g *fakeGitHub) refuseStateChanges(errType, msg string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.detail.state.refusal, g.detail.state.refusalMsg = errType, msg
}

func (g *fakeGitHub) stateCalls() []fakeStateCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]fakeStateCall(nil), g.detail.state.calls...)
}

// autoMergeJSON is a pull request's autoMergeRequest. Called with g.mu held.
func (g *fakeGitHub) autoMergeJSON(id string) any {
	if !g.detail.merge.autoMerge[id] {
		return nil
	}
	return map[string]any{"enabledAt": "2026-10-08T12:00:00Z", "mergeMethod": cmpString(g.detail.state.methods[id], "MERGE")}
}

// stateOp answers MarkReadyForReview, ConvertToDraft, EnableAutoMerge and
// DisableAutoMerge like GitHub: refusals are parts next to a null payload. Called with
// g.mu held.
func (g *fakeGitHub) stateOp(op string, vars map[string]any, data map[string]any, errs *[]map[string]any) {
	delete(data, "rateLimit") // the mutations do not select it
	field := map[string]string{
		"MarkReadyForReview": "markPullRequestReadyForReview", "ConvertToDraft": "convertPullRequestToDraft",
		"EnableAutoMerge": "enablePullRequestAutoMerge", "DisableAutoMerge": "disablePullRequestAutoMerge",
	}[op]
	id := vars["id"].(string)
	method, _ := vars["method"].(string)
	head, _ := vars["head"].(string)
	st := &g.detail.state
	st.calls = append(st.calls, fakeStateCall{op, id, method, head})
	refuse := func(errType, msg string) {
		data[field] = nil
		e := map[string]any{"path": []any{field}, "message": msg}
		if errType != "" {
			e["type"] = errType
		}
		*errs = append(*errs, e)
	}
	p, ok := g.prs[id]
	switch {
	case st.refusalMsg != "":
		refuse(st.refusal, st.refusalMsg)
		return
	case !ok:
		refuse("NOT_FOUND", "Could not resolve to a node with the global id of '"+id+"'")
		return
	case p.State != PullRequestOpen:
		refuse("UNPROCESSABLE", "Pull request is "+strings.ToLower(string(p.State)))
		return
	}
	switch op {
	case "MarkReadyForReview":
		p.Draft = false
		data[field] = map[string]any{"pullRequest": map[string]any{"isDraft": false}}
	case "ConvertToDraft":
		p.Draft = true
		data[field] = map[string]any{"pullRequest": map[string]any{"isDraft": true}}
	case "EnableAutoMerge":
		switch {
		case st.autoMergeOff:
			refuse("UNPROCESSABLE", "Pull request Auto merge is not allowed for this repository")
		case p.HeadSHA != head:
			refuse("UNPROCESSABLE", "Head branch was modified. Review and try the merge again.")
		case st.clean[id]:
			refuse("UNPROCESSABLE", "Pull request Pull request is in clean status")
		default:
			g.setAutoMergeLocked(id, method)
			data[field] = map[string]any{"pullRequest": map[string]any{"autoMergeRequest": g.autoMergeJSON(id)}}
		}
	case "DisableAutoMerge":
		g.setAutoMergeLocked(id, "")
		data[field] = map[string]any{"pullRequest": map[string]any{"autoMergeRequest": nil}}
	}
}
