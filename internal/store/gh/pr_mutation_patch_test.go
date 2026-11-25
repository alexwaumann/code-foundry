package gh

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// Every mutation on a warm detail cache patches s.full in place, persists to SQLite,
// marks the entry fresh, and serves the immediate FullPullRequest read with 0 extra
// PullRequestFull GraphQL round-trips.
func TestMutationsPatchFullInPlaceZeroRefetch(t *testing.T) {
	ctx := context.Background()
	head1 := fmt.Sprintf("%040d", 1)

	t.Run("comment appends to comments and increments count", func(t *testing.T) {
		g, w, s, _, events := mergeWorld(t)
		d0, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		drain(events)
		from := w.ncalls()
		posted, err := s.AddPullRequestComment(ctx, "o/r", 1, "ship it")
		if err != nil {
			t.Fatal(err)
		}
		if drain(events) != 1 {
			t.Fatal("expected PullRequestDetailUpdated")
		}
		d1, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if n := w.countSince(from, "PullRequestFull"); n != 0 {
			t.Errorf("PullRequestFull calls = %d, want 0", n)
		}
		if d1.Refreshing || len(d1.Comments) != len(d0.Comments)+1 {
			t.Fatalf("refreshing=%v comments=%+v", d1.Refreshing, d1.Comments)
		}
		last := d1.Comments[len(d1.Comments)-1]
		if last.ID != posted.ID || last.Body != "ship it" || last.Author != "octocat" || last.Kind != CommentIssue {
			t.Errorf("patched comment = %+v", last)
		}
		if d1.PullRequest.Comments != d0.PullRequest.Comments+1 {
			t.Errorf("comment count = %d, want %d", d1.PullRequest.Comments, d0.PullRequest.Comments+1)
		}
		// Persisted to SQLite too.
		row, found, err := loadActivityRow[FullPullRequest](ctx, s.cache, activityFull+"o/r#1")
		if err != nil || !found || len(row.Comments) != len(d1.Comments) {
			t.Errorf("sqlite row found=%v len=%d err=%v", found, len(row.Comments), err)
		}
		_ = g
	})

	t.Run("review appends to comments, updates reviewers, and sets reviewDecision", func(t *testing.T) {
		g, w, s, _, events := mergeWorld(t)
		g.edit("PR_1", func(p *PullRequest) {
			p.Author = "kim"
			p.ReviewRequests = []string{"octocat", "org/core"}
		})
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		drain(events)
		from := w.ncalls()
		sub, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove, Body: "looks great"})
		if err != nil {
			t.Fatal(err)
		}
		if drain(events) != 1 {
			t.Fatal("expected PullRequestDetailUpdated")
		}
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if n := w.countSince(from, "PullRequestFull"); n != 0 {
			t.Errorf("PullRequestFull calls = %d, want 0", n)
		}
		if d.Refreshing || d.PullRequest.ReviewDecision != ReviewApproved {
			t.Errorf("refreshing=%v reviewDecision=%q", d.Refreshing, d.PullRequest.ReviewDecision)
		}
		if !slices.ContainsFunc(d.Comments, func(c Comment) bool {
			return c.ID == sub.ID && c.Kind == CommentReview && c.ReviewState == "APPROVED" && c.Body == "looks great"
		}) {
			t.Errorf("review comment missing from %+v", d.Comments)
		}
		idx := slices.IndexFunc(d.Reviewers, func(r Reviewer) bool { return r.Login == "octocat" })
		if idx < 0 || d.Reviewers[idx].State != "APPROVED" || d.Reviewers[idx].Requested || d.Reviewers[idx].Stale {
			t.Errorf("reviewers = %+v", d.Reviewers)
		}
		if slices.Contains(d.PullRequest.ReviewRequests, "octocat") || !slices.Contains(d.PullRequest.ReviewRequests, "org/core") {
			t.Errorf("reviewRequests = %v, want octocat removed and org/core kept", d.PullRequest.ReviewRequests)
		}
	})

	t.Run("draft and ready patch draft, mergeStateStatus, and clear auto-merge on draft", func(t *testing.T) {
		g, w, s, _, _ := mergeWorld(t)
		g.setAutoMerge("PR_1", "SQUASH")
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		from := w.ncalls()
		if _, err := s.SetPullRequestDraft(ctx, "o/r", 1, true); err != nil {
			t.Fatal(err)
		}
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if !d.PullRequest.Draft || d.PullRequest.MergeStateStatus != "DRAFT" || d.AutoMerge || d.Refreshing {
			t.Errorf("after draft: draft=%v mergeState=%q autoMerge=%v refreshing=%v",
				d.PullRequest.Draft, d.PullRequest.MergeStateStatus, d.AutoMerge, d.Refreshing)
		}
		if _, err := s.SetPullRequestDraft(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		d2, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if d2.PullRequest.Draft || d2.PullRequest.MergeStateStatus != "CLEAN" || d2.Refreshing {
			t.Errorf("after ready: draft=%v mergeState=%q refreshing=%v",
				d2.PullRequest.Draft, d2.PullRequest.MergeStateStatus, d2.Refreshing)
		}
		if n := w.countSince(from, "PullRequestFull"); n != 0 {
			t.Errorf("PullRequestFull calls = %d, want 0", n)
		}
	})

	t.Run("close and reopen patch state, closedAt, and viewer permissions", func(t *testing.T) {
		_, w, s, _, _ := mergeWorld(t)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		from := w.ncalls()
		if _, err := s.SetPullRequestClosed(ctx, "o/r", 1, true); err != nil {
			t.Fatal(err)
		}
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if d.PullRequest.State != PullRequestClosed || d.ClosedAt.IsZero() || !d.ViewerCanReopen || !d.ViewerCanClose || d.Refreshing {
			t.Errorf("after close: state=%s closedAt=%v canClose=%v canReopen=%v refreshing=%v",
				d.PullRequest.State, d.ClosedAt, d.ViewerCanClose, d.ViewerCanReopen, d.Refreshing)
		}
		if _, err := s.SetPullRequestClosed(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		d2, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if d2.PullRequest.State != PullRequestOpen || !d2.ClosedAt.IsZero() || d2.ViewerCanReopen || !d2.ViewerCanClose || d2.Refreshing {
			t.Errorf("after reopen: state=%s closedAt=%v canClose=%v canReopen=%v refreshing=%v",
				d2.PullRequest.State, d2.ClosedAt, d2.ViewerCanClose, d2.ViewerCanReopen, d2.Refreshing)
		}
		if n := w.countSince(from, "PullRequestFull"); n != 0 {
			t.Errorf("PullRequestFull calls = %d, want 0", n)
		}
	})

	t.Run("auto-merge enable and disable patch in place", func(t *testing.T) {
		_, w, s, _, _ := mergeWorld(t)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		from := w.ncalls()
		if _, err := s.SetPullRequestAutoMerge(ctx, "o/r", 1, AutoMergeChange{Enabled: true, Method: MergeSquash, ExpectedHeadSHA: head1}); err != nil {
			t.Fatal(err)
		}
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if !d.AutoMerge || d.AutoMergeMethod != MergeSquash || d.Refreshing {
			t.Errorf("after enable: autoMerge=%v method=%q refreshing=%v", d.AutoMerge, d.AutoMergeMethod, d.Refreshing)
		}
		if _, err := s.SetPullRequestAutoMerge(ctx, "o/r", 1, AutoMergeChange{Enabled: false}); err != nil {
			t.Fatal(err)
		}
		d2, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if d2.AutoMerge || d2.AutoMergeMethod != "" || d2.Refreshing {
			t.Errorf("after disable: autoMerge=%v method=%q refreshing=%v", d2.AutoMerge, d2.AutoMergeMethod, d2.Refreshing)
		}
		if n := w.countSince(from, "PullRequestFull"); n != 0 {
			t.Errorf("PullRequestFull calls = %d, want 0", n)
		}
	})

	t.Run("merge patches state, mergedAt, mergedBy, and mergeCommitSHA", func(t *testing.T) {
		_, w, s, _, _ := mergeWorld(t)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		from := w.ncalls()
		if _, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, ExpectedHeadSHA: head1}); err != nil {
			t.Fatal(err)
		}
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if n := w.countSince(from, "PullRequestFull"); n != 0 {
			t.Errorf("PullRequestFull calls = %d, want 0", n)
		}
		wantSHA := "5e1f" + strings.Repeat("0", 36)
		if d.PullRequest.State != PullRequestMerged || d.PullRequest.MergedAt.IsZero() ||
			d.MergedBy != "octocat" || d.MergeCommitSHA != wantSHA || d.Refreshing {
			t.Errorf("after merge: state=%s mergedAt=%v mergedBy=%q sha=%q refreshing=%v",
				d.PullRequest.State, d.PullRequest.MergedAt, d.MergedBy, d.MergeCommitSHA, d.Refreshing)
		}
	})

	t.Run("checkbox still reads fresh body and patches s.full without PullRequestFull", func(t *testing.T) {
		g, w, s, _, _ := mergeWorld(t)
		g.setBody("PR_1", "- [ ] alpha\n- [ ] beta\n")
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		from := w.ncalls()
		if _, err := s.SetPullRequestCheckbox(ctx, "o/r", 1, CheckboxChange{Index: 0, Text: "alpha", Checked: true}); err != nil {
			t.Fatal(err)
		}
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if d.Body != "- [x] alpha\n- [ ] beta\n" || d.Refreshing {
			t.Errorf("after checkbox: body=%q refreshing=%v", d.Body, d.Refreshing)
		}
		if n := w.countSince(from, "PullRequestBody"); n != 1 {
			t.Errorf("PullRequestBody calls = %d, want 1 (must still read fresh body)", n)
		}
		if n := w.countSince(from, "PullRequestFull"); n != 0 {
			t.Errorf("PullRequestFull calls = %d, want 0", n)
		}
	})
}

// Mutations on a PR known from a poll (in s.summaries, cold s.full) skip the pre-flight
// PullRequestFull query when the cached summary has the needed node ID / state.
func TestMutationsSkipPreFlightFetchFromPolledSummary(t *testing.T) {
	ctx := context.Background()
	head1 := fmt.Sprintf("%040d", 1)
	cases := []struct {
		name   string
		mutate func(*Store) error
	}{
		{"comment", func(s *Store) error { _, err := s.AddPullRequestComment(ctx, "o/r", 1, "hi"); return err }},
		{"review", func(s *Store) error {
			_, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove})
			return err
		}},
		{"draft", func(s *Store) error { _, err := s.SetPullRequestDraft(ctx, "o/r", 1, true); return err }},
		{"close", func(s *Store) error { _, err := s.SetPullRequestClosed(ctx, "o/r", 1, true); return err }},
		{"auto_merge", func(s *Store) error {
			_, err := s.SetPullRequestAutoMerge(ctx, "o/r", 1, AutoMergeChange{Enabled: true, Method: MergeSquash, ExpectedHeadSHA: head1})
			return err
		}},
		{"merge", func(s *Store) error {
			_, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, ExpectedHeadSHA: head1})
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, w, s, _, _ := mergeWorld(t)
			g.edit("PR_1", func(p *PullRequest) { p.Author = "kim" })
			if err := s.Track("o/r"); err != nil {
				t.Fatal(err)
			}
			pollOnce(t, s, w.fakeRunner)
			from := w.ncalls()
			if err := tc.mutate(s); err != nil {
				t.Fatal(err)
			}
			if n := w.countSince(from, "PullRequestFull"); n != 0 {
				t.Errorf("%s: pre-flight PullRequestFull = %d, want 0", tc.name, n)
			}
		})
	}
}

// Local mutations (closed, reopened, draft/ready, reviewDecision) immediately overlay
// Dashboard and BranchPullRequests until GitHub's searches confirm them, while keeping
// the poll diff baseline (basis) untouched so PullRequestChanged still fires when the
// poll catches up.
func TestLocalOverlayCloseReopenDraftReviewAndBranches(t *testing.T) {
	ctx := context.Background()
	var b *bus.Bus
	g, w, s, clk, _ := mergeWorld(t, func(o *Options) { b = o.Bus })
	g.setBranch("o/r", "branch-1", "PR_1")
	dashEv := bus.Subscribe[DashboardUpdated](b, 64)
	branchEv := bus.Subscribe[BranchPullRequestsUpdated](b, 64)
	changes := bus.Subscribe[PullRequestChanged](b, 64)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BranchPullRequests(ctx, "o/r", "branch-1"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, w.fakeRunner)
	drain(dashEv)
	drain(branchEv)
	drain(changes)

	// 1. Draft toggle overlays Dashboard and BranchPullRequests at once.
	if _, err := s.SetPullRequestDraft(ctx, "o/r", 1, true); err != nil {
		t.Fatal(err)
	}
	if d := s.Snapshot().Dashboard.Authored; len(d) != 1 || !d[0].Draft {
		t.Fatalf("dashboard after draft = %+v, want #1 draft=true", d)
	}
	if br, err := s.BranchPullRequests(ctx, "o/r", "branch-1"); err != nil || len(br.PullRequests) != 1 || !br.PullRequests[0].Draft {
		t.Fatalf("branch after draft = %+v, %v", br.PullRequests, err)
	}
	if drain(dashEv) == 0 || drain(branchEv) == 0 {
		t.Error("expected DashboardUpdated and BranchPullRequestsUpdated after draft")
	}

	// Mark ready again.
	if _, err := s.SetPullRequestDraft(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	if d := s.Snapshot().Dashboard.Authored; len(d) != 1 || d[0].Draft {
		t.Fatalf("dashboard after ready = %+v, want #1 draft=false", d)
	}
	drain(dashEv)
	drain(branchEv)

	// 2. Review decision overlays Dashboard and BranchPullRequests at once.
	g.edit("PR_1", func(p *PullRequest) { p.Author = "kim" })
	if _, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove, Body: "lgtm"}); err != nil {
		t.Fatal(err)
	}
	if d := s.Snapshot().Dashboard.Authored; len(d) != 1 || d[0].ReviewDecision != ReviewApproved {
		t.Fatalf("dashboard after approve = %+v, want ReviewApproved", d)
	}
	if br, err := s.BranchPullRequests(ctx, "o/r", "branch-1"); err != nil || len(br.PullRequests) != 1 || br.PullRequests[0].ReviewDecision != ReviewApproved {
		t.Fatalf("branch after approve = %+v, %v", br.PullRequests, err)
	}
	drain(dashEv)
	drain(branchEv)
	g.edit("PR_1", func(p *PullRequest) { p.Author = "octocat" })

	// 3. Close removes from Dashboard open list and flips BranchPullRequests to CLOSED.
	if _, err := s.SetPullRequestClosed(ctx, "o/r", 1, true); err != nil {
		t.Fatal(err)
	}
	if d := s.Snapshot().Dashboard; len(d.Authored) != 0 || d.AuthoredTotal != 0 || len(d.RecentlyMerged) != 0 {
		t.Fatalf("dashboard after close = authored %d (total %d), merged %d", len(d.Authored), d.AuthoredTotal, len(d.RecentlyMerged))
	}
	if br, err := s.BranchPullRequests(ctx, "o/r", "branch-1"); err != nil || len(br.PullRequests) != 1 || br.PullRequests[0].State != PullRequestClosed {
		t.Fatalf("branch after close = %+v, %v", br.PullRequests, err)
	}
	if drain(dashEv) == 0 || drain(branchEv) == 0 {
		t.Error("expected DashboardUpdated and BranchPullRequestsUpdated after close")
	}

	// Lagging poll still lists PR_1 in sectionAuthored: overlay keeps it hidden, while
	// poll diff (basis) still announces ChangeClosed!
	drain(changes)
	pollOnce(t, s, w.fakeRunner)
	if d := s.Snapshot().Dashboard; len(d.Authored) != 0 {
		t.Errorf("after lagging poll: authored = %+v, want hidden", d.Authored)
	}
	closedAnnounced := false
	for len(changes.C()) > 0 {
		if e := <-changes.C(); e.Number == 1 && e.Has(ChangeClosed) {
			closedAnnounced = true
		}
	}
	if !closedAnnounced {
		t.Error("poll diff did not announce ChangeClosed (basis was polluted)")
	}

	// 4. Reopen restores PR_1 to Dashboard.Authored and BranchPullRequests immediately.
	g.mu.Lock()
	g.sections[sectionAuthored] = nil // search index caught up to closed
	g.mu.Unlock()
	pollOnce(t, s, w.fakeRunner) // confirms close mark; marks empty now
	if _, err := s.SetPullRequestClosed(ctx, "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	if d := s.Snapshot().Dashboard; len(d.Authored) != 1 || d.Authored[0].State != PullRequestOpen || d.AuthoredTotal != 1 {
		t.Fatalf("dashboard after reopen = %+v (total %d)", d.Authored, d.AuthoredTotal)
	}
	if br, err := s.BranchPullRequests(ctx, "o/r", "branch-1"); err != nil || len(br.PullRequests) != 1 || br.PullRequests[0].State != PullRequestOpen {
		t.Fatalf("branch after reopen = %+v, %v", br.PullRequests, err)
	}

	// Once TTL expires without search catching up, the mark drops cleanly.
	clk.advance(mergeMarkTTL + time.Second)
	pollOnce(t, s, w.fakeRunner)
	s.localShown.mu.Lock()
	remaining := len(s.localShown.marks)
	s.localShown.mu.Unlock()
	if remaining != 0 {
		t.Errorf("remaining marks after TTL = %d, want 0", remaining)
	}
}

func TestPatchFullPreservesStalenessAndReconcilesExternalEdits(t *testing.T) {
	ctx := context.Background()

	t.Run("aged entry serves patched comment immediately with Refreshing=true and reconciles external edits", func(t *testing.T) {
		g, w, s, clk, _ := mergeWorld(t)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		// Age past PollInterval and simulate an external title + head edit before our comment.
		clk.advance(2 * time.Hour)
		newHead := fmt.Sprintf("%040d", 99)
		g.edit("PR_1", func(p *PullRequest) {
			p.Title = "Externally retitled"
			p.HeadSHA = newHead
		})

		if _, err := s.AddPullRequestComment(ctx, "o/r", 1, "my comment"); err != nil {
			t.Fatal(err)
		}
		// Immediate read returns patched comment without blocking, while preserving age
		// so Refreshing=true triggers a background PullRequestFull to pick up the new title/head.
		d1, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if !d1.Refreshing {
			t.Fatalf("aged entry Refreshing = false after patchFull, want true")
		}
		if !slices.ContainsFunc(d1.Comments, func(c Comment) bool { return c.Body == "my comment" }) {
			t.Fatalf("patched comment missing from immediate aged read: %+v", d1.Comments)
		}
		settleWorker(t, s)
		d2, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if d2.PullRequest.Title != "Externally retitled" || d2.PullRequest.HeadSHA != newHead {
			t.Fatalf("background refresh did not pick up external edit: title=%q head=%q", d2.PullRequest.Title, d2.PullRequest.HeadSHA)
		}
		_ = w
	})

	t.Run("warm entry leaves UpdatedAt at fetch-time so next poll reconciles prior external edits", func(t *testing.T) {
		g, w, s, clk, _ := mergeWorld(t)
		if err := s.Track("o/r"); err != nil {
			t.Fatal(err)
		}
		pollOnce(t, s, w.fakeRunner)
		d0, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		origUpdated := d0.PullRequest.UpdatedAt

		// External edit lands before our comment.
		clk.advance(5 * time.Second)
		g.edit("PR_1", func(p *PullRequest) {
			p.Title = "Edited before comment"
			p.UpdatedAt = clk.now()
		})
		if _, err := s.AddPullRequestComment(ctx, "o/r", 1, "warm comment"); err != nil {
			t.Fatal(err)
		}
		d1, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if d1.Refreshing {
			t.Fatalf("warm entry Refreshing = true, want false")
		}
		if !d1.PullRequest.UpdatedAt.Equal(origUpdated) {
			t.Fatalf("UpdatedAt advanced to %v (was %v); must stay at fetch-time so next poll reconciles", d1.PullRequest.UpdatedAt, origUpdated)
		}
		// Next poll sees poll.UpdatedAt != origUpdated and marks the cached detail stale.
		pollOnce(t, s, w.fakeRunner)
		e, ok := s.full.entry(fullKey{slug: "o/r", number: 1})
		if !ok || !e.stale {
			t.Fatalf("expected poll after mutation to mark detail stale (ok=%v stale=%v)", ok, e.stale)
		}
	})

	t.Run("patchFull marks moved so Store.PullRequest invalidates its separate detail cache", func(t *testing.T) {
		_, _, s, _, _ := mergeWorld(t)
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		k := fullKey{slug: "o/r", number: 1}
		before := s.opts.Now()
		if _, err := s.SetPullRequestDraft(ctx, "o/r", 1, true); err != nil {
			t.Fatal(err)
		}
		if !s.moved.movedSince(k, before.Add(-time.Second)) {
			t.Fatalf("expected s.moved.markWrite after patched mutation")
		}
	})

	t.Run("COMMENTED review does not overwrite prior APPROVED state in reviewers", func(t *testing.T) {
		g, _, s, _, _ := mergeWorld(t)
		g.edit("PR_1", func(p *PullRequest) { p.Author = "kim" })
		if _, err := s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
			t.Fatal(err)
		}
		if _, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove, Body: "approved"}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventComment, Body: "nit"}); err != nil {
			t.Fatal(err)
		}
		d, err := s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		idx := slices.IndexFunc(d.Reviewers, func(r Reviewer) bool { return r.Login == "octocat" })
		if idx < 0 || d.Reviewers[idx].State != "APPROVED" {
			t.Fatalf("reviewer state after follow-up COMMENTED = %+v, want APPROVED preserved", d.Reviewers)
		}
		lidx := slices.IndexFunc(d.PullRequest.LatestReviews, func(r Review) bool { return r.Author == "octocat" })
		if lidx < 0 || d.PullRequest.LatestReviews[lidx].State != "APPROVED" {
			t.Fatalf("latestReviews state after follow-up COMMENTED = %+v, want APPROVED preserved", d.PullRequest.LatestReviews)
		}
	})
}
