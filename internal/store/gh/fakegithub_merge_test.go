package gh

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// fakeMerge is the fake GitHub's merge button state: which methods the repository
// disallows, auto-merge, the merges asked for, and a refusal every merge gets.
type fakeMerge struct {
	disallowed map[MergeMethod]bool
	autoMerge  map[string]bool // by PR id
	calls      []fakeMergeCall
	// refusalMsg, when set, is the GraphQL error every MergePullRequest gets, with the
	// type refusal (FORBIDDEN: the viewer cannot push; empty: no type).
	refusal, refusalMsg string
}

type fakeMergeCall struct{ id, method, head string }

func (g *fakeGitHub) disallowMerge(m MergeMethod) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.detail.merge.disallowed == nil {
		g.detail.merge.disallowed = map[MergeMethod]bool{}
	}
	g.detail.merge.disallowed[m] = true
}

func (g *fakeGitHub) refuseMerges(errType, msg string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.detail.merge.refusal, g.detail.merge.refusalMsg = errType, msg
}

func (g *fakeGitHub) merges() []fakeMergeCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]fakeMergeCall(nil), g.detail.merge.calls...)
}

// mergeSettings adds the repository's merge settings to a PullRequestFull repository.
// Called with g.mu held.
func (g *fakeGitHub) mergeSettings(repo map[string]any) {
	d := g.detail.merge.disallowed
	repo["mergeCommitAllowed"] = !d[MergeCommit]
	repo["squashMergeAllowed"] = !d[MergeSquash]
	repo["rebaseMergeAllowed"] = !d[MergeRebase]
	if pr, ok := repo["pullRequest"].(map[string]any); ok {
		pr["autoMergeRequest"] = nil
		if id, _ := pr["id"].(string); g.detail.merge.autoMerge[id] {
			pr["autoMergeRequest"] = map[string]any{"enabledAt": "2026-10-08T12:00:00Z"}
		}
	}
}

// mergeOp answers MergePullRequest like GitHub: refusals are UNPROCESSABLE parts next
// to a null payload; a head other than expectedHeadOid is "Head branch was modified".
// Called with g.mu held.
func (g *fakeGitHub) mergeOp(vars map[string]any, data map[string]any, errs *[]map[string]any) {
	delete(data, "rateLimit") // the mutation does not select it
	id, method, head := vars["id"].(string), vars["method"].(string), vars["head"].(string)
	g.detail.merge.calls = append(g.detail.merge.calls, fakeMergeCall{id, method, head})
	refuse := func(errType, msg string) {
		data["mergePullRequest"] = nil
		e := map[string]any{"path": []any{"mergePullRequest"}, "message": msg}
		if errType != "" {
			e["type"] = errType
		}
		*errs = append(*errs, e)
	}
	p, ok := g.prs[id]
	switch {
	case g.detail.merge.refusalMsg != "":
		refuse(g.detail.merge.refusal, g.detail.merge.refusalMsg)
	case !ok || p.State != PullRequestOpen:
		refuse("UNPROCESSABLE", "Pull Request is not mergeable")
	case p.Draft:
		refuse("UNPROCESSABLE", "Pull Request is still a draft")
	case p.HeadSHA != head:
		refuse("UNPROCESSABLE", "Head branch was modified. Review and try the merge again.")
	case g.detail.merge.disallowed[MergeMethod(method)]:
		refuse("UNPROCESSABLE", "Merge method "+strings.ToLower(method)+" merging is not allowed on this repository")
	default:
		p.State, p.MergedAt = PullRequestMerged, time.Now()
		data["mergePullRequest"] = map[string]any{"pullRequest": map[string]any{
			"merged": true, "state": "MERGED", "mergeCommit": map[string]any{"oid": "5e1f" + strings.Repeat("0", 36)}}}
	}
}

// restCall is one REST write a fakeWriter received.
type restCall struct {
	method, path string
	body         any
}

// fakeWriter is a fakeRunner that also sends REST writes (RESTWriter): it records them
// and answers with answer (nil: 204 No Content).
type fakeWriter struct {
	*fakeRunner
	mu     sync.Mutex
	writes []restCall
	answer func(method, path string) error
}

func (w *fakeWriter) RESTWrite(_ context.Context, method, path string, body any) (json.RawMessage, error) {
	w.mu.Lock()
	w.writes = append(w.writes, restCall{method, path, body})
	answer := w.answer
	w.mu.Unlock()
	if answer != nil {
		if err := answer(method, path); err != nil {
			return nil, err
		}
	}
	return nil, nil
}

func (w *fakeWriter) calls() []restCall {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]restCall(nil), w.writes...)
}

func (w *fakeWriter) setAnswer(f func(method, path string) error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.answer = f
}
