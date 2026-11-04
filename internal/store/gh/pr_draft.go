package gh

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// The pull request panel's direct state changes (docs/notes/pr-daemon-actions.md):
// ready for review / convert to draft (SetPullRequestDraft) and GitHub's auto-merge
// (SetPullRequestAutoMerge). One GraphQL mutation each, on the node id from the cached
// detail, paced on the store's worker and never retried. They run under the pull
// request's merge lock, so a merge and an auto-merge change never interleave.
//
// Each refuses up front what the detail shows cannot work (not open, already in the
// requested state, auto-merge or the method disallowed), but only after a fresh look:
// the cached copy may be behind. Everything else is GitHub's call, relayed with its
// message. No write memo: repeating one is harmless (the repeat is refused as already
// done once the detail shows it).

// Query names of the documents (queries/).
const (
	queryMarkReadyForReview = "mark_ready_for_review"
	queryConvertToDraft     = "convert_to_draft"
	queryEnableAutoMerge    = "enable_auto_merge"
	queryDisableAutoMerge   = "disable_auto_merge"
)

// DraftResult is what SetPullRequestDraft did.
type DraftResult struct {
	// Draft is whether GitHub reports the pull request a draft afterwards.
	Draft bool
	// Message says what happened, for people.
	Message string
}

// AutoMergeChange is what SetPullRequestAutoMerge asks for.
type AutoMergeChange struct {
	// Enabled turns auto-merge on (with Method) or off.
	Enabled bool
	Method  MergeMethod
	// ExpectedHeadSHA is, as for MergeRequest, the head commit the client showed
	// (optional): enabling is refused unless GitHub's head is still this commit.
	ExpectedHeadSHA string
}

// AutoMergeResult is what SetPullRequestAutoMerge did.
type AutoMergeResult struct {
	// Enabled is whether GitHub reports auto-merge on afterwards, and Method its method.
	Enabled bool
	Method  MergeMethod
	Message string
}

// SetPullRequestDraft implements Service.
func (s *Store) SetPullRequestDraft(ctx context.Context, slug string, number int, draft bool) (DraftResult, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return DraftResult{}, err
	}
	unlock, err := s.full.mergeLocks.lock(ctx, k)
	if err != nil {
		return DraftResult{}, err
	}
	defer unlock()
	refusal := func(d *FullPullRequest) string { return draftRefusal(d, draft) }
	d, err := s.freshFor(ctx, k, func(d *FullPullRequest) bool { return refusal(d) != "" }, refusal)
	if err != nil {
		return DraftResult{}, err
	}
	doc, what := queryMarkReadyForReview, "marking it ready for review"
	if draft {
		doc, what = queryConvertToDraft, "converting it to a draft"
	}
	data, err := s.stateWrite(ctx, k, what, doc, map[string]any{"id": d.PullRequest.ID}, writeRefused)
	if err != nil {
		return DraftResult{}, err
	}
	res, err := decodeDraft(data, draft)
	if err != nil {
		return DraftResult{}, fmt.Errorf("pull request #%d: GitHub accepted %s, but its answer could not be read: %w", k.number, what, err)
	}
	switch {
	case res.Draft != draft:
		res.Message = fmt.Sprintf("GitHub accepted %s (#%d), but reports it %s", what, k.number, draftWord(res.Draft))
	case draft:
		res.Message = fmt.Sprintf("Converted #%d to a draft", k.number)
	default:
		res.Message = fmt.Sprintf("Marked #%d ready for review", k.number)
	}
	s.log.Info("gh pull request draft set", "pr", k.String(), "draft", res.Draft)
	// The dashboards show drafts: poll soon.
	s.pollSoon()
	return res, nil
}

// SetPullRequestAutoMerge implements Service.
func (s *Store) SetPullRequestAutoMerge(ctx context.Context, slug string, number int, r AutoMergeChange) (AutoMergeResult, error) {
	k, err := fullKeyOf(slug, number)
	if err != nil {
		return AutoMergeResult{}, err
	}
	if r.Enabled {
		switch r.Method {
		case MergeCommit, MergeSquash, MergeRebase:
		default:
			return AutoMergeResult{}, fmt.Errorf("%w: merge method %q", ErrInvalidArgument, r.Method)
		}
		if r.ExpectedHeadSHA != "" && !IsCommitSHA(r.ExpectedHeadSHA) {
			return AutoMergeResult{}, fmt.Errorf("%w: expected head %q is not a full commit SHA", ErrInvalidArgument, r.ExpectedHeadSHA)
		}
	} else {
		r.Method, r.ExpectedHeadSHA = "", ""
	}
	unlock, err := s.full.mergeLocks.lock(ctx, k)
	if err != nil {
		return AutoMergeResult{}, err
	}
	defer unlock()
	mr := MergeRequest{Method: r.Method, ExpectedHeadSHA: r.ExpectedHeadSHA}
	refusal := func(d *FullPullRequest) string { return autoMergeRefusal(d, r) }
	d, err := s.freshFor(ctx, k, func(d *FullPullRequest) bool { return refusal(d) != "" || headDiffers(d, mr) }, refusal)
	if err != nil {
		return AutoMergeResult{}, err
	}
	pr := d.PullRequest
	doc, vars, what := queryDisableAutoMerge, map[string]any{"id": pr.ID}, "disabling auto-merge"
	if r.Enabled {
		if pr.HeadSHA == "" {
			return AutoMergeResult{}, fmt.Errorf("pull request #%d: no head commit", k.number)
		}
		if headDiffers(&d, mr) {
			s.invalidateFull(k)
			return AutoMergeResult{}, fmt.Errorf("%w: pull request #%d changed since it was shown (head %s, shown %s); refresh and try again",
				ErrFailedPrecondition, k.number, short(pr.HeadSHA), short(r.ExpectedHeadSHA))
		}
		head := pr.HeadSHA
		if r.ExpectedHeadSHA != "" {
			head = r.ExpectedHeadSHA
		}
		doc, vars, what = queryEnableAutoMerge, map[string]any{"id": pr.ID, "method": string(r.Method), "head": head}, "enabling auto-merge"
	}
	data, err := s.stateWrite(ctx, k, what, doc, vars, func(pe *PartialError) error { return autoMergeRefused(k, &pr, pe) })
	if err != nil {
		return AutoMergeResult{}, err
	}
	res, err := decodeAutoMerge(data, r.Enabled)
	if err != nil {
		return AutoMergeResult{}, fmt.Errorf("pull request #%d: GitHub accepted %s, but its answer could not be read: %w", k.number, what, err)
	}
	switch {
	case res.Enabled != r.Enabled:
		res.Message = fmt.Sprintf("GitHub accepted %s (#%d), but reports auto-merge %s", what, k.number, onOff(res.Enabled))
	case r.Enabled:
		res.Message = fmt.Sprintf("Auto-merge on for #%d: GitHub merges it with %s once its requirements pass",
			k.number, mergeMethodName(cmp.Or(res.Method, r.Method)))
	default:
		res.Message = fmt.Sprintf("Auto-merge off for #%d", k.number)
	}
	s.log.Info("gh pull request auto-merge set", "pr", k.String(), "enabled", res.Enabled, "method", res.Method)
	s.pollSoon()
	return res, nil
}

// freshFor returns k's detail for a state change: the cached one unless look says it
// needs a fresh look (it would refuse, or the client saw another head), else a fresh
// one, which must be fetched: the cached copy may be behind. It refuses with
// ErrFailedPrecondition when refusal still finds something ("is a draft").
func (s *Store) freshFor(ctx context.Context, k fullKey, look func(*FullPullRequest) bool, refusal func(*FullPullRequest) string) (FullPullRequest, error) {
	d, err := s.currentFull(ctx, k)
	if err != nil {
		return FullPullRequest{}, err
	}
	if look(&d) {
		if d, err = s.fetchFullJob(ctx, k); err != nil {
			return FullPullRequest{}, fmt.Errorf("pull request #%d: cannot confirm its state: %w", k.number, err)
		}
	}
	if why := refusal(&d); why != "" {
		return FullPullRequest{}, fmt.Errorf("%w: pull request #%d %s", ErrFailedPrecondition, k.number, why)
	}
	if d.PullRequest.ID == "" {
		return FullPullRequest{}, fmt.Errorf("pull request #%d: no node id", k.number)
	}
	return d, nil
}

// stateWrite sends one state-changing mutation for k on the worker. refused maps
// GitHub's refusal (a part next to a null payload); a refusal in the pull request's
// state, or no answer, invalidates the detail so clients re-read, and so does success.
// what names the change in errors ("disabling auto-merge").
func (s *Store) stateWrite(ctx context.Context, k fullKey, what, doc string, vars map[string]any, refused func(*PartialError) error) ([]byte, error) {
	data, err := submitFunc(ctx, s, doc+"|"+k.String(), func(ctx context.Context) ([]byte, error) {
		data, err := s.call(ctx, doc, vars)
		var pe *PartialError
		switch {
		case errors.As(err, &pe):
			return nil, refused(pe)
		case outcomeUnknown(err):
			return nil, fmt.Errorf("pull request #%d: GitHub did not confirm %s, and it may have happened; refresh before trying again: %w",
				k.number, what, err)
		case err != nil:
			return nil, err
		}
		return data, nil
	})
	if err == nil || outcomeUnknown(err) || errors.Is(err, ErrFailedPrecondition) || errors.Is(err, ErrNotFound) {
		s.invalidateFull(k)
	}
	return data, err
}

// draftRefusal says why d cannot be made a draft (draft) or ready for review, or "".
func draftRefusal(d *FullPullRequest, draft bool) string {
	pr := d.PullRequest
	switch {
	case pr.State != PullRequestOpen:
		return fmt.Sprintf("is %s, not open", strings.ToLower(string(pr.State)))
	case draft && pr.Draft:
		return "is already a draft"
	case !draft && !pr.Draft:
		return "is already ready for review"
	}
	return ""
}

// autoMergeRefusal says why auto-merge cannot be changed as r asks on d, or "".
func autoMergeRefusal(d *FullPullRequest, r AutoMergeChange) string {
	pr := d.PullRequest
	switch {
	case pr.State != PullRequestOpen:
		return fmt.Sprintf("is %s, not open", strings.ToLower(string(pr.State)))
	case !r.Enabled && !d.AutoMerge:
		return "does not have auto-merge on"
	case !r.Enabled:
		return ""
	case d.AutoMerge && d.AutoMergeMethod == r.Method:
		return fmt.Sprintf("already has auto-merge on with %s", mergeMethodName(r.Method))
	case d.AutoMerge:
		return fmt.Sprintf("already has auto-merge on with %s; turn it off first to merge with %s",
			mergeMethodName(d.AutoMergeMethod), mergeMethodName(r.Method))
	case pr.Draft:
		return "is a draft; mark it ready for review first"
	case !d.AutoMergeAllowed:
		return "cannot use auto-merge: the repository does not allow it (its settings' Allow auto-merge)"
	case len(d.MergeMethods) > 0 && !slices.Contains(d.MergeMethods, r.Method):
		return fmt.Sprintf("cannot be merged with %s: the repository does not allow it", mergeMethodName(r.Method))
	}
	return ""
}

// autoMergeRefused maps GitHub's refusal of an auto-merge mutation like mergeRefused,
// and says what to do about a pull request GitHub could merge right away ("Pull request
// is in clean status": auto-merge only waits for requirements that are not met yet).
func autoMergeRefused(k fullKey, pr *PullRequest, pe *PartialError) error {
	err := mergeRefused(k, pr, pe)
	if !errors.Is(err, ErrFailedPrecondition) {
		return err
	}
	for _, e := range pe.Errors {
		if strings.Contains(strings.ToLower(e.Message), "clean status") {
			return fmt.Errorf("%w: pull request #%d can be merged now, so GitHub will not wait to auto-merge it (%s); merge it instead",
				ErrFailedPrecondition, k.number, e.Message)
		}
	}
	return err
}

// decodeDraft maps a MarkReadyForReview or ConvertToDraft response.
func decodeDraft(data []byte, draft bool) (DraftResult, error) {
	type payload struct {
		PullRequest *struct {
			IsDraft bool `json:"isDraft"`
		} `json:"pullRequest"`
	}
	var d struct {
		Ready *payload `json:"markPullRequestReadyForReview"`
		Draft *payload `json:"convertPullRequestToDraft"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return DraftResult{}, fmt.Errorf("decode draft: %w", err)
	}
	p := d.Ready
	if draft {
		p = d.Draft
	}
	if p == nil || p.PullRequest == nil {
		return DraftResult{}, errors.New("decode draft: no pull request in the response")
	}
	return DraftResult{Draft: p.PullRequest.IsDraft}, nil
}

// decodeAutoMerge maps an EnableAutoMerge or DisableAutoMerge response.
func decodeAutoMerge(data []byte, enabled bool) (AutoMergeResult, error) {
	type payload struct {
		PullRequest *struct {
			AutoMergeRequest *autoMergeRequestJSON `json:"autoMergeRequest"`
		} `json:"pullRequest"`
	}
	var d struct {
		Enable  *payload `json:"enablePullRequestAutoMerge"`
		Disable *payload `json:"disablePullRequestAutoMerge"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return AutoMergeResult{}, fmt.Errorf("decode auto-merge: %w", err)
	}
	p := d.Disable
	if enabled {
		p = d.Enable
	}
	if p == nil || p.PullRequest == nil {
		return AutoMergeResult{}, errors.New("decode auto-merge: no pull request in the response")
	}
	a := p.PullRequest.AutoMergeRequest
	if a == nil {
		return AutoMergeResult{}, nil
	}
	return AutoMergeResult{Enabled: true, Method: MergeMethod(a.MergeMethod)}, nil
}

func draftWord(draft bool) string {
	if draft {
		return "a draft"
	}
	return "ready for review"
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}
