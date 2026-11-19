package gh

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

// The fake's pull requests (mergeWorld): #1 open, #2 draft, #3 merged, all on o/r.

func TestSetPullRequestClosed(t *testing.T) {
	ctx := context.Background()
	closeIt := func(id string) func(*fakeGitHub, *Store) {
		return func(g *fakeGitHub, _ *Store) { g.edit(id, func(p *PullRequest) { p.State = PullRequestClosed }) }
	}
	// cached reads the detail into the cache, then changes GitHub behind it.
	cached := func(number int, then func(*fakeGitHub)) func(*fakeGitHub, *Store) {
		return func(g *fakeGitHub, s *Store) {
			if _, err := s.FullPullRequest(ctx, "o/r", number, false); err != nil {
				t.Fatal(err)
			}
			then(g)
		}
	}
	tests := []struct {
		name   string
		number int
		closed bool
		setup  func(g *fakeGitHub, s *Store)
		want   ClosedResult
		err    error
		errHas string
		// calls are the mutations sent ("op id").
		calls []string
	}{
		{name: "an open one closed", number: 1, closed: true,
			want: ClosedResult{State: PullRequestClosed, Message: "Closed #1"}, calls: []string{"ClosePullRequest PR_1"}},
		{name: "a draft closed", number: 2, closed: true,
			want: ClosedResult{State: PullRequestClosed, Message: "Closed #2"}, calls: []string{"ClosePullRequest PR_2"}},
		{name: "a closed one reopened", number: 1, setup: closeIt("PR_1"),
			want: ClosedResult{State: PullRequestOpen, Message: "Reopened #1"}, calls: []string{"ReopenPullRequest PR_1"}},
		{name: "closing a closed one: refused, no mutation", number: 1, closed: true, setup: closeIt("PR_1"),
			err: ErrFailedPrecondition, errHas: "pull request #1 is closed, not open"},
		{name: "closing a merged one: refused, no mutation", number: 3, closed: true,
			err: ErrFailedPrecondition, errHas: "pull request #3 is merged, not open"},
		{name: "reopening an open one: refused, no mutation", number: 1,
			err: ErrFailedPrecondition, errHas: "pull request #1 is already open"},
		{name: "reopening a merged one: refused, no mutation", number: 3,
			err: ErrFailedPrecondition, errHas: "pull request #3 is merged; a merged pull request cannot be reopened"},
		{name: "the viewer may not close: refused, no mutation", number: 1, closed: true,
			setup: func(g *fakeGitHub, _ *Store) { g.denyClose(true) },
			err:   ErrPermissionDenied, errHas: "GitHub does not let you close pull request #1 in o/r"},
		{name: "the viewer may not reopen: refused, no mutation", number: 1,
			setup: func(g *fakeGitHub, s *Store) { closeIt("PR_1")(g, s); g.denyClose(true) },
			err:   ErrPermissionDenied, errHas: "GitHub does not let you reopen pull request #1"},
		{name: "the cache would refuse, a fresh look lets it through", number: 1,
			setup: cached(1, func(g *fakeGitHub) { g.edit("PR_1", func(p *PullRequest) { p.State = PullRequestClosed }) }),
			want:  ClosedResult{State: PullRequestOpen, Message: "Reopened #1"}, calls: []string{"ReopenPullRequest PR_1"}},
		{name: "a cached copy without the permission is looked at again", number: 1, closed: true,
			setup: func(g *fakeGitHub, s *Store) {
				g.denyClose(true)
				cached(1, func(g *fakeGitHub) { g.denyClose(false) })(g, s)
			},
			want: ClosedResult{State: PullRequestClosed, Message: "Closed #1"}, calls: []string{"ClosePullRequest PR_1"}},
		{name: "merged on GitHub since it was cached: GitHub's answer is reported", number: 1, closed: true,
			setup: cached(1, func(g *fakeGitHub) { g.edit("PR_1", func(p *PullRequest) { p.State = PullRequestMerged }) }),
			want:  ClosedResult{State: PullRequestMerged, Message: "GitHub accepted closing it (#1), but reports it merged"},
			calls: []string{"ClosePullRequest PR_1"}},
		{name: "FORBIDDEN is permission denied", number: 1, closed: true,
			setup: func(g *fakeGitHub, _ *Store) {
				g.refuseStateChanges("FORBIDDEN", "Resource not accessible by integration")
			},
			err: ErrPermissionDenied, errHas: "Resource not accessible", calls: []string{"ClosePullRequest PR_1"}},
		{name: "another refusal is a failed precondition with GitHub's message", number: 1, closed: true,
			setup: func(g *fakeGitHub, _ *Store) { g.refuseStateChanges("UNPROCESSABLE", "Pull request is locked") },
			err:   ErrFailedPrecondition, errHas: "Pull request is locked", calls: []string{"ClosePullRequest PR_1"}},
		{name: "unknown pull request", number: 99, closed: true, err: ErrNotFound},
		{name: "bad number", number: 0, err: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			g, _, s, _, events := mergeWorld(t)
			if tt.setup != nil {
				tt.setup(g, s)
			}
			drain(events)
			got, err := s.SetPullRequestClosed(ctx, "o/r", tt.number, tt.closed)
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
			// The next read fetches: the detail shows the new state, and what the viewer
			// may do next.
			d, err := s.FullPullRequest(ctx, "o/r", tt.number, false)
			reopenable := tt.want.State == PullRequestClosed
			if err != nil || d.PullRequest.State != tt.want.State || d.ViewerCanReopen != reopenable || !d.ViewerCanClose {
				t.Errorf("detail state = %s (can close %t, reopen %t), %v; want %s", d.PullRequest.State, d.ViewerCanClose, d.ViewerCanReopen, err, tt.want.State)
			}
		})
	}
}

func TestDecodeClosed(t *testing.T) {
	tests := []struct {
		name   string
		data   string
		closed bool
		want   PullRequestState
		bad    bool
	}{
		{name: "closed", data: `{"closePullRequest":{"pullRequest":{"state":"CLOSED"}}}`, closed: true, want: PullRequestClosed},
		{name: "reopened", data: `{"reopenPullRequest":{"pullRequest":{"state":"OPEN"}}}`, want: PullRequestOpen},
		{name: "the other payload", data: `{"closePullRequest":{"pullRequest":{"state":"CLOSED"}}}`, bad: true},
		{name: "no pull request", data: `{"closePullRequest":{"pullRequest":null}}`, closed: true, bad: true},
		{name: "not JSON", data: `{`, closed: true, bad: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := decodeClosed([]byte(tt.data), tt.closed)
			if (err != nil) != tt.bad || got.State != tt.want {
				t.Errorf("got %+v, %v; want %s (error %t)", got, err, tt.want, tt.bad)
			}
		})
	}
}
