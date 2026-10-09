package gh

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// mergeWorld is the fake GitHub for merges: #1 open, #2 draft, #3 merged, #4 open from
// a fork, #5 open on a branch whose name needs escaping, #6 open from the default
// branch (main) into release, #7 open with release as head and base. All on o/r,
// whose default branch is main.
func mergeWorld(t *testing.T) (*fakeGitHub, *fakeWriter, *Store, *testClock, *bus.Subscription[PullRequestDetailUpdated]) {
	t.Helper()
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	g.addPR(fakePR("PR_1", "o/r", 1, t0), sectionAuthored)
	draft := fakePR("PR_2", "o/r", 2, t0)
	draft.Draft = true
	g.addPR(draft)
	merged := fakePR("PR_3", "o/r", 3, t0)
	merged.State, merged.MergedAt = PullRequestMerged, t0
	g.addPR(merged)
	fork := fakePR("PR_4", "o/r", 4, t0)
	fork.IsCrossRepository, fork.HeadRepoSlug = true, "someone/r"
	g.addPR(fork)
	odd := fakePR("PR_5", "o/r", 5, t0)
	odd.HeadRef = "feat/a#b"
	g.addPR(odd)
	fromMain := fakePR("PR_6", "o/r", 6, t0)
	fromMain.HeadRef, fromMain.BaseRef = "main", "release"
	g.addPR(fromMain)
	same := fakePR("PR_7", "o/r", 7, t0)
	same.HeadRef, same.BaseRef = "release", "release"
	g.addPR(same)
	w := &fakeWriter{fakeRunner: (&fakeRunner{}).serve(g)}
	clk := &testClock{}
	b := bus.New()
	events := bus.Subscribe[PullRequestDetailUpdated](b, 64)
	opts := testOptions(openTestDB(t), w, b)
	opts.Now = clk.now
	return g, w, startStore(t, opts), clk, events
}

func TestMergePullRequest(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name   string
		number int
		req    MergeRequest
		setup  func(g *fakeGitHub, w *fakeWriter, s *Store)
		// want: the result, or err (with errHas in its message).
		want   MergeResult
		err    error
		errHas string
		// mutations: MergePullRequest calls sent; writes: REST writes ("METHOD path").
		mutations int
		writes    []string
	}{
		{name: "squash, branch kept", number: 1, req: MergeRequest{Method: MergeSquash},
			want:      MergeResult{Merged: true, SHA: "5e1f" + strings.Repeat("0", 36), Message: "Merged #1 (5e1f000)"},
			mutations: 1},
		{name: "merge commit, branch deleted", number: 1, req: MergeRequest{Method: MergeCommit, DeleteBranch: true},
			want: MergeResult{Merged: true, SHA: "5e1f" + strings.Repeat("0", 36), BranchDeleted: true,
				Message: "Merged #1 (5e1f000); deleted origin/branch-1"},
			mutations: 1, writes: []string{"DELETE repos/o/r/git/refs/heads/branch-1"}},
		{name: "branch name escaped per segment", number: 5, req: MergeRequest{Method: MergeRebase, DeleteBranch: true},
			want: MergeResult{Merged: true, SHA: "5e1f" + strings.Repeat("0", 36), BranchDeleted: true,
				Message: "Merged #5 (5e1f000); deleted origin/feat/a#b"},
			mutations: 1, writes: []string{"DELETE repos/o/r/git/refs/heads/feat/a%23b"}},
		{name: "a fork's branch is never deleted", number: 4, req: MergeRequest{Method: MergeSquash, DeleteBranch: true},
			want: MergeResult{Merged: true, SHA: "5e1f" + strings.Repeat("0", 36),
				Message: "Merged #4 (5e1f000); kept branch-4: it is in a fork"},
			mutations: 1},
		{name: "branch GitHub already deleted counts as deleted", number: 1, req: MergeRequest{Method: MergeSquash, DeleteBranch: true},
			setup: func(_ *fakeGitHub, w *fakeWriter, _ *Store) {
				w.setAnswer(func(string, string) error {
					return fmt.Errorf("%w: Reference does not exist (HTTP 422)", ErrFailedPrecondition)
				})
			},
			want: MergeResult{Merged: true, SHA: "5e1f" + strings.Repeat("0", 36), BranchDeleted: true,
				Message: "Merged #1 (5e1f000); deleted origin/branch-1"},
			mutations: 1, writes: []string{"DELETE repos/o/r/git/refs/heads/branch-1"}},
		{name: "a failed delete keeps the merge", number: 1, req: MergeRequest{Method: MergeSquash, DeleteBranch: true},
			setup: func(_ *fakeGitHub, w *fakeWriter, _ *Store) {
				w.setAnswer(func(string, string) error { return fmt.Errorf("%w: Must have admin rights", ErrPermissionDenied) })
			},
			want: MergeResult{Merged: true, SHA: "5e1f" + strings.Repeat("0", 36),
				Message: "Merged #1 (5e1f000); kept origin/branch-1: permission denied on github: Must have admin rights"},
			mutations: 1, writes: []string{"DELETE repos/o/r/git/refs/heads/branch-1"}},
		{name: "head moved since the detail was fetched", number: 1, req: MergeRequest{Method: MergeSquash, DeleteBranch: true},
			setup: func(g *fakeGitHub, _ *fakeWriter, s *Store) {
				if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
					t.Fatal(err)
				}
				g.edit("PR_1", func(p *PullRequest) { p.HeadSHA = "pushed-since" })
			},
			err: ErrFailedPrecondition, errHas: "changed on GitHub since it was loaded (branch-1 has new commits); refresh",
			mutations: 1},
		{name: "merged: refused after a fresh look, no mutation", number: 3, req: MergeRequest{Method: MergeSquash},
			err: ErrFailedPrecondition, errHas: "pull request #3 is merged, not open"},
		{name: "draft: refused, no mutation", number: 2, req: MergeRequest{Method: MergeSquash},
			err: ErrFailedPrecondition, errHas: "pull request #2 is a draft"},
		{name: "method the repository disallows: refused, no mutation", number: 1, req: MergeRequest{Method: MergeRebase},
			setup: func(g *fakeGitHub, _ *fakeWriter, _ *Store) { g.disallowMerge(MergeRebase) },
			err:   ErrFailedPrecondition, errHas: "cannot be merged with rebase"},
		{name: "FORBIDDEN is permission denied", number: 1, req: MergeRequest{Method: MergeSquash, DeleteBranch: true},
			setup: func(g *fakeGitHub, _ *fakeWriter, _ *Store) {
				g.refuseMerges("FORBIDDEN", "Resource not accessible by integration")
			},
			err: ErrPermissionDenied, errHas: "Resource not accessible", mutations: 1},
		{name: "UNPROCESSABLE (protection) is a failed precondition", number: 1, req: MergeRequest{Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *fakeWriter, _ *Store) {
				g.refuseMerges("UNPROCESSABLE", "At least 1 approving review is required by reviewers with write access.")
			},
			err: ErrFailedPrecondition, errHas: "approving review is required", mutations: 1},
		{name: "GraphQL refusal without a type is a failed precondition", number: 1, req: MergeRequest{Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *fakeWriter, _ *Store) { g.refuseMerges("", "Merging is blocked") },
			err:   ErrFailedPrecondition, errHas: "failed precondition: Merging is blocked", mutations: 1},
		{name: "GraphQL refusal of an unknown type is a failed precondition", number: 1, req: MergeRequest{Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *fakeWriter, _ *Store) { g.refuseMerges("SOMETHING_NEW", "Merge queue required") },
			err:   ErrFailedPrecondition, errHas: "Merge queue required", mutations: 1},
		{name: "untyped head moved", number: 1, req: MergeRequest{Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *fakeWriter, _ *Store) {
				g.refuseMerges("", "Head branch was modified. Review and try the merge again.")
			},
			err: ErrFailedPrecondition, errHas: "changed on GitHub since it was loaded (branch-1 has new commits)", mutations: 1},
		{name: "base moved", number: 1, req: MergeRequest{Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *fakeWriter, _ *Store) {
				g.refuseMerges("UNPROCESSABLE", "Base branch was modified. Review and try the merge again.")
			},
			err: ErrFailedPrecondition, errHas: "its base branch main changed on GitHub during the merge; refresh", mutations: 1},
		{name: "NOT_FOUND keeps its kind", number: 1, req: MergeRequest{Method: MergeSquash},
			setup: func(g *fakeGitHub, _ *fakeWriter, _ *Store) { g.refuseMerges("NOT_FOUND", "Could not resolve to a node") },
			err:   ErrNotFound, errHas: "Could not resolve", mutations: 1},
		{name: "the default branch is never deleted", number: 6, req: MergeRequest{Method: MergeSquash, DeleteBranch: true},
			want: MergeResult{Merged: true, SHA: "5e1f" + strings.Repeat("0", 36),
				Message: "Merged #6 (5e1f000); kept origin/main: it is the repository's default branch"},
			mutations: 1},
		{name: "the base branch is never deleted", number: 7, req: MergeRequest{Method: MergeSquash, DeleteBranch: true},
			want: MergeResult{Merged: true, SHA: "5e1f" + strings.Repeat("0", 36),
				Message: "Merged #7 (5e1f000); kept origin/release: it is the base branch"},
			mutations: 1},
		{name: "expected head not a full SHA", number: 1, req: MergeRequest{Method: MergeSquash, ExpectedHeadSHA: "abc1234"},
			err: ErrInvalidArgument, errHas: "not a full commit SHA"},
		{name: "no method", number: 1, req: MergeRequest{}, err: ErrInvalidArgument},
		{name: "bad number", number: 0, req: MergeRequest{Method: MergeSquash}, err: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, w, s, _, events := mergeWorld(t)
			if tt.setup != nil {
				tt.setup(g, w, s)
			}
			drain(events)
			got, err := s.MergePullRequest(ctx, "o/r", tt.number, tt.req)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %v, want %v containing %q", err, tt.err, tt.errHas)
				}
			} else if err != nil || got != tt.want {
				t.Errorf("got %+v, %v; want %+v", got, err, tt.want)
			}
			if n := len(g.merges()); n != tt.mutations {
				t.Errorf("mutations = %d, want %d", n, tt.mutations)
			}
			var writes []string
			for _, c := range w.calls() {
				if c.body != nil {
					t.Errorf("%s %s sent a body: %v", c.method, c.path, c.body)
				}
				writes = append(writes, c.method+" "+c.path)
			}
			if !slices.Equal(writes, tt.writes) {
				t.Errorf("REST writes = %q, want %q", writes, tt.writes)
			}
			// A merge, and GitHub refusing it in the pull request's state (head moved,
			// protection), tell clients to re-read.
			if want := tt.err == nil || (tt.mutations > 0 && errors.Is(tt.err, ErrFailedPrecondition)); want != (drain(events) > 0) {
				t.Errorf("detail event sent = %t, want %t", !want, want)
			}
		})
	}
}

func TestMergePullRequestSendsTheCachedHead(t *testing.T) {
	g, _, s, _, _ := mergeWorld(t)
	ctx := context.Background()
	d, err := s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(d.MergeMethods, []MergeMethod{MergeCommit, MergeSquash, MergeRebase}) || d.AutoMerge {
		t.Errorf("detail methods %v, auto-merge %t", d.MergeMethods, d.AutoMerge)
	}
	if _, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash}); err != nil {
		t.Fatal(err)
	}
	want := []fakeMergeCall{{id: "PR_1", method: "SQUASH", head: fmt.Sprintf("%040d", 1)}}
	if got := g.merges(); !slices.Equal(got, want) {
		t.Errorf("mutation vars = %+v, want %+v", got, want)
	}
	// The store re-reads the merged pull request afterwards.
	d, err = s.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil || d.PullRequest.State != PullRequestMerged {
		t.Errorf("after the merge: %s, %v", d.PullRequest.State, err)
	}
}

func TestMergePullRequestDedupe(t *testing.T) {
	g, w, s, clk, _ := mergeWorld(t)
	ctx := context.Background()
	mutations := func() int { return len(g.merges()) }

	t.Run("no answer: outcome unknown for the window, then a retry sends it", func(t *testing.T) {
		g.failNext("MergePullRequest", fmt.Errorf("%w: Bad Gateway (HTTP 502)", ErrServerTimeout))
		_, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, DeleteBranch: true})
		if !errors.Is(err, ErrServerTimeout) || !strings.Contains(err.Error(), "it may have merged; check GitHub before trying again") {
			t.Fatalf("err = %v", err)
		}
		if len(w.calls()) != 0 {
			t.Error("branch deleted after an unconfirmed merge")
		}
		clk.advance(writeMemoTTL - time.Second)
		_, again := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash})
		// failNext answers before the fake records a call: nothing has been sent yet.
		if again == nil || again.Error() != err.Error() || mutations() != 0 {
			t.Errorf("retry inside the window: %v, mutations %d; want the same error, nothing sent", again, mutations())
		}
		clk.advance(2 * time.Second)
		res, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, DeleteBranch: true})
		if err != nil || !res.Merged || !res.BranchDeleted || mutations() != 1 {
			t.Errorf("after the window: %+v, %v, mutations %d", res, err, mutations())
		}
	})

	t.Run("a success answers repeats for the window", func(t *testing.T) {
		first, _ := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash})
		again, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeRebase, DeleteBranch: true})
		if err != nil || again != first || mutations() != 1 || len(w.calls()) != 1 {
			t.Errorf("repeat: %+v, %v; mutations %d, writes %d", again, err, mutations(), len(w.calls()))
		}
		clk.advance(writeMemoTTL + time.Second)
		// Merged by now: the store refuses without asking GitHub.
		_, err = s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash})
		if !errors.Is(err, ErrFailedPrecondition) || mutations() != 1 {
			t.Errorf("after the window: %v, mutations %d", err, mutations())
		}
	})

	t.Run("a refusal is not remembered", func(t *testing.T) {
		g.refuseMerges("FORBIDDEN", "Resource not accessible by integration")
		for range 2 {
			if _, err := s.MergePullRequest(ctx, "o/r", 5, MergeRequest{Method: MergeSquash}); !errors.Is(err, ErrPermissionDenied) {
				t.Errorf("err = %v", err)
			}
		}
		if mutations() != 3 {
			t.Errorf("mutations = %d, want 3 (each refusal sent)", mutations())
		}
		g.refuseMerges("", "")
	})
}

func TestMergePullRequestPausedSendsNothing(t *testing.T) {
	g, _, s, clk, _ := mergeWorld(t)
	ctx := context.Background()
	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.pauseUntil = clk.now().Add(time.Hour)
	s.pauseErr = &RateLimitError{Secondary: true, Msg: "slow down"}
	s.mu.Unlock()
	_, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash})
	if !errors.Is(err, ErrRateLimited) || len(g.merges()) != 0 {
		t.Errorf("paused: %v, mutations %d", err, len(g.merges()))
	}
}

// The branch delete through the real HTTP runner: DELETE on the escaped ref path, no
// body; GitHub's 422 for a branch it already deleted counts as deleted.
func TestMergeDeletesBranchREST(t *testing.T) {
	var gone bool
	srv := newAPIServer(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/graphql":
			_, _ = w.Write([]byte(`{"data":{"viewer":{"id":"U1","login":"octocat"}}}`))
		case gone:
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"Reference does not exist","status":"422"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	runner := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
	s := startStore(t, testOptions(openTestDB(t), runner, nil))
	ctx := context.Background()
	if err := s.deleteBranch(ctx, fullKey{"o/r", 1}, "feat/a#b"); err != nil {
		t.Fatal(err)
	}
	var del []recorded
	for _, r := range srv.requests() {
		if r.path != "/graphql" {
			del = append(del, r)
		}
	}
	if len(del) != 1 || del[0].method != http.MethodDelete || del[0].path != "/repos/o/r/git/refs/heads/feat/a#b" || len(del[0].body) != 0 {
		t.Fatalf("requests = %+v", del)
	}
	gone = true
	if err := s.deleteBranch(ctx, fullKey{"o/r", 1}, "feat/a#b"); err != nil {
		t.Errorf("already deleted: %v", err)
	}
}

// The client's head guard: the merge goes through only with the head the client
// showed, even when the store refetched the detail in between.
func TestMergePullRequestExpectedHead(t *testing.T) {
	ctx := context.Background()
	shown := fmt.Sprintf("%040d", 1)
	pushed := strings.Repeat("b", 40)
	tests := []struct {
		name string
		// before runs after the client read the detail (head shown) and before the merge.
		before    func(g *fakeGitHub, s *Store, clk *testClock)
		expected  string
		err       string // empty: merged
		wantHead  string // the expectedHeadOid sent, when merged
		mutations int
	}{
		{name: "aged cache refetched with new commits: refused",
			before: func(g *fakeGitHub, s *Store, clk *testClock) {
				g.edit("PR_1", func(p *PullRequest) { p.HeadSHA = pushed })
				clk.advance(s.config().PollInterval)
			},
			expected: shown, err: "pull request #1 changed since it was shown (head bbbbbbb, shown 0000000); refresh and try again"},
		{name: "stale cache refetched with new commits: refused",
			before: func(g *fakeGitHub, s *Store, _ *testClock) {
				g.edit("PR_1", func(p *PullRequest) { p.HeadSHA = pushed })
				s.full.markStale(fullKey{"o/r", 1})
			},
			expected: shown, err: "changed since it was shown"},
		{name: "cache behind the client: a fresh look agrees, merged",
			before: func(g *fakeGitHub, _ *Store, _ *testClock) {
				g.edit("PR_1", func(p *PullRequest) { p.HeadSHA = pushed })
			},
			expected: pushed, wantHead: pushed, mutations: 1},
		{name: "matching head: merged with it",
			expected: shown, wantHead: shown, mutations: 1},
		{name: "no expected head (CLI): the store's head",
			wantHead: shown, mutations: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, _, s, clk, events := mergeWorld(t)
			if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
				t.Fatal(err)
			}
			if tt.before != nil {
				tt.before(g, s, clk)
			}
			drain(events)
			res, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, ExpectedHeadSHA: tt.expected})
			calls := g.merges()
			if tt.err != "" {
				if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), tt.err) {
					t.Errorf("err = %v, want failed precondition containing %q", err, tt.err)
				}
				if len(calls) != 0 {
					t.Errorf("mutations = %+v, want none", calls)
				}
				if drain(events) == 0 {
					t.Error("no detail event: the client keeps showing the old head")
				}
				return
			}
			if err != nil || !res.Merged {
				t.Fatalf("got %+v, %v", res, err)
			}
			if len(calls) != tt.mutations || calls[0].head != tt.wantHead {
				t.Errorf("mutations = %+v, want one with head %s", calls, tt.wantHead)
			}
		})
	}
}

func TestMergePullRequestRepeatAsksForTheBranch(t *testing.T) {
	g, w, s, _, _ := mergeWorld(t)
	ctx := context.Background()
	first, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash})
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, DeleteBranch: true})
	want := first
	want.Message = "Merged #1 (5e1f000); branch not deleted: the first merge did not ask"
	if err != nil || again != want || len(g.merges()) != 1 || len(w.calls()) != 0 {
		t.Errorf("repeat: %+v, %v; mutations %d, writes %d; want %+v", again, err, len(g.merges()), len(w.calls()), want)
	}
	// A repeat that does not ask gets the first's message unchanged.
	if same, _ := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash}); same != first {
		t.Errorf("plain repeat: %+v, want %+v", same, first)
	}
}

func TestMergePullRequestUnknownOutcomeInvalidates(t *testing.T) {
	g, _, s, _, events := mergeWorld(t)
	ctx := context.Background()
	if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	drain(events)
	g.failNext("MergePullRequest", fmt.Errorf("%w: Gateway Timeout (HTTP 504)", ErrServerTimeout))
	if _, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash}); !errors.Is(err, ErrServerTimeout) {
		t.Fatalf("err = %v", err)
	}
	if _, stale, ok := s.full.get(fullKey{"o/r", 1}); !ok || !stale {
		t.Errorf("cached detail stale = %t (cached %t), want stale", stale, ok)
	}
	if drain(events) == 0 {
		t.Error("no detail event after an unconfirmed merge")
	}
}

func TestMergePullRequestConcurrent(t *testing.T) {
	g, w, s, _, _ := mergeWorld(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make([]MergeResult, 4)
	for i := range results {
		wg.Go(func() {
			r, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, DeleteBranch: true})
			if err != nil {
				t.Error(err)
			}
			results[i] = r
		})
	}
	wg.Wait()
	if len(g.merges()) != 1 || len(w.calls()) != 1 {
		t.Errorf("mutations %d, branch deletes %d; want 1 each", len(g.merges()), len(w.calls()))
	}
	for _, r := range results[1:] {
		if r != results[0] {
			t.Errorf("results differ: %+v vs %+v", r, results[0])
		}
	}
}

func TestKeepBranch(t *testing.T) {
	pr := func(head, base, def string) *FullPullRequest {
		return &FullPullRequest{PullRequest: PullRequest{HeadRef: head, BaseRef: base}, DefaultBranch: def}
	}
	for _, tt := range []struct {
		d    *FullPullRequest
		want string
	}{
		{pr("feat/x", "main", "main"), ""},
		{pr("main", "release", "main"), "it is the repository's default branch"},
		{pr("release", "release", "main"), "it is the base branch"},
		{pr("feat/x", "main", ""), "the repository's default branch is unknown"},
	} {
		if got := keepBranch(tt.d); got != tt.want {
			t.Errorf("keepBranch(%+v) = %q, want %q", tt.d.PullRequest, got, tt.want)
		}
	}
}
