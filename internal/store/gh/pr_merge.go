package gh

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// Merging from the detail panel (MergePullRequest): one GraphQL mutation guarded by the
// head commit the store last fetched, then optionally a REST delete of the head branch.
// Both are paced requests on the store's worker; neither is ever retried.

const queryMergePullRequest = "merge_pull_request"

// restGitRef is the REST path of a branch ref: owner, name, branch (escaped per path
// segment).
const restGitRef = "repos/%s/%s/git/refs/heads/%s"

// branchDeleteTimeout bounds the branch delete after a merge. It runs even when the
// caller has gone (the merge happened, and the user asked for the delete).
const branchDeleteTimeout = 30 * time.Second

// MergePullRequest implements Service. The pull request must be open and not a draft,
// and the method allowed by the repository; the cached detail (refetched once before
// refusing) supplies the node id and the head commit GitHub must still have. With
// r.ExpectedHeadSHA (the head the client showed) the merge is refused unless the head
// is still that commit, so a detail refetched since cannot slip unseen commits in.
// Merges of one pull request run one at a time; within writeMemoTTL of a merge,
// another call returns the first's outcome instead of sending the mutation again.
func (s *Store) MergePullRequest(ctx context.Context, slug string, number int, r MergeRequest) (MergeResult, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return MergeResult{}, err
	}
	switch r.Method {
	case MergeCommit, MergeSquash, MergeRebase:
	default:
		return MergeResult{}, fmt.Errorf("%w: merge method %q", ErrInvalidArgument, r.Method)
	}
	if r.ExpectedHeadSHA != "" && !isCommitSHA(r.ExpectedHeadSHA) {
		return MergeResult{}, fmt.Errorf("%w: expected head %q is not a full commit SHA", ErrInvalidArgument, r.ExpectedHeadSHA)
	}
	unlock, err := s.full.mergeLocks.lock(ctx, k)
	if err != nil {
		return MergeResult{}, err
	}
	defer unlock()
	if m, ok := s.full.merges.recent(k, s.opts.Now()); ok {
		return repeatMerge(m, r)
	}
	d, err := s.FullPullRequest(ctx, k.slug, k.number, false)
	if err != nil {
		return MergeResult{}, err
	}
	if mergeRefusal(&d, r.Method) != "" || headDiffers(&d, r) || (r.DeleteBranch && d.DefaultBranch == "") {
		// The cached copy may be behind (marked ready, reopened, settings changed,
		// pushed to, a row cached before the default branch was fetched): only a fresh
		// look may refuse, and it must succeed.
		if d, err = s.fetchFullJob(ctx, k); err != nil {
			return MergeResult{}, fmt.Errorf("pull request #%d: cannot confirm it can be merged: %w", k.number, err)
		}
	}
	if why := mergeRefusal(&d, r.Method); why != "" {
		return MergeResult{}, fmt.Errorf("%w: pull request #%d %s", ErrFailedPrecondition, k.number, why)
	}
	pr := d.PullRequest
	if pr.ID == "" || pr.HeadSHA == "" {
		return MergeResult{}, fmt.Errorf("pull request #%d: no node id or head commit", k.number)
	}
	head := pr.HeadSHA
	if r.ExpectedHeadSHA != "" {
		if headDiffers(&d, r) {
			// The client shows other commits than GitHub has: it must re-read first.
			s.invalidateFull(k)
			return MergeResult{}, fmt.Errorf("%w: pull request #%d changed since it was shown (head %s, shown %s); refresh and try again",
				ErrFailedPrecondition, k.number, short(pr.HeadSHA), short(r.ExpectedHeadSHA))
		}
		head = r.ExpectedHeadSHA
	}
	var unknown bool
	res, err := submitFunc(ctx, s, "merge|"+k.String(), func(ctx context.Context) (MergeResult, error) {
		data, err := s.call(ctx, queryMergePullRequest, map[string]any{"id": pr.ID, "method": string(r.Method), "head": head})
		var pe *PartialError
		switch {
		case errors.As(err, &pe):
			// GitHub refused the merge (conflicts, protection, head moved): nothing merged.
			return MergeResult{}, mergeRefused(k, &pr, pe)
		case outcomeUnknown(err):
			now := s.opts.Now()
			err = fmt.Errorf("pull request #%d: GitHub did not confirm the merge, and it may have merged; "+
				"check GitHub before trying again (until %s a retry returns this error): %w",
				k.number, now.Add(writeMemoTTL).Local().Format(time.TimeOnly), err)
			s.full.merges.remember(k, writeMemo[mergeMemo]{err: err, at: now})
			unknown = true
			return MergeResult{}, err
		case err != nil:
			return MergeResult{}, err
		}
		o, err := decodeMerge(data)
		if err != nil {
			return MergeResult{}, err
		}
		return MergeResult{Merged: o.Merged || o.State == PullRequestMerged, SHA: o.SHA}, nil
	})
	if err != nil {
		if unknown || errors.Is(err, ErrFailedPrecondition) {
			// GitHub knows a state the cache does not (or may: it did not answer): let
			// clients re-read.
			s.invalidateFull(k)
		}
		return MergeResult{}, err
	}
	res = s.finishMerge(ctx, k, &d, r, res)
	s.log.Info("gh pull request merged", "pr", k.String(), "method", r.Method, "merged", res.Merged,
		"sha", res.SHA, "branch_deleted", res.BranchDeleted)
	s.invalidateFull(k)
	// The dashboards move it to recently merged: poll soon.
	s.mu.Lock()
	s.pollSoonLocked(s.opts.Now())
	s.mu.Unlock()
	s.nudge()
	return res, nil
}

// mergeMemo is a merge's complete result, and whether it was asked to delete the branch.
type mergeMemo struct {
	res         MergeResult
	deleteAsked bool
}

// repeatMerge answers a merge within writeMemoTTL of the first: its outcome, plus that
// the branch stays when only the repeat asks to delete it.
func repeatMerge(m writeMemo[mergeMemo], r MergeRequest) (MergeResult, error) {
	if m.err != nil {
		return MergeResult{}, m.err
	}
	res := m.res.res
	if r.DeleteBranch && !m.res.deleteAsked && res.Merged {
		res.Message += "; branch not deleted: the first merge did not ask"
	}
	return res, nil
}

// finishMerge deletes the head branch on GitHub when asked and allowed, writes the
// message, and remembers the complete result for repeats.
func (s *Store) finishMerge(ctx context.Context, k fullKey, d *FullPullRequest, r MergeRequest, res MergeResult) MergeResult {
	pr := d.PullRequest
	if !res.Merged {
		res.Message = fmt.Sprintf("GitHub accepted the merge of #%d, but it is not merged yet", k.number)
	} else {
		res.Message = fmt.Sprintf("Merged #%d", k.number)
		if res.SHA != "" {
			res.Message += fmt.Sprintf(" (%s)", short(res.SHA))
		}
		remote := "origin/" + pr.HeadRef
		switch {
		case !r.DeleteBranch || pr.HeadRef == "":
		case pr.IsCrossRepository:
			// Not on origin: named as the fork has it.
			res.Message += fmt.Sprintf("; kept %s: it is in a fork", pr.HeadRef)
		case keepBranch(d) != "":
			res.Message += fmt.Sprintf("; kept %s: %s", remote, keepBranch(d))
		default:
			ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), branchDeleteTimeout)
			err := s.deleteBranch(ctx, k, pr.HeadRef)
			cancel()
			if err != nil {
				s.log.Warn("gh head branch delete failed", "pr", k.String(), "branch", pr.HeadRef, "err", err)
				res.Message += fmt.Sprintf("; kept %s: %v", remote, err)
			} else {
				res.BranchDeleted = true
				res.Message += fmt.Sprintf("; deleted %s", remote)
			}
		}
	}
	s.full.merges.remember(k, writeMemo[mergeMemo]{res: mergeMemo{res: res, deleteAsked: r.DeleteBranch}, at: s.opts.Now()})
	return res
}

// keepBranch says why a merge must not delete d's head branch even when asked (a
// fork's branch aside), or "". The default branch and the base branch are never
// deleted; an unknown default branch could be either.
func keepBranch(d *FullPullRequest) string {
	head := d.PullRequest.HeadRef
	switch {
	case d.DefaultBranch == "":
		return "the repository's default branch is unknown"
	case head == d.DefaultBranch:
		return "it is the repository's default branch"
	case head == d.PullRequest.BaseRef:
		return "it is the base branch"
	}
	return ""
}

// mergeRefused maps GitHub's refusal of a merge mutation. Rate limits, permissions and
// a missing pull request keep their kinds; anything else (UNPROCESSABLE, or a part with
// no or an unknown type) is a failed precondition with GitHub's message, and a moved
// head or base says so.
func mergeRefused(k fullKey, pr *PullRequest, pe *PartialError) error {
	cls := pe.Unwrap()
	if errors.Is(cls, ErrRateLimited) || errors.Is(cls, ErrPermissionDenied) || errors.Is(cls, ErrNotFound) {
		return cls
	}
	switch branchMoved(pe) {
	case "head":
		return fmt.Errorf("%w: pull request #%d changed on GitHub since it was loaded (%s has new commits); "+
			"refresh and review it before merging", ErrFailedPrecondition, k.number, pr.HeadRef)
	case "base":
		return fmt.Errorf("%w: pull request #%d: its base branch %s changed on GitHub during the merge; "+
			"refresh and try again", ErrFailedPrecondition, k.number, pr.BaseRef)
	}
	msgs := make([]string, 0, len(pe.Errors))
	for _, e := range pe.Errors {
		msgs = append(msgs, e.Message)
	}
	return fmt.Errorf("%w: %s", ErrFailedPrecondition, strings.Join(msgs, "; "))
}

// headDiffers reports whether the client expects another head than d has.
func headDiffers(d *FullPullRequest, r MergeRequest) bool {
	return r.ExpectedHeadSHA != "" && !strings.EqualFold(d.PullRequest.HeadSHA, r.ExpectedHeadSHA)
}

// isCommitSHA reports whether s is a full hex commit id (SHA-1 or SHA-256).
func isCommitSHA(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

// short is a commit's first seven characters.
func short(sha string) string { return sha[:min(7, len(sha))] }

// keyLocks serializes work per pull request. The zero value is ready to use.
type keyLocks struct {
	mu sync.Mutex
	m  map[fullKey]chan struct{}
}

// lock waits until no one holds k (or ctx ends) and holds it until unlock.
func (l *keyLocks) lock(ctx context.Context, k fullKey) (unlock func(), err error) {
	for {
		l.mu.Lock()
		held, busy := l.m[k]
		if !busy {
			if l.m == nil {
				l.m = map[fullKey]chan struct{}{}
			}
			ch := make(chan struct{})
			l.m[k] = ch
			l.mu.Unlock()
			return func() {
				l.mu.Lock()
				delete(l.m, k)
				l.mu.Unlock()
				close(ch)
			}, nil
		}
		l.mu.Unlock()
		select {
		case <-held:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// deleteBranch deletes a branch of k's repository through REST. A branch GitHub already
// deleted (the repository deletes head branches on merge) counts as deleted.
func (s *Store) deleteBranch(ctx context.Context, k fullKey, branch string) error {
	rw, ok := s.opts.Runner.(RESTWriter)
	if !ok {
		return errors.New("the runner cannot send REST writes")
	}
	owner, name := splitSlug(k.slug)
	segs := strings.Split(branch, "/")
	for i, seg := range segs {
		segs[i] = url.PathEscape(seg)
	}
	path := fmt.Sprintf(restGitRef, owner, name, strings.Join(segs, "/"))
	_, err := submitFunc(ctx, s, "delete-branch|"+k.slug+"|"+branch, func(ctx context.Context) (struct{}, error) {
		_, err := s.restWrite(ctx, rw, http.MethodDelete, path, nil)
		return struct{}{}, err
	})
	if errors.Is(err, ErrFailedPrecondition) && strings.Contains(strings.ToLower(err.Error()), "reference does not exist") {
		return nil
	}
	return err
}

// mergeRefusal says why d cannot be merged with method ("is a draft"), or "".
func mergeRefusal(d *FullPullRequest, method MergeMethod) string {
	pr := d.PullRequest
	switch {
	case pr.State != PullRequestOpen:
		return fmt.Sprintf("is %s, not open", strings.ToLower(string(pr.State)))
	case pr.Draft:
		return "is a draft"
	case len(d.MergeMethods) > 0 && !slices.Contains(d.MergeMethods, method):
		return fmt.Sprintf("cannot be merged with %s: the repository does not allow it", mergeMethodName(method))
	}
	return ""
}

// mergeMethodName is a method as GitHub's merge button names it.
func mergeMethodName(m MergeMethod) string {
	switch m {
	case MergeSquash:
		return "squash"
	case MergeRebase:
		return "rebase"
	}
	return "a merge commit"
}

// branchMoved says which branch GitHub reports moved when it refused a merge: "head"
// ("Head branch was modified. Review and try the merge again."), "base" ("Base branch
// was modified."), or "".
func branchMoved(pe *PartialError) string {
	for _, e := range pe.Errors {
		m := strings.ToLower(e.Message)
		switch {
		case strings.Contains(m, "head branch was modified") || strings.Contains(m, "expected head"):
			return "head"
		case strings.Contains(m, "base branch was modified"):
			return "base"
		}
	}
	return ""
}
