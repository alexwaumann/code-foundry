package thread

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unicode"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// New-worktree threads (CreateOptions.NewWorktree; the worktrees themselves, one per
// member with git of the thread's set, are placement.go's).
//
// Create makes the worktrees synchronously so a failure reaches the caller before
// anything is persisted (the GUI composer keeps its draft). The branch follows the
// projects.branch_naming mode (branchname.go) from the namer's reply for the first
// prompt (and the explicit name, and a --branch slug), else cf/<thread id>. Only the
// branch waits for the namer, bounded by Options.SlugTimeout. The namer is called once
// per thread: a reply that arrives in time names the branch and the thread; one that
// arrives later only names the thread then (the branch stays cf/<id>; the row keeps
// its provisional name, else its placeholder, until then). The provisional name never
// names the branch.

// namingResult is one namer call's outcome.
type namingResult struct {
	Naming
	err error
}

// fromOrigin is a new worktree's project.CreateWorktreeOptions.BaseFromOrigin: the
// call's override (thread new --base-from-origin) when set, else the setting.
func (m *Manager) fromOrigin(override *bool) bool {
	if override != nil {
		return *override
	}
	return m.opts.BaseFromOrigin()
}

// slugWait is the outcome of waitNaming.
type slugWait struct {
	// branch is composeBranch's for the reply (or offBranch's): "" falls back to
	// cf/<id>.
	branch string
	// name is the namer's title when it arrived within SlugTimeout and the thread has
	// no explicit name.
	name string
	// namerCalled: the namer was started for this thread (in time or not).
	namerCalled bool
	// late delivers the namer's answer when it did not arrive in time.
	late <-chan namingResult
}

// waitNaming runs the namer for a new worktree's (or workspace's) branch and, without
// an explicit name, the thread's title, waiting at most Options.SlugTimeout. The namer
// is not called when it has nothing to read (no prompt, name or slug) or nothing to
// answer (the thread is named and the branch needs no model).
func (m *Manager) waitNaming(ctx context.Context, id, name, prompt string, bc branchChoice) (slugWait, error) {
	var sw slugWait
	req := NamingRequest{Name: name, Branch: bc.branchRequest()}
	needTitle := name == "" && strings.TrimSpace(prompt) != ""
	if !needTitle {
		if req.Branch == nil || (name == "" && bc.hint == "") {
			sw.branch = composeBranch(bc.cfg, bc.hint, "", "")
			return sw, nil
		}
	}
	// The worktrees do not exist yet: the namer sees file references as relative paths.
	req.Message = stripFileRefs(prompt)
	ch, err := m.startSlug(id, req)
	if err != nil {
		return sw, err
	}
	sw.namerCalled = true
	start := time.Now()
	timer := time.NewTimer(m.opts.SlugTimeout)
	select {
	case res := <-ch:
		timer.Stop()
		switch {
		case errors.Is(res.err, ErrNamingOff):
			sw.branch = offBranch(bc, name)
		case res.err != nil:
			m.log.Warn("naming new worktree branch failed; using the fallback", "thread", id, "err", res.err)
			sw.branch = composeBranch(bc.cfg, bc.hint, "", "")
		default:
			sw.branch = composeBranch(bc.cfg, bc.hint, res.Branch, res.Title)
			if name == "" {
				sw.name = res.Title
			}
			m.log.Info("thread auto-named", "thread", id, "name", res.Title, "branch", res.Branch,
				"took", time.Since(start).Round(time.Millisecond).String())
		}
	case <-timer.C:
		m.log.Info("naming new worktree branch timed out; using the fallback", "thread", id,
			"timeout", m.opts.SlugTimeout.String())
		sw.branch = composeBranch(bc.cfg, bc.hint, "", "")
		if name == "" {
			sw.late = ch
		}
	case <-ctx.Done():
		timer.Stop()
		return sw, ctx.Err()
	}
	return sw, nil
}

// startSlug runs the namer for req in the background, retrying once after
// NamingRetryDelay when the failure looks like a rate limit. The channel receives
// exactly one result.
func (m *Manager) startSlug(id string, req NamingRequest) (<-chan namingResult, error) {
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
		n, err := m.opts.Namer(ctx, req)
		if isRateLimit(err) {
			m.log.Info("naming rate limited; retrying once", "thread", id, "err", err)
			t := time.NewTimer(m.opts.NamingRetryDelay)
			select {
			case <-t.C:
				n, err = m.opts.Namer(ctx, req)
			case <-ctx.Done():
				t.Stop()
			}
		}
		ch <- namingResult{Naming: n, err: err}
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
		if res.Title == "" {
			return
		}
		applied := false
		if _, ok := m.update(id, true, func(rec *record) { applied = rec.s.applyNamerTitle(res.Title) }); !ok {
			return // removed meanwhile
		}
		if applied {
			m.log.Info("thread auto-named after its worktree was created", "thread", id, "name", res.Title)
		} else {
			m.log.Info("naming answer ignored: the thread was named meanwhile", "thread", id, "name", res.Title)
		}
	}()
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

// projectError wraps a project store error in the thread error class with the same
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
// message (project errors already start with "failed precondition: ...").
type classified struct{ kind, err error }

func (c classified) Error() string   { return c.err.Error() }
func (c classified) Unwrap() []error { return []error{c.kind, c.err} }
