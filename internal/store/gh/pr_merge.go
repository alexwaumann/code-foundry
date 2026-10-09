package gh

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
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
// refusing) supplies the node id and the head commit GitHub must still have. Within
// writeMemoTTL of a merge, another call returns the first's outcome instead of sending
// the mutation again.
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
	if m, ok := s.full.merges.recent(k, s.opts.Now()); ok {
		return m.res, m.err
	}
	d, err := s.FullPullRequest(ctx, k.slug, k.number, false)
	if err != nil {
		return MergeResult{}, err
	}
	if mergeRefusal(&d, r.Method) != "" {
		// The cached copy may be behind (marked ready, reopened, settings changed): only
		// a fresh look may refuse, and it must succeed.
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
	res, err := submitFunc(ctx, s, "merge|"+k.String(), func(ctx context.Context) (MergeResult, error) {
		// The worker is serial, so a concurrent second merge sees the first's memo.
		if m, ok := s.full.merges.recent(k, s.opts.Now()); ok {
			return m.res, m.err
		}
		data, err := s.call(ctx, queryMergePullRequest, map[string]any{"id": pr.ID, "method": string(r.Method), "head": pr.HeadSHA})
		var pe *PartialError
		switch {
		case errors.As(err, &pe):
			// GitHub refused the merge (conflicts, protection, head moved): nothing merged.
			if headMoved(pe) {
				return MergeResult{}, fmt.Errorf("%w: pull request #%d changed on GitHub since it was loaded (%s has new commits); "+
					"refresh and review it before merging", ErrFailedPrecondition, k.number, pr.HeadRef)
			}
			return MergeResult{}, pe.Unwrap()
		case outcomeUnknown(err):
			now := s.opts.Now()
			err = fmt.Errorf("pull request #%d: GitHub did not confirm the merge, and it may have merged; "+
				"check GitHub before trying again (until %s a retry returns this error): %w",
				k.number, now.Add(writeMemoTTL).Local().Format(time.TimeOnly), err)
			s.full.merges.remember(k, writeMemo[MergeResult]{err: err, at: now})
			return MergeResult{}, err
		case err != nil:
			return MergeResult{}, err
		}
		o, err := decodeMerge(data)
		if err != nil {
			return MergeResult{}, err
		}
		res := MergeResult{Merged: o.Merged || o.State == PullRequestMerged, SHA: o.SHA}
		s.full.merges.remember(k, writeMemo[MergeResult]{res: res, at: s.opts.Now()})
		return res, nil
	})
	if err != nil {
		if errors.Is(err, ErrFailedPrecondition) {
			// GitHub knows a state the cache does not: let clients re-read.
			s.invalidateFull(k)
		}
		return MergeResult{}, err
	}
	if res.Message == "" {
		// The first call for this merge (a memoized result already has its message).
		res = s.finishMerge(ctx, k, pr, r, res)
	}
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

// finishMerge deletes the head branch when asked, writes the message, and remembers the
// complete result for repeats.
func (s *Store) finishMerge(ctx context.Context, k fullKey, pr PullRequest, r MergeRequest, res MergeResult) MergeResult {
	if !res.Merged {
		res.Message = fmt.Sprintf("GitHub accepted the merge of #%d, but it is not merged yet", k.number)
	} else {
		res.Message = fmt.Sprintf("Merged #%d", k.number)
		if res.SHA != "" {
			res.Message += fmt.Sprintf(" (%s)", res.SHA[:min(7, len(res.SHA))])
		}
		switch {
		case !r.DeleteBranch || pr.HeadRef == "":
		case pr.IsCrossRepository:
			res.Message += fmt.Sprintf("; kept branch %s: it is in a fork", pr.HeadRef)
		default:
			ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), branchDeleteTimeout)
			err := s.deleteBranch(ctx, k, pr.HeadRef)
			cancel()
			if err != nil {
				s.log.Warn("gh head branch delete failed", "pr", k.String(), "branch", pr.HeadRef, "err", err)
				res.Message += fmt.Sprintf("; kept branch %s: %v", pr.HeadRef, err)
			} else {
				res.BranchDeleted = true
				res.Message += fmt.Sprintf("; deleted branch %s", pr.HeadRef)
			}
		}
	}
	s.full.merges.remember(k, writeMemo[MergeResult]{res: res, at: s.opts.Now()})
	return res
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

// headMoved reports whether GitHub refused a merge because the head is no longer the
// expected one ("Head branch was modified. Review and try the merge again.").
func headMoved(pe *PartialError) bool {
	for _, e := range pe.Errors {
		m := strings.ToLower(e.Message)
		if strings.Contains(m, "head branch was modified") || strings.Contains(m, "expected head") {
			return true
		}
	}
	return false
}
