package thread

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// New-worktree threads (CreateOptions.NewWorktree).
//
// Create makes the worktree synchronously so a failure reaches the caller before
// anything is persisted (the GUI composer keeps its draft). The branch is
// cf/<slug>: the slug is the thread's explicit name slugified, else the namer's
// title for the first prompt slugified, else (no title, or one with nothing to
// slugify) the thread id. Only the branch waits for the namer, bounded by
// Options.SlugTimeout. The namer is called once per thread: a title that arrives in
// time names the branch and the thread; one that arrives later only names the
// thread then (the branch stays cf/<id>; the row keeps its placeholder until then).

// branchPrefix namespaces branches the app creates.
const branchPrefix = "cf/"

// maxBranchSuffix bounds the -2, -3, ... suffixes tried when cf/<slug> is taken.
const maxBranchSuffix = 9

// namingResult is one namer call's outcome.
type namingResult struct {
	name string
	err  error
}

// createdWorktree is what newWorktree made.
type createdWorktree struct {
	projectID, path, baseRef string
	// name is the namer's title when it arrived within SlugTimeout.
	name string
	// namerCalled: the namer was started for this thread (in time or not).
	namerCalled bool
	// late delivers the namer's answer when it did not arrive in time.
	late <-chan namingResult
}

// newWorktree resolves the branch and creates the worktree for a new thread.
func (m *Manager) newWorktree(ctx context.Context, id, name string, o CreateOptions) (createdWorktree, error) {
	var nw createdWorktree
	if m.opts.Projects == nil {
		return nw, fmt.Errorf("%w: creating a worktree needs the repo store", ErrFailedPrecondition)
	}
	base := strings.TrimSpace(o.NewWorktree.BaseRef)
	if err := validateRef(base); err != nil {
		return nw, err
	}
	projectID := o.ProjectID
	if projectID == "" {
		if o.WorktreePath == "" {
			return nw, fmt.Errorf("%w: a repo is required for a new worktree", ErrInvalidArgument)
		}
		var err error
		if projectID, _, err = m.resolveWorktree("", o.WorktreePath); err != nil {
			return nw, err
		}
	}
	r, ok := m.opts.Projects.Snapshot().Project(projectID)
	if !ok {
		return nw, fmt.Errorf("%w: repo %s", ErrNotFound, projectID)
	}
	if !r.Git {
		// Before the namer: a project without git runs threads in its one checkout.
		return nw, fmt.Errorf("%w: %s is not a git repository; threads run in its current checkout", ErrFailedPrecondition, r.Name)
	}

	sl, err := m.waitSlug(ctx, id, name, o.InitialPrompt)
	if err != nil {
		return nw, err
	}
	nw.name, nw.namerCalled, nw.late = sl.name, sl.namerCalled, sl.late
	branch := m.pickBranch(ctx, []string{r.Path}, sl.slug, id, nil)
	path := ""
	if m.opts.WorktreePath != nil {
		path = m.opts.WorktreePath(r, branch)
	}
	wt, err := m.opts.Projects.CreateWorktree(ctx, project.CreateWorktreeOptions{
		ProjectID: r.ID, Branch: branch, BaseRef: base, Path: path, Fetch: true,
	})
	if err != nil {
		return nw, projectError("create worktree "+branch, err)
	}
	nw.projectID, nw.path = r.ID, wt.Path
	nw.baseRef = cmp.Or(base, wt.Status.BaseRef, r.DefaultBranch)
	m.log.Info("worktree created for thread", "thread", id, "repo", r.ID, "branch", branch,
		"path", wt.Path, "base", nw.baseRef)
	return nw, nil
}

// slugWait is the outcome of waitSlug.
type slugWait struct {
	// slug for the branch: the explicit name slugified, else the namer's title
	// slugified, else "" (the caller falls back to the thread id).
	slug string
	// name is the namer's title when it arrived within SlugTimeout.
	name string
	// namerCalled: the namer was started for this thread (in time or not).
	namerCalled bool
	// late delivers the namer's answer when it did not arrive in time.
	late <-chan namingResult
}

// waitSlug picks the slug a new worktree's (or workspace's) branch is named after:
// name slugified when set, else the namer's title for the first prompt slugified,
// waiting at most Options.SlugTimeout.
func (m *Manager) waitSlug(ctx context.Context, id, name, prompt string) (slugWait, error) {
	sw := slugWait{slug: slugify(name)}
	if name != "" || strings.TrimSpace(prompt) == "" {
		return sw, nil
	}
	// The worktrees do not exist yet: the namer sees file references as relative paths.
	ch, err := m.startSlug(id, stripFileRefs(prompt))
	if err != nil {
		return sw, err
	}
	sw.namerCalled = true
	start := time.Now()
	timer := time.NewTimer(m.opts.SlugTimeout)
	select {
	case res := <-ch:
		timer.Stop()
		if res.err != nil {
			m.log.Warn("naming new worktree branch failed; using the thread id", "thread", id, "err", res.err)
		} else {
			sw.slug, sw.name = slugify(res.name), res.name
			m.log.Info("thread auto-named", "thread", id, "name", res.name,
				"took", time.Since(start).Round(time.Millisecond).String())
		}
	case <-timer.C:
		m.log.Info("naming new worktree branch timed out; using the thread id", "thread", id,
			"timeout", m.opts.SlugTimeout.String())
		sw.late = ch
	case <-ctx.Done():
		timer.Stop()
		return sw, ctx.Err()
	}
	return sw, nil
}

// startSlug runs the namer for a first prompt in the background, retrying once after
// NamingRetryDelay when the failure looks like a rate limit. The channel receives
// exactly one result.
func (m *Manager) startSlug(id, prompt string) (<-chan namingResult, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, ErrClosed
	}
	m.wg.Add(1)
	m.mu.Unlock()
	ch := make(chan namingResult, 1)
	go func() {
		defer m.wg.Done()
		ctx, cancel := context.WithTimeout(withNamingThread(m.ctx, id), m.opts.NamingTimeout)
		defer cancel()
		name, err := m.opts.Namer(ctx, prompt)
		if isRateLimit(err) {
			m.log.Info("naming rate limited; retrying once", "thread", id, "err", err)
			t := time.NewTimer(m.opts.NamingRetryDelay)
			select {
			case <-t.C:
				name, err = m.opts.Namer(ctx, prompt)
			case <-ctx.Done():
				t.Stop()
			}
		}
		ch <- namingResult{name: name, err: err}
	}()
	return ch, nil
}

// applyLateName names thread id from a namer answer that missed SlugTimeout, unless
// the thread was named meanwhile.
func (m *Manager) applyLateName(id string, ch <-chan namingResult) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		var res namingResult
		select {
		case res = <-ch:
		case <-m.ctx.Done():
			return
		}
		if res.err != nil {
			m.log.Warn("auto-naming failed", "thread", id, "err", res.err)
			return
		}
		if _, ok := m.update(id, true, func(rec *record) {
			if rec.s.Name == "" {
				rec.s.Name, rec.s.AutoNamed = res.name, true
			}
		}); ok {
			m.log.Info("thread auto-named after its worktree was created", "thread", id, "name", res.name)
		}
	}()
}

// pickBranch returns cf/<slug>, or cf/<slug>-N when that branch exists locally or on
// origin in any of repoPaths (or taken reports its name part, "<slug>" or
// "<slug>-N", as used), or cf/<id> when the slug is empty or every suffix is taken.
func (m *Manager) pickBranch(ctx context.Context, projectPaths []string, slug, id string, taken func(string) bool) string {
	if slug == "" {
		return branchPrefix + id
	}
	free := func(b string) bool {
		for _, p := range projectPaths {
			if m.opts.RefExists(ctx, p, "refs/heads/"+b) || m.opts.RefExists(ctx, p, "refs/remotes/origin/"+b) {
				return false
			}
		}
		return true
	}
	for i := 1; i <= maxBranchSuffix; i++ {
		s := slug
		if i > 1 {
			s += "-" + strconv.Itoa(i)
		}
		if (taken == nil || !taken(s)) && free(branchPrefix+s) {
			return branchPrefix + s
		}
	}
	return branchPrefix + id
}

// gitRefExists is the default Options.RefExists.
func gitRefExists(ctx context.Context, dir, ref string) bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--verify", "--quiet", ref).Run() == nil
}

// validateRef rejects base refs that could be read as a git option or are not one
// word. git itself validates the rest.
func validateRef(ref string) error {
	if ref == "" {
		return nil
	}
	if strings.HasPrefix(ref, "-") || len(ref) > 250 || strings.IndexFunc(ref, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}) >= 0 {
		return fmt.Errorf("%w: base ref %q", ErrInvalidArgument, ref)
	}
	return nil
}

// repoError wraps a repo store error in the thread error class with the same
// meaning, so API codes survive.
func projectError(what string, err error) error {
	var kind error
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s: %w", what, err)
	case errors.Is(err, project.ErrNotFound):
		kind = ErrNotFound
	case errors.Is(err, project.ErrInvalidArgument):
		kind = ErrInvalidArgument
	default:
		kind = ErrFailedPrecondition
	}
	return classified{kind: kind, err: fmt.Errorf("%s: %w", what, err)}
}

// classified adds a thread error class to an error without repeating it in the
// message (repo errors already start with "failed precondition: ...").
type classified struct{ kind, err error }

func (c classified) Error() string   { return c.err.Error() }
func (c classified) Unwrap() []error { return []error{c.kind, c.err} }
