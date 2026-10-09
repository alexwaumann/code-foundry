package gh

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestRevertPullRequestOutcomes(t *testing.T) {
	g, _ := changeDrivenWorld() // #1 open, #3 merged
	closed := fakePR("PR_d", "o/r", 4, time.Now().Add(-time.Hour))
	closed.State = PullRequestClosed
	g.addPR(closed)
	f := (&fakeRunner{}).serve(g)
	clk := &testClock{}
	opts := testOptions(openTestDB(t), f, nil)
	opts.Now = clk.now
	s := startStore(t, opts)
	ctx := context.Background()
	mutations := func() int { return f.count("RevertPullRequest") }

	t.Run("closed, not merged: refused without the mutation", func(t *testing.T) {
		_, err := s.RevertPullRequest(ctx, "o/r", 4)
		if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "#4 is closed, not merged") {
			t.Errorf("err = %v", err)
		}
		if mutations() != 0 {
			t.Error("mutation sent for a closed pull request")
		}
	})

	t.Run("cached open, and the confirming fetch is rate limited", func(t *testing.T) {
		k := fullKey{"o/r", 1}
		s.full.put(k, FullPullRequest{PullRequest: PullRequest{ID: "PR_a", Number: 1, State: PullRequestOpen}, FetchedAt: clk.now()})
		g.failNext("PullRequestFull", &RateLimitError{Msg: "API rate limit exceeded", ResetAt: clk.now().Add(time.Minute)})
		_, err := s.RevertPullRequest(ctx, "o/r", 1)
		if !errors.Is(err, ErrRateLimited) || !strings.Contains(err.Error(), "cannot confirm it is merged") {
			t.Errorf("err = %v, want the rate-limit error wrapped", err)
		}
		if mutations() != 0 {
			t.Error("mutation sent without confirming")
		}
		s.mu.Lock()
		s.pauseUntil = time.Time{} // end the pause the rate limit started
		s.mu.Unlock()
	})

	t.Run("GitHub refuses: FORBIDDEN is permission denied, and nothing is remembered", func(t *testing.T) {
		g.refuseReverts("FORBIDDEN")
		_, err := s.RevertPullRequest(ctx, "o/r", 3)
		if !errors.Is(err, ErrPermissionDenied) || !strings.Contains(err.Error(), "Resource not accessible") || isPartial(err) {
			t.Errorf("err = %v", err)
		}
		_, err = s.RevertPullRequest(ctx, "o/r", 3)
		if !errors.Is(err, ErrPermissionDenied) || mutations() != 2 {
			t.Errorf("retry: err %v, mutations %d (want 2: a refusal is not memoized)", err, mutations())
		}
		g.refuseReverts("")
	})

	t.Run("GitHub refuses: UNPROCESSABLE is a failed precondition", func(t *testing.T) {
		// The cache says merged; GitHub knows better (the fake refuses a PR it has open).
		s.full.put(fullKey{"o/r", 1}, FullPullRequest{PullRequest: PullRequest{ID: "PR_a", Number: 1, State: PullRequestMerged}, FetchedAt: clk.now()})
		before := mutations()
		_, err := s.RevertPullRequest(ctx, "o/r", 1)
		if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "not merged") || mutations() != before+1 {
			t.Errorf("err = %v, mutations %d", err, mutations()-before)
		}
	})

	t.Run("no answer: outcome unknown for the window, then a retry sends it", func(t *testing.T) {
		before := mutations()
		g.failNext("RevertPullRequest", fmt.Errorf("%w: Bad Gateway (HTTP 502)", ErrServerTimeout))
		_, err := s.RevertPullRequest(ctx, "o/r", 3)
		if !errors.Is(err, ErrServerTimeout) || !strings.Contains(err.Error(), "check GitHub before trying again") {
			t.Fatalf("err = %v", err)
		}
		clk.advance(writeMemoTTL - time.Second)
		_, again := s.RevertPullRequest(ctx, "o/r", 3)
		if again == nil || again.Error() != err.Error() || mutations() != before+1 {
			t.Errorf("retry inside the window: %v, mutations %d; want the same error, nothing sent", again, mutations()-before)
		}
		clk.advance(2 * time.Second)
		res, err := s.RevertPullRequest(ctx, "o/r", 3)
		if err != nil || res.Number != 901 || mutations() != before+2 {
			t.Errorf("after the window: %+v, %v, mutations %d", res, err, mutations()-before)
		}
	})

	t.Run("a success answers repeats for the window only", func(t *testing.T) {
		before := mutations()
		res, err := s.RevertPullRequest(ctx, "o/r", 3)
		if err != nil || res.Number != 901 || mutations() != before {
			t.Errorf("repeat inside the window: %+v, %v, mutations %d", res, err, mutations()-before)
		}
		clk.advance(writeMemoTTL + time.Second)
		res, err = s.RevertPullRequest(ctx, "o/r", 3)
		if err != nil || res.Number != 902 || mutations() != before+1 {
			t.Errorf("after the window: %+v, %v, mutations %d; want a second revert", res, err, mutations()-before)
		}
	})
}
