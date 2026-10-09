package gitops

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// label names a worktree in titles: its branch, else its directory name.
func (t target) label() string {
	if t.branch != "" {
		return t.branch
	}
	return filepath.Base(t.path)
}

// resolveRemote is resolve for operations that talk to a remote: a worktree of a
// local-only repository fails with ErrNoRemote before any operation is recorded.
func (m *Manager) resolveRemote(worktreePath string) (target, error) {
	t, err := m.resolve(worktreePath)
	if err == nil && IsLocalOnly(t.repo) {
		return target{}, fmt.Errorf("%s: %w", t.repo.Name, ErrNoRemote)
	}
	return t, err
}

// Fetch implements Store: `git fetch --prune`.
func (m *Manager) Fetch(ctx context.Context, o FetchOptions) (Op, error) {
	t, err := m.resolveRemote(o.WorktreePath)
	if err != nil {
		return Op{}, err
	}
	return m.submit(ctx, KindFetch, "Fetch "+t.label(), t, true, func(ctx context.Context, x *run) (string, string, error) {
		res, err := x.git(ctx, "fetch", "--prune")
		if err != nil {
			return "", "", err
		}
		return fetchSummary(res.Combined), "", nil
	})
}

// Pull implements Store: `git pull --ff-only`, or `--rebase`. A rebase that stops on
// conflicts is aborted so the worktree is left as it was.
func (m *Manager) Pull(ctx context.Context, o PullOptions) (Op, error) {
	t, err := m.resolveRemote(o.WorktreePath)
	if err != nil {
		return Op{}, err
	}
	title := "Pull " + t.label()
	mode := "--ff-only"
	if o.Rebase {
		title, mode = "Pull --rebase "+t.label(), "--rebase"
	}
	return m.submit(ctx, KindPull, title, t, true, func(ctx context.Context, x *run) (string, string, error) {
		res, err := x.git(ctx, "pull", mode)
		if err == nil {
			return pullSummary(res.Combined, o.Rebase), "", nil
		}
		if o.Rebase && ctx.Err() == nil && x.rebaseInProgress(ctx) {
			if _, aerr := x.git(ctx, "rebase", "--abort"); aerr == nil {
				return "", "", &opError{summary: "rebase stopped on conflicts and was aborted; the worktree is unchanged"}
			}
		}
		return "", "", err
	})
}

// rebaseInProgress reports whether the worktree is in the middle of a rebase.
func (x *run) rebaseInProgress(ctx context.Context) bool {
	for _, p := range []string{"rebase-merge", "rebase-apply"} {
		out, ok := x.probe(ctx, "rev-parse", "--path-format=absolute", "--git-path", p)
		if ok && dirExists(out) {
			return true
		}
	}
	return false
}

// Push implements Store.
func (m *Manager) Push(ctx context.Context, o PushOptions) (Op, error) {
	t, err := m.resolveRemote(o.WorktreePath)
	if err != nil {
		return Op{}, err
	}
	title := "Push " + t.label()
	if o.ForceWithLease {
		title = "Force-push " + t.label()
	}
	return m.submit(ctx, KindPush, title, t, true, func(ctx context.Context, x *run) (string, string, error) {
		branch, err := x.branch(ctx)
		if err != nil {
			return "", "", err
		}
		return x.push(ctx, branch, o.ForceWithLease)
	})
}

// branch returns the checked-out branch, failing on a detached HEAD.
func (x *run) branch(ctx context.Context) (string, error) {
	out, ok := x.probe(ctx, "symbolic-ref", "--quiet", "--short", "HEAD")
	switch {
	case ctx.Err() != nil:
		return "", ctx.Err()
	case !ok:
		return "", &opError{summary: "HEAD is detached: check out a branch first"}
	}
	return out, nil
}

// push pushes branch. Without an upstream it runs `git push -u origin <branch>`, so a
// new feature branch (created with --no-track by the repo store) gets origin/<branch>
// as its upstream; with one it runs plain `git push`.
func (x *run) push(ctx context.Context, branch string, force bool) (string, string, error) {
	args := []string{"push"}
	if force {
		args = append(args, "--force-with-lease")
	}
	remote := "origin"
	up, hasUpstream := x.probe(ctx, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if ctx.Err() != nil {
		return "", "", ctx.Err()
	}
	if !hasUpstream {
		if _, ok := x.probe(ctx, "remote", "get-url", "origin"); !ok {
			if ctx.Err() != nil {
				return "", "", ctx.Err()
			}
			return "", "", &opError{summary: "no upstream and no remote named origin"}
		}
		x.note("# %s has no upstream: pushing to origin/%s and setting it as upstream", branch, branch)
		args = append(args, "-u", "origin", branch)
	} else if r, _, ok := strings.Cut(up, "/"); ok {
		remote = r
	}
	res, err := x.git(ctx, args...)
	if err != nil {
		return "", "", err
	}
	return pushSummary(res.Combined, branch, remote), "", nil
}

// CreatePR implements Store: push the branch (setting its upstream if needed), then
// `gh pr create`. An existing pull request for the branch counts as success and
// returns its URL.
func (m *Manager) CreatePR(ctx context.Context, o CreatePROptions) (Op, error) {
	t, err := m.resolveRemote(o.WorktreePath)
	if err != nil {
		return Op{}, err
	}
	slug := t.repo.GitHubSlug
	return m.submit(ctx, KindPRCreate, "Create PR for "+t.label(), t, true, func(ctx context.Context, x *run) (string, string, error) {
		ghBin, err := m.gh()
		if err != nil {
			return "", "", err
		}
		branch, err := x.branch(ctx)
		if err != nil {
			return "", "", err
		}
		title := strings.TrimSpace(o.Title)
		if title == "" {
			res, err := x.git(ctx, "log", "-1", "--format=%s")
			if err != nil {
				return "", "", err
			}
			if title = strings.TrimSpace(res.Stdout); title == "" {
				return "", "", &opError{summary: "no title given and HEAD has no commit subject"}
			}
		}
		if _, _, err := x.push(ctx, branch, false); err != nil {
			return "", "", err
		}
		args := []string{"pr", "create", "--head", branch, "--title", title, "--body", o.Body}
		if o.Draft {
			args = append(args, "--draft")
		}
		if o.Base != "" {
			args = append(args, "--base", o.Base)
		}
		if slug != "" {
			args = append(args, "--repo", slug)
		}
		res, err := x.exec(ctx, Cmd{Name: ghBin, Args: args})
		if err != nil {
			if u, n := findPRURL(res.Combined); u != "" && strings.Contains(res.Combined, "already exists") {
				return "pull request #" + n + " already exists", u, nil
			}
			return "", "", err
		}
		u, n := findPRURL(res.Stdout)
		if u == "" {
			return "created pull request", "", nil
		}
		kind := "pull request"
		if o.Draft {
			kind = "draft pull request"
		}
		return fmt.Sprintf("created %s #%s", kind, n), u, nil
	})
}

// OpenPR implements Store: find the branch's pull request with gh and open it in the
// default browser.
func (m *Manager) OpenPR(ctx context.Context, worktreePath string) (Op, error) {
	t, err := m.resolveRemote(worktreePath)
	if err != nil {
		return Op{}, err
	}
	slug := t.repo.GitHubSlug
	return m.submit(ctx, KindPROpen, "Open PR for "+t.label(), t, false, func(ctx context.Context, x *run) (string, string, error) {
		ghBin, err := m.gh()
		if err != nil {
			return "", "", err
		}
		branch, err := x.branch(ctx)
		if err != nil {
			return "", "", err
		}
		args := []string{"pr", "view", branch, "--json", "url,number", "--jq", ".url"}
		if slug != "" {
			args = append(args, "--repo", slug)
		}
		res, err := x.exec(ctx, Cmd{Name: ghBin, Args: args})
		if err != nil {
			return "", "", err
		}
		u, n := findPRURL(res.Stdout)
		if u == "" {
			return "", "", &opError{summary: "gh returned no pull request URL"}
		}
		if _, err := x.exec(ctx, Cmd{Name: m.opts.Open, Args: []string{u}}); err != nil {
			return "", u, err
		}
		return "opened pull request #" + n, u, nil
	})
}

// OpenEditor implements Store.
func (m *Manager) OpenEditor(ctx context.Context, worktreePath string) (Op, error) {
	t, err := m.resolve(worktreePath)
	if err != nil {
		return Op{}, err
	}
	env := systemEditorEnv()
	if m.opts.editorEnv != nil {
		env = *m.opts.editorEnv
	}
	argv, err := resolveEditor(m.opts.Editor(), t.path, env)
	if errors.Is(err, ErrInvalidArgument) {
		return Op{}, err
	}
	return m.submit(ctx, KindOpenEditor, "Open "+filepath.Base(t.path)+" in editor", t, false, func(ctx context.Context, x *run) (string, string, error) {
		if err != nil {
			x.note("%v", err)
			return "", "", &opError{summary: err.Error()}
		}
		if _, err := x.exec(ctx, Cmd{Name: argv[0], Args: argv[1:]}); err != nil {
			return "", "", err
		}
		return "opened " + filepath.Base(t.path) + " in " + editorName(argv), "", nil
	})
}

// editorName is a display name for argv: the app for `open -a App`, else the binary.
func editorName(argv []string) string {
	if len(argv) >= 3 && filepath.Base(argv[0]) == "open" && argv[1] == "-a" {
		return argv[2]
	}
	return filepath.Base(argv[0])
}

// Reveal implements Store: `open -R <path>` selects the worktree in Finder.
func (m *Manager) Reveal(ctx context.Context, worktreePath string) (Op, error) {
	t, err := m.resolve(worktreePath)
	if err != nil {
		return Op{}, err
	}
	return m.submit(ctx, KindReveal, "Reveal "+filepath.Base(t.path)+" in Finder", t, false, func(ctx context.Context, x *run) (string, string, error) {
		if _, err := x.exec(ctx, Cmd{Name: m.opts.Open, Args: []string{"-R", t.path}}); err != nil {
			return "", "", err
		}
		return "revealed " + t.path + " in Finder", "", nil
	})
}

// OpenURL implements Store. Only absolute http(s) URLs are opened: `open` would
// happily launch file:// paths or custom schemes.
func (m *Manager) OpenURL(ctx context.Context, rawURL string) (Op, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return Op{}, fmt.Errorf("%w: %q is not an http(s) URL", ErrInvalidArgument, rawURL)
	}
	s := u.String()
	return m.submit(ctx, KindOpenURL, "Open "+s, target{}, false, func(ctx context.Context, x *run) (string, string, error) {
		if _, err := x.exec(ctx, Cmd{Dir: "/", Name: m.opts.Open, Args: []string{s}}); err != nil {
			return "", s, err
		}
		return "opened " + s, s, nil
	})
}

// gh returns the gh executable.
func (m *Manager) gh() (string, error) {
	if m.opts.Gh != "" {
		return m.opts.Gh, nil
	}
	p, err := gh.LookPath()
	if err != nil {
		return "", &opError{summary: "gh is not installed (brew install gh)"}
	}
	return p, nil
}
