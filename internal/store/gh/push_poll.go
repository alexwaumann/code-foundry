package gh

import (
	"context"
	"time"
)

// pushPollGap is the least time from the end of one poll to a poll a push asked for
// (BranchPushed). It is the hot poll's anti-duplication window (hotSkipMax): the store
// already treats a full poll and a hot poll within it as duplicates and runs only one.
// At the default MinGap (1 s) it leaves two request slots between pushed polls for
// on-demand reads and the hot poll, where a burst of pushes used to poll back to back.
// A push after a quiet stretch still polls at once; one inside the gap waits at most
// pushPollGap - MinGap (2 s) longer than it did, since the poll was already held to
// MinGap after the previous request.
const pushPollGap = hotSkipMax

// BranchPushed tells the store that branch head of slug just changed on GitHub: a push,
// or a pull request created from it (the gitops bridge, after Push and CreatePR). It
// keeps the branch in the poll as BranchPullRequests does and asks for a poll, which
// runs at once when no poll ended within pushPollGap, otherwise when that gap is over.
// Pushes inside the gap share that one poll, and a push during a poll brings one more
// pushPollGap after it ends, so none is lost. With slug or head empty it only asks for
// the poll; an invalid one is returned after the poll was asked for.
//
// It never waits on GitHub and is for background notifications only. Refresh is the
// unspaced form a person waits on; this one leaves the auth check's schedule alone
// (a push does not change gh's login, and while gh is not authenticated the auth check
// runs on its own backoff instead of the poll).
func (s *Store) BranchPushed(ctx context.Context, slug, head string) error {
	if slug != "" && head != "" {
		_, err := s.branchesPullRequests(ctx, []BranchQuery{{Slug: slug, HeadRef: head}}, true)
		if err == nil {
			return nil
		}
		s.pollAfterPush()
		return err
	}
	s.pollAfterPush()
	return nil
}

func (s *Store) pollAfterPush() {
	now := s.opts.Now()
	s.mu.Lock()
	s.pollAfterPushLocked(now)
	s.mu.Unlock()
	s.nudge()
}

// pollAfterPushLocked moves the next poll to pushPollGap after the last one ended, or to
// now when that is past; a sooner poll is left alone. A poll running now (it may have
// planned before the push) is followed by one more, pushPollGap after it ends
// (schedulePollLocked). Called with s.mu held.
func (s *Store) pollAfterPushLocked(now time.Time) {
	s.pushAgain = true
	if at := laterOf(now, s.lastPoll.Add(pushPollGap)); s.pollNext.After(at) {
		s.pollNext = at
	}
}

func earlierOf(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
