package daemon

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
)

// The GitHub notifications' rules (docs/notes/notifications-github.md): a pure function
// from the GitHub store's dashboard (and the threads linked to its pull requests, and
// the projects tracking its repositories) to the cards that should be in the bell, and
// to which of the source's active cards are known to be gone. Only positive knowledge
// withdraws: a pull request missing from a list cut at its page size, or known only by
// its fingerprint, keeps its cards as they are.

// githubSource is the notifications' source; the bell shows it as "GitHub".
const githubSource = "github"

// ghKind is one of the four notifications a pull request can have.
type ghKind string

const (
	ghReviewRequested  ghKind = "review-requested"
	ghReviewAgain      ghKind = "review-again"
	ghChangesRequested ghKind = "changes-requested"
	ghConflict         ghKind = "conflict"
)

var ghKinds = []ghKind{ghReviewRequested, ghReviewAgain, ghChangesRequested, ghConflict}

// ghPR is a pull request: its repository ("owner/name", lower case) and number.
type ghPR struct {
	repo   string
	number int
}

func ghPROf(p gh.PullRequest) ghPR { return ghPR{strings.ToLower(p.Repo), p.Number} }

// ghKey is the stable key of a pull request's notification of one kind:
// "pr/<owner>/<name>#<number>/<kind>". A change of the card updates it in place.
func ghKey(pr ghPR, k ghKind) string {
	return fmt.Sprintf("pr/%s#%d/%s", pr.repo, pr.number, k)
}

// parseGhKey is ghKey's inverse.
func parseGhKey(key string) (ghPR, ghKind, bool) {
	rest, ok := strings.CutPrefix(key, "pr/")
	if !ok {
		return ghPR{}, "", false
	}
	i, j := strings.LastIndexByte(rest, '#'), strings.LastIndexByte(rest, '/')
	if i <= 0 || j < i {
		return ghPR{}, "", false
	}
	n, err := strconv.Atoi(rest[i+1 : j])
	k := ghKind(rest[j+1:])
	if err != nil || n <= 0 || !strings.Contains(rest[:i], "/") {
		return ghPR{}, "", false
	}
	for _, known := range ghKinds {
		if k == known {
			return ghPR{rest[:i], n}, k, true
		}
	}
	return ghPR{}, "", false
}

// ghNotifyInput is what the notifications are computed from.
type ghNotifyInput struct {
	// Off: the user turned the source off (github.dashboards_enabled off): every card
	// goes and none is posted.
	Off bool
	// Viewer is the viewer's login; "" when the store does not know it (signed out, or
	// never polled): nothing is posted or withdrawn.
	Viewer    string
	Dashboard gh.Dashboard
	// Threads names the thread linked to each pull request (pickLinkedThreads).
	Threads map[ghPR]string
	// Projects names the project tracking each repository (lower-case slug).
	Projects map[string]string
}

// ghPlan is an evaluation's outcome: the cards that should be posted, and which of the
// source's other active cards are known to be gone.
type ghPlan struct {
	Posts []notification.Post
	// known is false when the input says nothing (no viewer, never polled): nothing is
	// withdrawn.
	known bool
	off   bool
	idx   ghIndex
	post  map[string]bool
}

// Withdraw reports whether the source's active card with key must go: it is not among
// the posts and its condition is known to be gone.
func (p ghPlan) Withdraw(key string) bool {
	switch {
	case p.off:
		return true
	case !p.known || p.post[key]:
		return false
	}
	pr, k, ok := parseGhKey(key)
	if !ok {
		return true // not a key this version posts
	}
	return p.idx.gone(pr, k)
}

// ghIndex is the dashboard's lists by pull request, and which lists are whole.
type ghIndex struct {
	viewer                                string
	requested, reviewed, authored, merged map[ghPR]gh.PullRequest
	// A list is whole when it holds every pull request its search matched: then a pull
	// request missing from it is positively not in it.
	requestedWhole, reviewedWhole, authoredWhole bool
}

func indexDashboard(d gh.Dashboard, viewer string) ghIndex {
	by := func(list []gh.PullRequest) map[ghPR]gh.PullRequest {
		m := make(map[ghPR]gh.PullRequest, len(list))
		for _, p := range list {
			if p.Repo != "" && p.Number > 0 {
				if _, dup := m[ghPROf(p)]; !dup {
					m[ghPROf(p)] = p
				}
			}
		}
		return m
	}
	return ghIndex{
		viewer:    viewer,
		requested: by(d.ReviewRequested), reviewed: by(d.Reviewed), authored: by(d.Authored), merged: by(d.RecentlyMerged),
		requestedWhole: len(d.ReviewRequested) >= d.ReviewRequestedTotal,
		reviewedWhole:  d.ReviewedListed >= d.ReviewedTotal,
		authoredWhole:  len(d.Authored) >= d.AuthoredTotal,
	}
}

// closed reports whether pr is known to be merged or closed: in recently merged, or in
// a list with a state other than open (GitHub's search index trails a merge; the
// fingerprint's state does not).
func (x ghIndex) closed(pr ghPR) bool {
	if _, ok := x.merged[pr]; ok {
		return true
	}
	for _, m := range []map[ghPR]gh.PullRequest{x.requested, x.reviewed, x.authored} {
		if p, ok := m[pr]; ok && p.State != "" && p.State != gh.PullRequestOpen {
			return true
		}
	}
	return false
}

// gone reports whether pr's card of kind k is known to be gone, given that the
// evaluation does not post it.
func (x ghIndex) gone(pr ghPR, k ghKind) bool {
	if x.closed(pr) {
		return true
	}
	req, inReq := x.requested[pr]
	rev, inRev := x.reviewed[pr]
	auth, inAuth := x.authored[pr]
	switch k {
	case ghReviewRequested:
		switch {
		case inReq:
			return !req.Partial // a draft now; a placeholder waits for its detail
		case inRev, inAuth:
			return true
		}
		return x.requestedWhole
	case ghReviewAgain:
		switch {
		case inReq, inAuth:
			return true // a new request takes over; or it is the viewer's own
		case inRev:
			return !rev.Partial && rev.ReviewCommits // reviewed on the head, or a draft now
		}
		return x.reviewedWhole
	case ghChangesRequested, ghConflict:
		switch {
		case inAuth:
			if auth.Partial {
				return false
			}
			if k == ghChangesRequested {
				return auth.ReviewCommits
			}
			return auth.Mergeable == gh.MergeableMergeable // UNKNOWN: GitHub is still computing it
		case inReq, inRev:
			return true
		}
		return x.authoredWhole
	}
	return true
}

// planGitHubNotifications computes the cards from in.
func planGitHubNotifications(in ghNotifyInput) ghPlan {
	if in.Off {
		return ghPlan{off: true}
	}
	if in.Viewer == "" || in.Dashboard.FetchedAt.IsZero() || in.Dashboard.Disabled {
		return ghPlan{off: in.Dashboard.Disabled}
	}
	x := indexDashboard(in.Dashboard, in.Viewer)
	plan := ghPlan{known: true, idx: x, post: map[string]bool{}}
	add := func(p notification.Post) {
		if !plan.post[p.Key] {
			plan.post[p.Key] = true
			plan.Posts = append(plan.Posts, p)
		}
	}
	for _, p := range in.Dashboard.ReviewRequested {
		if prOpen(p, x) && !p.Partial && !p.Draft {
			add(reviewRequestedPost(p, in))
		}
	}
	for _, p := range in.Dashboard.Reviewed {
		if _, req := x.requested[ghPROf(p)]; req || !prOpen(p, x) || p.Partial || p.Draft || !p.ReviewCommits {
			continue
		}
		if why, ok := reviewAgain(p, in.Viewer); ok {
			add(reviewAgainPost(p, why, in))
		}
	}
	for _, p := range in.Dashboard.Authored {
		if !prOpen(p, x) || p.Partial {
			continue
		}
		if who := changesRequestedBy(p, in.Viewer); p.ReviewCommits && len(who) > 0 {
			add(changesRequestedPost(p, who, in))
		}
		if p.Mergeable == gh.MergeableConflicting {
			add(conflictPost(p, in))
		}
	}
	return plan
}

func prOpen(p gh.PullRequest, x ghIndex) bool {
	return p.Repo != "" && p.Number > 0 && p.URL != "" && !x.closed(ghPROf(p))
}

// ghWhy is why a reviewed pull request needs the viewer's review again.
type ghWhy int

const (
	whyNewCommits ghWhy = iota
	whyDismissed
)

// reviewAgain is the PRs inbox's stale rule (gui/frontend/src/components/prs/reviewQueue.ts,
// docs/notes/prs-inbox-2-gui.md) for a pull request in the reviewed list: the viewer's
// latest review is not on the head (one without a commit counts: GitHub has none when a
// force-push dropped it), or it was dismissed. An unknown head never makes it stale, and
// no review of the viewer's reads as "commented", not stale.
func reviewAgain(p gh.PullRequest, viewer string) (ghWhy, bool) {
	mine, ok := latestReviewBy(p, viewer)
	switch {
	case !ok:
		return 0, false
	case p.HeadSHA != "" && mine.CommitSHA != p.HeadSHA:
		return whyNewCommits, true
	case strings.EqualFold(mine.State, "DISMISSED"):
		return whyDismissed, true
	}
	return 0, false
}

func latestReviewBy(p gh.PullRequest, login string) (gh.Review, bool) {
	for _, r := range p.LatestReviews {
		if strings.EqualFold(r.Author, login) {
			return r, true
		}
	}
	return gh.Review{}, false
}

// changesRequestedBy is who requested changes on the viewer's pull request at its head
// commit: each reviewer's latest review, CHANGES_REQUESTED, on the head. A push moves the
// head past them; an approval or a dismissal replaces the latest review.
func changesRequestedBy(p gh.PullRequest, viewer string) []string {
	if p.HeadSHA == "" {
		return nil
	}
	var who []string
	for _, r := range p.LatestReviews {
		if strings.EqualFold(r.State, string(gh.ReviewChangesRequested)) && r.CommitSHA == p.HeadSHA &&
			r.Author != "" && !strings.EqualFold(r.Author, viewer) {
			who = append(who, r.Author)
		}
	}
	return who
}

// Card text.

const (
	labelOpenPR    = "Open PR"
	labelReview    = "Review in a thread"
	labelSend      = "Send to thread"
	labelFix       = "Fix in a thread"
	readOnlyReview = "Do not submit a review or post comments on GitHub: tell me what you find and I will decide what to send."
)

// prName is "owner/name #N" as GitHub spells the repository (its URL), else the store's
// lower-case slug.
func ghPRName(p gh.PullRequest) string {
	repo := p.Repo
	if u, err := url.Parse(p.URL); err == nil {
		if parts := strings.Split(strings.Trim(u.Path, "/"), "/"); len(parts) >= 2 && strings.EqualFold(parts[0]+"/"+parts[1], p.Repo) {
			repo = parts[0] + "/" + parts[1]
		}
	}
	return fmt.Sprintf("%s #%d", repo, p.Number)
}

// prRefText is "owner/name#N" for a prompt.
func ghPRRef(p gh.PullRequest) string { return strings.Replace(ghPRName(p), " #", "#", 1) }

func cardBody(p gh.PullRequest, what string) string {
	s := ghPRName(p)
	if p.Title != "" {
		s += " " + p.Title
	}
	return s + " · " + what
}

func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func byAuthor(p gh.PullRequest) string {
	if p.Author == "" {
		return ""
	}
	return "by " + p.Author + ", "
}

func openAction(p gh.PullRequest) notification.ActionSpec {
	return notification.ActionSpec{Action: notification.Action{Label: labelOpenPR, Kind: notification.KindOpen, URL: p.URL}}
}

func startAction(label, prompt string, p gh.PullRequest, in ghNotifyInput) notification.ActionSpec {
	return notification.ActionSpec{Action: notification.Action{Label: label, Kind: notification.KindStart, Prompt: prompt,
		ProjectID: in.Projects[strings.ToLower(p.Repo)]}}
}

func reviewRequestedPost(p gh.PullRequest, in ghNotifyInput) notification.Post {
	// GitHub's search matched the viewer; the requests say how, when they are known.
	what := "your review is requested"
	switch {
	case requestsName(p.ReviewRequests, in.Viewer):
		what = "requested from you"
	case len(p.ReviewRequests) > 0:
		what = "requested from your team"
	}
	prompt := fmt.Sprintf("Review pull request %s, %q (%s). Read its description and diff and look for bugs, risks and questions for the author. %s",
		ghPRRef(p), p.Title, p.URL, readOnlyReview)
	return notification.Post{
		Source: githubSource, Key: ghKey(ghPROf(p), ghReviewRequested), Level: notification.LevelInfo, TimeSensitive: true,
		Title: "Review requested", Body: cardBody(p, byAuthor(p)+what),
		Actions: []notification.ActionSpec{openAction(p), startAction(labelReview, prompt, p, in)},
	}
}

func requestsName(requests []string, viewer string) bool {
	for _, r := range requests {
		if strings.EqualFold(r, viewer) {
			return true
		}
	}
	return false
}

func reviewAgainPost(p gh.PullRequest, why ghWhy, in ghNotifyInput) notification.Post {
	mine, _ := latestReviewBy(p, in.Viewer)
	what, since := "changed since your review", fmt.Sprintf("It changed since my last review; the head is now %s.", shortSHA(p.HeadSHA))
	if mine.CommitSHA != "" && why == whyNewCommits {
		since = fmt.Sprintf("It changed since my last review (on %s); the head is now %s: look at what changed since then.", shortSHA(mine.CommitSHA), shortSHA(p.HeadSHA))
	}
	if why == whyDismissed {
		what, since = "your review was dismissed", fmt.Sprintf("My review was dismissed; the head is %s.", shortSHA(p.HeadSHA))
	}
	// The head is in the prompt, so each push is new content: a dismissed card comes back.
	prompt := fmt.Sprintf("Review pull request %s, %q (%s), again. %s %s", ghPRRef(p), p.Title, p.URL, since, readOnlyReview)
	return notification.Post{
		Source: githubSource, Key: ghKey(ghPROf(p), ghReviewAgain), Level: notification.LevelInfo, TimeSensitive: true,
		Title: "Review again", Body: cardBody(p, byAuthor(p)+what),
		Actions: []notification.ActionSpec{openAction(p), startAction(labelReview, prompt, p, in)},
	}
}

// names is "a", "a and b", or "a, b and N others".
func reviewerNames(who []string) string {
	switch len(who) {
	case 1:
		return who[0]
	case 2:
		return who[0] + " and " + who[1]
	case 3:
		return who[0] + ", " + who[1] + " and 1 other"
	}
	return fmt.Sprintf("%s, %s and %d others", who[0], who[1], len(who)-2)
}

// threadAction is the card's thread button: a send to the linked thread (named on the
// card), else a start.
func threadAction(p gh.PullRequest, in ghNotifyInput, send, start string) (string, notification.ActionSpec) {
	if id := in.Threads[ghPROf(p)]; id != "" {
		return id, notification.ActionSpec{Action: notification.Action{Label: labelSend, Kind: notification.KindSend, ThreadID: id, Text: send}}
	}
	return "", startAction(labelFix, start, p, in)
}

func prBranchText(p gh.PullRequest) string {
	if p.HeadRef == "" {
		return "its branch"
	}
	return "its branch " + p.HeadRef
}

func changesRequestedPost(p gh.PullRequest, who []string, in ghNotifyInput) notification.Post {
	// The head is in the texts: a new round of changes requested after a push is new
	// content, so a dismissed card comes back for it.
	about := fmt.Sprintf("%s (%s): %s requested changes on %s.", ghPRRef(p), p.URL, reviewerNames(who), shortSHA(p.HeadSHA))
	thread, act := threadAction(p, in,
		"Changes were requested on "+about+" Read the review comments, address them and push.",
		fmt.Sprintf("Changes were requested on my pull request %s, %q. %s Check out %s, read the review comments, address them and push.",
			ghPRRef(p), p.Title, about, prBranchText(p)))
	return notification.Post{
		Source: githubSource, Key: ghKey(ghPROf(p), ghChangesRequested), Level: notification.LevelWarning,
		Title: "Changes requested on your PR", Body: cardBody(p, reviewerNames(who)+" requested changes"), ThreadID: thread,
		Actions: []notification.ActionSpec{openAction(p), act},
	}
}

func conflictPost(p gh.PullRequest, in ghNotifyInput) notification.Post {
	base := p.BaseRef
	if base == "" {
		base = "its base"
	}
	about := fmt.Sprintf("%s (%s) has a merge conflict with %s (head %s).", ghPRRef(p), p.URL, base, shortSHA(p.HeadSHA))
	thread, act := threadAction(p, in,
		about+" Bring the branch up to date with "+base+", resolve the conflicts and push.",
		fmt.Sprintf("My pull request %s, %q: %s Check out %s, bring it up to date with %s, resolve the conflicts and push.",
			ghPRRef(p), p.Title, about, prBranchText(p), base))
	return notification.Post{
		Source: githubSource, Key: ghKey(ghPROf(p), ghConflict), Level: notification.LevelWarning,
		Title: "Merge conflict on your PR", Body: cardBody(p, "conflicts with "+base), ThreadID: thread,
		Actions: []notification.ActionSpec{openAction(p), act},
	}
}
