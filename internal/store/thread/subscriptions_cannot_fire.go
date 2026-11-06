package thread

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Wakes that can never fire (docs/notes/subscribe-cannot-fire.md). Subscribe refuses one
// when it knows, and warns when the wake may still fire or the answer is unknown
// (SubscribeResult.Warnings). For a pull request it asks GitHub once (checkPullRequest).
// After that only a change the poll reports moves anything (PullRequestChanged): a cached
// copy can predate a reopening, so it neither refuses, fires nor ends a subscription.

// prLookupTimeout bounds Subscribe's question to GitHub.
const prLookupTimeout = 5 * time.Second

// checkPullRequest asks GitHub about target for a subscription with condition c, off the
// locks. It returns the pull request and a warning, or the refusal. A failed question
// refuses nothing: the subscription stays, nil and warned about. A caller that gave up gets
// its error: it would never see a subscription made for it.
func (m *Manager) checkPullRequest(caller context.Context, target string, c Condition) (*PullRequestInfo, string, error) {
	ctx, cancel := context.WithTimeout(caller, prLookupTimeout)
	defer cancel()
	p, err := m.opts.LookupPullRequest(ctx, target)
	switch {
	case caller.Err() != nil:
		return nil, "", caller.Err()
	case errors.Is(err, ErrNotFound):
		return nil, "", fmt.Errorf("%w: pull request %s does not exist, or this GitHub login cannot see it; check the owner, name and number",
			ErrFailedPrecondition, target)
	case err != nil:
		return nil, fmt.Sprintf("could not check pull request %s on GitHub (%s), so it was subscribed unchecked: it may be closed, merged or missing, and this may never fire",
			target, oneLine(err.Error(), maxHeaderSummary)), nil
	case !prCannotFire(c, p):
		if p.State == "closed" && c == CondChanged {
			return &p, "pull request " + target + " is closed, so this fires only if it reopens or its title changes", nil
		}
		return &p, "", nil
	case p.State == "merged":
		return nil, "", fmt.Errorf("%w: pull request %s is merged, so nothing more will happen to it; act on the merge now instead of waiting",
			ErrFailedPrecondition, target)
	}
	return nil, "", fmt.Errorf("%w: pull request %s is closed, so %s cannot fire; reopen it and subscribe again, or use --until changed to hear if it reopens",
		ErrFailedPrecondition, target, c)
}

// prCannotFire reports whether c cannot fire on p. diffPullRequest compares reviews,
// comments and review requests only between two open copies, and a closed pull request
// has no checks to finish, takes no push and cannot merge, so a close leaves closed and
// changed (which hears the reopening). Reopening would bring the rest back, but the
// caller who reopens it can subscribe then.
func prCannotFire(c Condition, p PullRequestInfo) bool {
	switch p.State {
	case "merged":
		return c != CondMerged
	case "closed":
		return c != CondClosed && c != CondChanged
	}
	return false
}

// prEndedWake is the last wake of sub, which can no longer fire on p after changes:
// `Pull request acme/web#12 "Fix login": closed without merging, so checks_done can no
// longer fire and the subscription ended. Subscribe again if it reopens.`
func prEndedWake(sub Subscription, p PullRequestInfo, changes []PullRequestChange, at time.Time) Message {
	payload := prPayload(sub, p, changes, at)
	payload.Ended = true
	state, next := CondMerged, ""
	if p.State == "closed" {
		state, next = CondClosed, " Subscribe again if it reopens."
	}
	what := strings.TrimSuffix(prWakeTitle(state, p, nil), ".")
	return wakeMessage(fmt.Sprintf("%s, so %s can no longer fire and the subscription ended.%s", what, sub.Condition, next), payload)
}

// threadWarning is Subscribe's warning about a subscription to thread t that did not
// fire: a stopped thread changes only when someone sends it a message. "" for none.
func threadWarning(c Condition, t Thread) string {
	if t.State != StateDisconnected {
		return ""
	}
	return fmt.Sprintf("thread %s is stopped, so it reaches %s only after someone sends it a message", t.ID, c)
}

// pluginWarning is Subscribe's warning about a source of a plugin in state status: an
// enabled plugin re-arms when it starts, but fires nothing until then. "" for none.
func pluginWarning(target, status string) string {
	if status == "running" || status == "starting" {
		return ""
	}
	return fmt.Sprintf("the plugin of %s is %s, so this fires only once it runs again", target, status)
}
