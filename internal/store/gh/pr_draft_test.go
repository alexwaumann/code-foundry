package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
)

// The fake's pull requests (mergeWorld): #1 open, #2 draft, #3 merged, all on o/r.

func TestSetPullRequestDraft(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name   string
		number int
		draft  bool
		setup  func(g *fakeGitHub, s *Store)
		want   DraftResult
		err    error
		errHas string
		// calls are the mutations sent ("op id").
		calls []string
	}{
		{name: "a draft marked ready", number: 2,
			want: DraftResult{Message: "Marked #2 ready for review"}, calls: []string{"MarkReadyForReview PR_2"}},
		{name: "an open one converted to a draft", number: 1, draft: true,
			want: DraftResult{Draft: true, Message: "Converted #1 to a draft"}, calls: []string{"ConvertToDraft PR_1"}},
		{name: "already ready: refused, no mutation", number: 1,
			err: ErrFailedPrecondition, errHas: "pull request #1 is already ready for review"},
		{name: "already a draft: refused, no mutation", number: 2, draft: true,
			err: ErrFailedPrecondition, errHas: "pull request #2 is already a draft"},
		{name: "merged: refused, no mutation", number: 3, draft: true,
			err: ErrFailedPrecondition, errHas: "pull request #3 is merged, not open"},
		{name: "the cache would refuse, a fresh look lets it through", number: 1,
			setup: func(g *fakeGitHub, s *Store) {
				if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
					t.Fatal(err)
				}
				g.edit("PR_1", func(p *PullRequest) { p.Draft = true })
			},
			want: DraftResult{Message: "Marked #1 ready for review"}, calls: []string{"MarkReadyForReview PR_1"}},
		{name: "FORBIDDEN is permission denied", number: 2,
			setup: func(g *fakeGitHub, _ *Store) {
				g.refuseStateChanges("FORBIDDEN", "Resource not accessible by integration")
			},
			err: ErrPermissionDenied, errHas: "Resource not accessible", calls: []string{"MarkReadyForReview PR_2"}},
		{name: "another refusal is a failed precondition with GitHub's message", number: 1, draft: true,
			setup: func(g *fakeGitHub, _ *Store) { g.refuseStateChanges("UNPROCESSABLE", "Pull request is locked") },
			err:   ErrFailedPrecondition, errHas: "Pull request is locked", calls: []string{"ConvertToDraft PR_1"}},
		{name: "unknown pull request", number: 99, err: ErrNotFound},
		{name: "bad number", number: 0, err: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, _, s, _, events := mergeWorld(t)
			if tt.setup != nil {
				tt.setup(g, s)
			}
			drain(events)
			got, err := s.SetPullRequestDraft(ctx, "o/r", tt.number, tt.draft)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %v, want %v containing %q", err, tt.err, tt.errHas)
				}
			} else if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
			if got := stateCallStrings(g); !slices.Equal(got, tt.calls) {
				t.Errorf("mutations = %q, want %q", got, tt.calls)
			}
			// A change, and GitHub refusing one in the pull request's state, tell clients
			// to re-read.
			if want := tt.err == nil || (len(tt.calls) > 0 && errors.Is(tt.err, ErrFailedPrecondition)); want != (drain(events) > 0) {
				t.Errorf("detail event sent = %t, want %t", !want, want)
			}
			if tt.err != nil {
				return
			}
			// The next read fetches: the detail shows the new state.
			d, err := s.FullPullRequest(ctx, "o/r", tt.number, false)
			if err != nil || d.PullRequest.Draft != tt.draft {
				t.Errorf("detail draft = %t, %v; want %t", d.PullRequest.Draft, err, tt.draft)
			}
		})
	}
}

// A caller that stops waiting while the mutation is in flight still leaves clients
// re-reading once it lands.
func TestSetPullRequestDraftCallerLeaves(t *testing.T) {
	g, w, s, _, events := mergeWorld(t)
	if _, err := s.FullPullRequest(context.Background(), "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	w.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		if op == "ConvertToDraft" {
			once.Do(func() { close(started) })
			<-release
		}
		return g.respond(op, doc, vars)
	})
	drain(events)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := s.SetPullRequestDraft(ctx, "o/r", 1, true)
		done <- err
	}()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	close(release)
	// The worker runs one job at a time: this one ends after the mutation's.
	if _, err := submitFunc(context.Background(), s, "after-draft", func(context.Context) (struct{}, error) { return struct{}{}, nil }); err != nil {
		t.Fatal(err)
	}
	if drain(events) == 0 {
		t.Error("no detail event after the change")
	}
	if _, stale, ok := s.full.get(fullKey{"o/r", 1}); !ok || !stale {
		t.Errorf("cached detail stale = %t (cached %t), want stale", stale, ok)
	}
}

func TestSetPullRequestAutoMerge(t *testing.T) {
	ctx := context.Background()
	head1 := fmt.Sprintf("%040d", 1)
	tests := []struct {
		name   string
		number int
		req    AutoMergeChange
		setup  func(g *fakeGitHub, s *Store)
		want   AutoMergeResult
		err    error
		errHas string
		calls  []string // "op id method head"
	}{
		{name: "on with squash, guarded by the cached head", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeSquash},
			want:  AutoMergeResult{Enabled: true, Method: MergeSquash, Message: "Auto-merge on for #1: GitHub merges it with squash once its requirements pass"},
			calls: []string{"EnableAutoMerge PR_1 SQUASH " + head1}},
		{name: "on with the shown head", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeCommit, ExpectedHeadSHA: head1},
			want:  AutoMergeResult{Enabled: true, Method: MergeCommit, Message: "Auto-merge on for #1: GitHub merges it with a merge commit once its requirements pass"},
			calls: []string{"EnableAutoMerge PR_1 MERGE " + head1}},
		{name: "off", number: 1, req: AutoMergeChange{},
			setup: func(g *fakeGitHub, _ *Store) { g.setAutoMerge("PR_1", "REBASE") },
			want:  AutoMergeResult{Message: "Auto-merge off for #1"}, calls: []string{"DisableAutoMerge PR_1  "}},
		{name: "off when it is off: refused, no mutation", number: 1, req: AutoMergeChange{},
			err: ErrFailedPrecondition, errHas: "pull request #1 does not have auto-merge on"},
		{name: "on when it is on with that method: refused", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeRebase},
			setup: func(g *fakeGitHub, _ *Store) { g.setAutoMerge("PR_1", "REBASE") },
			err:   ErrFailedPrecondition, errHas: "already has auto-merge on with rebase"},
		{name: "on with another method: refused, off first", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *Store) { g.setAutoMerge("PR_1", "REBASE") },
			err:   ErrFailedPrecondition, errHas: "already has auto-merge on with rebase; turn it off first to merge with squash"},
		{name: "the repository does not allow auto-merge: refused, no mutation", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *Store) { g.disallowAutoMerge() },
			err:   ErrFailedPrecondition, errHas: "cannot use auto-merge: the repository does not allow it"},
		{name: "a method the repository disallows: refused", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeRebase},
			setup: func(g *fakeGitHub, _ *Store) { g.disallowMerge(MergeRebase) },
			err:   ErrFailedPrecondition, errHas: "cannot be merged with rebase"},
		{name: "a draft: refused", number: 2, req: AutoMergeChange{Enabled: true, Method: MergeSquash},
			err: ErrFailedPrecondition, errHas: "is a draft; mark it ready for review first"},
		{name: "merged: refused", number: 3, req: AutoMergeChange{Enabled: true, Method: MergeSquash},
			err: ErrFailedPrecondition, errHas: "is merged, not open"},
		{name: "mergeable now: GitHub's clean status says merge instead", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *Store) { g.setClean("PR_1") },
			err:   ErrFailedPrecondition, errHas: "can be merged now, so GitHub will not wait to auto-merge it (Pull request Pull request is in clean status); merge it instead",
			calls: []string{"EnableAutoMerge PR_1 SQUASH " + head1}},
		{name: "the shown head is not GitHub's: refused, no mutation", number: 1,
			req: AutoMergeChange{Enabled: true, Method: MergeSquash, ExpectedHeadSHA: strings.Repeat("a", 40)},
			err: ErrFailedPrecondition, errHas: "changed since it was shown"},
		{name: "head moved since the detail was fetched: GitHub refuses", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeSquash},
			setup: func(g *fakeGitHub, s *Store) {
				if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
					t.Fatal(err)
				}
				g.edit("PR_1", func(p *PullRequest) { p.HeadSHA = "pushed-since" })
			},
			err: ErrFailedPrecondition, errHas: "changed on GitHub since it was loaded",
			calls: []string{"EnableAutoMerge PR_1 SQUASH " + head1}},
		{name: "FORBIDDEN is permission denied", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *Store) {
				g.refuseStateChanges("FORBIDDEN", "Resource not accessible by integration")
			},
			err: ErrPermissionDenied, calls: []string{"EnableAutoMerge PR_1 SQUASH " + head1}},
		{name: "no method to turn it on", number: 1, req: AutoMergeChange{Enabled: true}, err: ErrInvalidArgument},
		{name: "expected head not a full SHA", number: 1, req: AutoMergeChange{Enabled: true, Method: MergeSquash, ExpectedHeadSHA: "abc"},
			err: ErrInvalidArgument, errHas: "not a full commit SHA"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, _, s, _, events := mergeWorld(t)
			if tt.setup != nil {
				tt.setup(g, s)
			}
			drain(events)
			got, err := s.SetPullRequestAutoMerge(ctx, "o/r", tt.number, tt.req)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %v, want %v containing %q", err, tt.err, tt.errHas)
				}
			} else if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
			if got := stateCallStrings(g); !slices.Equal(got, tt.calls) {
				t.Errorf("mutations = %q, want %q", got, tt.calls)
			}
			moved := tt.req.ExpectedHeadSHA != "" && errors.Is(tt.err, ErrFailedPrecondition)
			if want := tt.err == nil || moved || (len(tt.calls) > 0 && errors.Is(tt.err, ErrFailedPrecondition)); want != (drain(events) > 0) {
				t.Errorf("detail event sent = %t, want %t", !want, want)
			}
			if tt.err != nil {
				return
			}
			d, err := s.FullPullRequest(ctx, "o/r", tt.number, false)
			if err != nil || d.AutoMerge != tt.req.Enabled || d.AutoMergeMethod != tt.req.Method || !d.AutoMergeAllowed {
				t.Errorf("detail auto-merge %t %q allowed %t, %v; want %t %q", d.AutoMerge, d.AutoMergeMethod, d.AutoMergeAllowed, err, tt.req.Enabled, tt.req.Method)
			}
		})
	}
}

func stateCallStrings(g *fakeGitHub) []string {
	var out []string
	for _, c := range g.stateCalls() {
		s := c.op + " " + c.id
		if strings.HasSuffix(c.op, "AutoMerge") {
			s += " " + c.method + " " + c.head
		}
		out = append(out, s)
	}
	return out
}

func TestDecodeAutoMergeFields(t *testing.T) {
	tests := []struct {
		name, repo, pr string
		allowed, on    bool
		method         MergeMethod
	}{
		{name: "allowed, on with squash", repo: `"autoMergeAllowed":true`,
			pr: `"autoMergeRequest":{"enabledAt":"2026-10-09T10:00:00Z","mergeMethod":"SQUASH"},`, allowed: true, on: true, method: MergeSquash},
		{name: "allowed, off", repo: `"autoMergeAllowed":true`, pr: `"autoMergeRequest":null,`, allowed: true},
		{name: "not allowed", repo: `"autoMergeAllowed":false`},
		{name: "a capture from before the field: unknown is not allowed", repo: `"viewerCanAdminister":false`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc := `{"repository":{` + tt.repo + `,"pullRequest":{` + tt.pr + `"number":7,"state":"OPEN"}}}`
			d, _, err := decodeFullPullRequest([]byte(doc))
			if err != nil || d.AutoMergeAllowed != tt.allowed || d.AutoMerge != tt.on || d.AutoMergeMethod != tt.method {
				t.Errorf("allowed %t, on %t, method %q, %v; want %t, %t, %q", d.AutoMergeAllowed, d.AutoMerge, d.AutoMergeMethod, err, tt.allowed, tt.on, tt.method)
			}
		})
	}
}

func TestDecodeStateMutations(t *testing.T) {
	if r, err := decodeDraft([]byte(`{"convertPullRequestToDraft":{"pullRequest":{"isDraft":true}}}`), true); err != nil || !r.Draft {
		t.Errorf("convert: %+v, %v", r, err)
	}
	if _, err := decodeDraft([]byte(`{"markPullRequestReadyForReview":null}`), false); err == nil {
		t.Error("null ready payload: want an error")
	}
	if r, err := decodeAutoMerge([]byte(`{"enablePullRequestAutoMerge":{"pullRequest":{"autoMergeRequest":{"mergeMethod":"REBASE"}}}}`), true); err != nil || !r.Enabled || r.Method != MergeRebase {
		t.Errorf("enable: %+v, %v", r, err)
	}
	if r, err := decodeAutoMerge([]byte(`{"disablePullRequestAutoMerge":{"pullRequest":{"autoMergeRequest":null}}}`), false); err != nil || r.Enabled {
		t.Errorf("disable: %+v, %v", r, err)
	}
	if _, err := decodeAutoMerge([]byte(`{`), true); err == nil {
		t.Error("not JSON: want an error")
	}
}
