package gh

import (
	"context"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// TestPullRequestChangedShowsLocalOverlay: a poll whose GitHub reads predate the user's own
// close, ready-for-review or approval, and which reports another change of that pull
// request, sends clients the row with the user's change on it (Shown, what GetDashboard
// shows), while PullRequest stays as the poll saw it for the daemon's own diff consumers.
func TestPullRequestChangedShowsLocalOverlay(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		// setup runs before the first poll; act is the user's mutation; lag puts GitHub's
		// reads back to before it, as a poll in flight saw them.
		setup func(g *fakeGitHub)
		act   func(s *Store) error
		lag   func(p *PullRequest)
		// shown checks the client row, polled the in-process one.
		shown, polled func(p PullRequest) bool
	}{
		{
			name: "closed",
			act:  func(s *Store) error { _, err := s.SetPullRequestClosed(ctx, "o/r", 1, true); return err },
			lag:  func(p *PullRequest) { p.State = PullRequestOpen },
			shown: func(p PullRequest) bool {
				return p.State == PullRequestClosed
			},
			polled: func(p PullRequest) bool { return p.State == PullRequestOpen },
		},
		{
			name:   "ready for review",
			setup:  func(g *fakeGitHub) { g.edit("PR_1", func(p *PullRequest) { p.Draft = true }) },
			act:    func(s *Store) error { _, err := s.SetPullRequestDraft(ctx, "o/r", 1, false); return err },
			lag:    func(p *PullRequest) { p.Draft = true },
			shown:  func(p PullRequest) bool { return !p.Draft },
			polled: func(p PullRequest) bool { return p.Draft },
		},
		{
			name:  "approved",
			setup: func(g *fakeGitHub) { g.edit("PR_1", func(p *PullRequest) { p.Author = "kim" }) },
			act: func(s *Store) error {
				_, err := s.SubmitPullRequestReview(ctx, "o/r", 1, ReviewSubmission{Event: ReviewEventApprove, Body: "lgtm"})
				return err
			},
			lag:    func(p *PullRequest) { p.ReviewDecision = "" },
			shown:  func(p PullRequest) bool { return p.ReviewDecision == ReviewApproved },
			polled: func(p PullRequest) bool { return p.ReviewDecision == "" },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var b *bus.Bus
			g, w, s, _, _ := mergeWorld(t, func(o *Options) { b = o.Bus })
			changes := bus.Subscribe[PullRequestChanged](b, 64)
			if tt.setup != nil {
				tt.setup(g)
			}
			if err := s.Track("o/r"); err != nil {
				t.Fatal(err)
			}
			pollOnce(t, s, w.fakeRunner)
			drain(changes)

			if err := tt.act(s); err != nil {
				t.Fatal(err)
			}
			// The poll in flight read GitHub before the mutation, and saw the title change.
			g.edit("PR_1", func(p *PullRequest) {
				tt.lag(p)
				p.Title = "Renamed"
				p.UpdatedAt = p.UpdatedAt.Add(time.Minute)
			})
			pollOnce(t, s, w.fakeRunner)

			var got *PullRequestChanged
			for len(changes.C()) > 0 {
				if e := <-changes.C(); e.Number == 1 {
					got = &e
				}
			}
			if got == nil || !got.Has(ChangeTitle) {
				t.Fatalf("no title change announced for #1: %+v", got)
			}
			if !tt.shown(got.Shown) {
				t.Errorf("Shown = %+v, want the user's own change on it", got.Shown)
			}
			if got.Shown.Title != "Renamed" {
				t.Errorf("Shown.Title = %q, want the poll's", got.Shown.Title)
			}
			if !tt.polled(got.PullRequest) {
				t.Errorf("PullRequest = %+v, want it as the poll saw it", got.PullRequest)
			}
			// The client row is the one GetDashboard shows.
			for _, p := range s.Snapshot().Dashboard.Authored {
				if p.Number == 1 && !tt.shown(p) {
					t.Errorf("dashboard #1 = %+v, want the user's change", p)
				}
			}
		})
	}
}
