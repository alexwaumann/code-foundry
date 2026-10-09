package gh

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// prFingerprint is what the poll learns about one pull request (PullRequestIdentity or
// PullRequestFingerprint): enough to tell whether its stored detail is still current.
type prFingerprint struct {
	ID        string
	Number    int
	Repo      string
	UpdatedAt time.Time
	State     PullRequestState
	HeadSHA   string
	Author    string
	IsCross   bool
	// HasChecks is set when the fingerprint selected the check rollup (Checks is then
	// authoritative, including "no checks").
	HasChecks bool
	Checks    CheckRollup
}

// placeholder is a pull request known only by its fingerprint (detail pending).
func (f prFingerprint) placeholder() PullRequest {
	return PullRequest{
		ID: f.ID, Number: f.Number, Repo: f.Repo, UpdatedAt: f.UpdatedAt, State: f.State, HeadSHA: f.HeadSHA,
		Author: f.Author, IsCrossRepository: f.IsCross, Checks: f.Checks, Partial: true,
		URL: fmt.Sprintf("https://github.com/%s/pull/%d", f.Repo, f.Number),
	}
}

type fingerprintJSON struct {
	Typename          string             `json:"__typename"`
	ID                string             `json:"id"`
	Number            int                `json:"number"`
	UpdatedAt         time.Time          `json:"updatedAt"`
	State             string             `json:"state"`
	HeadRefOid        string             `json:"headRefOid"`
	IsCrossRepository bool               `json:"isCrossRepository"`
	Author            *loginJSON         `json:"author"`
	Repository        *nameWithOwnerJSON `json:"repository"`
	StatusCheckRollup *rollupJSON        `json:"statusCheckRollup"`
}

func mapFingerprints(nodes []fingerprintJSON, checks bool) []prFingerprint {
	out := make([]prFingerprint, 0, len(nodes))
	for _, n := range nodes {
		// Search nodes are a union; issues come back as empty objects.
		if (n.Typename != "" && n.Typename != "PullRequest") || n.ID == "" {
			continue
		}
		f := prFingerprint{
			ID: n.ID, Number: n.Number, UpdatedAt: n.UpdatedAt, State: PullRequestState(n.State),
			HeadSHA: n.HeadRefOid, IsCross: n.IsCrossRepository, HasChecks: checks,
		}
		if n.Author != nil {
			f.Author = n.Author.Login
		}
		if n.Repository != nil {
			f.Repo, _ = NormalizeSlug(n.Repository.NameWithOwner)
		}
		if checks && n.StatusCheckRollup != nil {
			f.Checks = mapRollup(n.StatusCheckRollup)
		}
		out = append(out, f)
	}
	return out
}

// sectionResult is one decoded dashboard search.
type sectionResult struct {
	Total int
	PRs   []prFingerprint
	Err   error
}

// branchFP is a default branch's head fingerprint.
type branchFP struct {
	Branch      string
	SHA         string
	Headline    string
	CommittedAt time.Time
	Rollup      CheckRollup
}

// repoResult is one decoded repository block.
type repoResult struct {
	// Err is set when the repository failed as a whole (not found, no access).
	Err error
	// DefaultBranch is nil when not selected or the repository is empty.
	DefaultBranch *branchFP
	// Branches holds each watched branch's pull requests (every author); a branch
	// missing here failed with BranchErr.
	Branches  map[string][]prFingerprint
	BranchErr map[string]error
	// History is the viewer's commits on the default branch this month and last; nil
	// when not selected.
	History *[2]int
}

// statsResult is the decoded monthly stats part.
type statsResult struct {
	MergedThis, MergedLast int
	// Recent is every merged PR of the two months (up to mergedStatsFirst).
	Recent      []mergedItem
	RecentTotal int
	// Contrib* are contributionsCollection's commit counts (the fallback for REST).
	ContribThis, ContribLast int
	HasContrib               bool
	Err                      error
}

type mergedItem struct {
	Repo     string
	MergedAt time.Time
}

// pollResult is a decoded poll response.
type pollResult struct {
	Viewer     *Viewer
	SearchAsID string
	Sections   map[string]sectionResult
	Repos      map[string]repoResult // by slug
	Stats      *statsResult
}

// decodePoll maps a poll response built from plan. partial is the response's
// *PartialError, if any: its errors are attributed to the parts they belong to.
func decodePoll(plan *pollPlan, data []byte, partial *PartialError) (pollResult, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return pollResult{}, fmt.Errorf("decode poll: %w", err)
	}
	at := func(alias string) error {
		if partial == nil {
			return nil
		}
		return partial.At(alias)
	}
	res := pollResult{Sections: map[string]sectionResult{}, Repos: map[string]repoResult{}}
	var v *Viewer
	if err := unmarshalField(top, "viewer", &v); err != nil {
		return pollResult{}, err
	}
	if v == nil || v.Login == "" {
		return pollResult{}, fmt.Errorf("decode poll: no viewer: %w", cmpErr(at("viewer"), ErrNotAuthenticated))
	}
	res.Viewer = v
	if plan.searchAs != "" {
		var u *struct {
			ID string `json:"id"`
		}
		if err := unmarshalField(top, "searchAs", &u); err == nil && u != nil {
			res.SearchAsID = u.ID
		}
	}
	for _, sec := range plan.sections {
		alias := sectionAlias(sec.name)
		var raw *struct {
			IssueCount int               `json:"issueCount"`
			Nodes      []fingerprintJSON `json:"nodes"`
		}
		err := unmarshalField(top, alias, &raw)
		switch {
		case err != nil:
			res.Sections[sec.name] = sectionResult{Err: err}
		case raw == nil:
			res.Sections[sec.name] = sectionResult{Err: cmpErr(at(alias), errors.New("no search result"))}
		default:
			res.Sections[sec.name] = sectionResult{Total: raw.IssueCount, PRs: mapFingerprints(raw.Nodes, sec.checks)}
		}
	}
	for i, rp := range plan.repos {
		res.Repos[rp.slug] = decodeRepoBlock(rp, top[repoAlias(i)], at(repoAlias(i)))
	}
	if plan.stats != nil {
		res.Stats = decodeStatsPart(top, plan.stats, at)
	}
	return res, nil
}

func decodeRepoBlock(rp repoPlan, raw json.RawMessage, aliasErr error) repoResult {
	out := repoResult{Branches: map[string][]prFingerprint{}, BranchErr: map[string]error{}}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		out.Err = fmt.Errorf("decode repository: %w", err)
		return out
	}
	if fields == nil { // null: the repository failed as a whole
		out.Err = cmpErr(aliasErr, fmt.Errorf("repository: %w", ErrNotFound))
		return out
	}
	if rp.defaultBranch {
		var ref *defaultBranchJSON
		if err := unmarshalField(fields, "defaultBranchRef", &ref); err != nil {
			out.Err = err
			return out
		}
		if ref != nil && ref.Target != nil && ref.Target.Oid != "" {
			fp := &branchFP{Branch: ref.Name, SHA: ref.Target.Oid, Headline: ref.Target.MessageHeadline, CommittedAt: ref.Target.CommittedDate}
			if r := ref.Target.StatusCheckRollup; r != nil {
				fp.Rollup = mapRollup(r)
			}
			out.DefaultBranch = fp
		}
	}
	for j, head := range rp.branches {
		var conn *struct {
			Nodes []fingerprintJSON `json:"nodes"`
		}
		if err := unmarshalField(fields, branchAlias(j), &conn); err != nil || conn == nil {
			out.BranchErr[head] = cmpErr(err, aliasErr, errors.New("no pull requests connection"))
			continue
		}
		out.Branches[head] = mapFingerprints(conn.Nodes, true)
	}
	if rp.history {
		var h *struct {
			Target *struct {
				ThisMonth *totalJSON `json:"thisMonth"`
				LastMonth *totalJSON `json:"lastMonth"`
			} `json:"target"`
		}
		if err := unmarshalField(fields, "history", &h); err == nil {
			counts := [2]int{}
			// An empty repository has no default branch: no commits.
			if h != nil && h.Target != nil {
				if t := h.Target.ThisMonth; t != nil {
					counts[0] = t.TotalCount
				}
				if t := h.Target.LastMonth; t != nil {
					counts[1] = t.TotalCount
				}
			}
			out.History = &counts
		}
	}
	return out
}

func decodeStatsPart(top map[string]json.RawMessage, plan *statsPlan, at func(string) error) *statsResult {
	st := &statsResult{}
	var this, last *countJSON
	var recent *struct {
		IssueCount int `json:"issueCount"`
		Nodes      []struct {
			MergedAt   time.Time          `json:"mergedAt"`
			Repository *nameWithOwnerJSON `json:"repository"`
		} `json:"nodes"`
	}
	err := errors.Join(unmarshalField(top, "mergedThis", &this), unmarshalField(top, "mergedLast", &last),
		unmarshalField(top, "mergedRecent", &recent))
	if err == nil && (this == nil || last == nil || recent == nil) {
		err = cmpErr(at("mergedThis"), at("mergedLast"), at("mergedRecent"), errors.New("missing search counts"))
	}
	if err != nil {
		st.Err = fmt.Errorf("decode stats: %w", err)
		return st
	}
	st.MergedThis, st.MergedLast, st.RecentTotal = this.IssueCount, last.IssueCount, recent.IssueCount
	for _, n := range recent.Nodes {
		if n.Repository == nil || n.MergedAt.IsZero() {
			continue
		}
		slug, _ := NormalizeSlug(n.Repository.NameWithOwner)
		st.Recent = append(st.Recent, mergedItem{Repo: slug, MergedAt: n.MergedAt})
	}
	if plan.login != "" {
		var u *struct {
			ThisMonth struct {
				Total int `json:"totalCommitContributions"`
			} `json:"thisMonth"`
			LastMonth struct {
				Total int `json:"totalCommitContributions"`
			} `json:"lastMonth"`
		}
		if unmarshalField(top, "contributions", &u) == nil && u != nil {
			st.ContribThis, st.ContribLast, st.HasContrib = u.ThisMonth.Total, u.LastMonth.Total, true
		}
	}
	return st
}

type countJSON struct {
	IssueCount int `json:"issueCount"`
}

// unmarshalField decodes fields[name] into v; a missing field leaves v untouched.
func unmarshalField(fields map[string]json.RawMessage, name string, v any) error {
	raw, ok := fields[name]
	if !ok {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("decode %s: %w", name, err)
	}
	return nil
}

// cmpErr returns the first non-nil error.
func cmpErr(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// ---- detail and default-branch checks responses --------------------------------

// decodeDetails maps a PullRequestDetails response. Ids that resolved to nothing (a
// deleted pull request) are missing from the result.
func decodeDetails(data []byte) (map[string]PullRequest, error) {
	var d struct {
		Open   []*pullRequestJSON `json:"open"`
		Closed []*pullRequestJSON `json:"closed"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("decode pull request details: %w", err)
	}
	out := map[string]PullRequest{}
	for _, list := range [][]*pullRequestJSON{d.Open, d.Closed} {
		for _, p := range list {
			if p == nil || p.ID == "" || (p.Typename != "" && p.Typename != "PullRequest") {
				continue
			}
			out[p.ID] = mapPullRequest(p)
		}
	}
	return out, nil
}

// decodeDefaultBranchChecks maps a DefaultBranchChecks response for reqs: each
// repository's first page of checks, or its error.
func decodeDefaultBranchChecks(reqs []ciRequest, data []byte, partial *PartialError) (map[string]checksPage, map[string]error) {
	pages, errs := map[string]checksPage{}, map[string]error{}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		for _, r := range reqs {
			errs[r.slug] = fmt.Errorf("decode default branch checks: %w", err)
		}
		return pages, errs
	}
	for i, r := range reqs {
		var repo *struct {
			Object *commitJSON `json:"object"`
		}
		err := unmarshalField(top, repoAlias(i), &repo)
		switch {
		case err != nil:
			errs[r.slug] = err
		case repo == nil || repo.Object == nil || repo.Object.Oid == "":
			var aliasErr error
			if partial != nil {
				aliasErr = partial.At(repoAlias(i))
			}
			errs[r.slug] = cmpErr(aliasErr, fmt.Errorf("default branch head: %w", ErrNotFound))
		default:
			pages[r.slug] = mapChecksPage(repo.Object)
		}
	}
	return pages, errs
}

// defaultBranchJSON is DefaultBranchFingerprint's defaultBranchRef.
type defaultBranchJSON struct {
	Name   string `json:"name"`
	Target *struct {
		commitJSON
		CommittedDate   time.Time `json:"committedDate"`
		MessageHeadline string    `json:"messageHeadline"`
	} `json:"target"`
}

// failingRuns keeps the checks in the failed bucket.
func failingRuns(runs []CheckRun) []CheckRun {
	var out []CheckRun
	for _, r := range runs {
		if runBucket(r) == bucketFailed {
			out = append(out, r)
		}
	}
	return out
}

func isServerTimeout(err error) bool { return errors.Is(err, ErrServerTimeout) }

func isAuthOrNetwork(err error) bool {
	return errors.Is(err, ErrNotAuthenticated) || errors.Is(err, ErrNetwork)
}

// decodeSearchTotal reads total_count from a REST search response.
func decodeSearchTotal(body []byte) (int, error) {
	var d struct {
		TotalCount *int `json:"total_count"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return 0, fmt.Errorf("decode search/commits: %w", err)
	}
	if d.TotalCount == nil {
		return 0, errors.New("decode search/commits: no total_count")
	}
	return *d.TotalCount, nil
}
