package thread

import (
	"cmp"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Branch names of new worktrees and new workspaces (docs/notes/branch-naming-modes.md).
//
// The projects.branch_naming setting picks a mode (BranchNaming, read per Create
// through Options.BranchNaming):
//
//   - prefix: <prefix>/<slug> (a bare slug when the prefix is empty).
//   - semantic: <type>/<slug>, the type one of BranchTypes (anything else is chore).
//   - custom: the naming model writes the whole branch from the user's instructions;
//     only whitespace is replaced and git check-ref-format checks the result.
//
// The slug comes from the namer's reply, which also carries the thread's title (one
// call). A --branch value (NewWorktree.Branch, NewWorkspace.Branch) with a slash is
// the branch, verbatim; without one it is the slug the mode wraps (in custom mode a
// hint for the model). An auto-generated branch that is taken gets -2..-9; a --branch
// one that exists is checked out instead, its base ignored. Whatever has nothing
// usable (the namer failed, timed out or is off) falls back to cf/<thread id>.

// Branch naming modes (the projects.branch_naming values).
const (
	BranchModePrefix   = "prefix"
	BranchModeSemantic = "semantic"
	BranchModeCustom   = "custom"
)

// BranchTypes are the types a semantic branch may start with.
var BranchTypes = []string{"feat", "fix", "chore", "docs", "ci", "refactor", "test", "perf", "build"}

// defaultBranchType is a semantic branch's type when the model's is not in BranchTypes.
const defaultBranchType = "chore"

// fallbackPrefix names a branch nothing better named: cf/<thread id>.
const fallbackPrefix = "cf/"

// maxBranchSuffix bounds the -2, -3, ... suffixes tried when a branch is taken.
const maxBranchSuffix = 9

// BranchNaming is the branch naming configuration (the projects.branch_* settings).
type BranchNaming struct {
	// Mode is BranchModePrefix, BranchModeSemantic or BranchModeCustom; anything else
	// is semantic.
	Mode string
	// Prefix is prefix mode's first component, without a slash; "" gives a bare slug.
	Prefix string
	// Instructions are custom mode's, handed to the naming model verbatim.
	Instructions string
}

// DefaultBranchNaming is what Options.BranchNaming returns when unset: the settings'
// defaults.
func DefaultBranchNaming() BranchNaming {
	return BranchNaming{Mode: BranchModeSemantic, Prefix: "cf"}
}

// branchChoice is how a new worktree's or workspace's branch is chosen.
type branchChoice struct {
	cfg BranchNaming
	// verbatim is a --branch value with a slash: the branch.
	verbatim string
	// hint is a --branch value without one, as a slug.
	hint string
}

// newBranchChoice reads a --branch value (may be "") against the current settings.
func (m *Manager) newBranchChoice(flag string) (branchChoice, error) {
	bc := branchChoice{cfg: m.opts.BranchNaming()}
	flag = strings.TrimSpace(flag)
	switch {
	case flag == "":
	case strings.Contains(flag, "/"):
		if err := validateRef(flag); err != nil {
			return bc, fmt.Errorf("%w: branch %q", ErrInvalidArgument, flag)
		}
		bc.verbatim = flag
	default:
		if bc.hint = workspace.Slug(flag); bc.hint == "" {
			return bc, fmt.Errorf("%w: branch %q has no letters or digits to make a slug of", ErrInvalidArgument, flag)
		}
	}
	return bc, nil
}

// branchRequest is what the namer is asked about the branch, or nil when the branch
// needs no model: a verbatim one, or a prefix-mode slug the user gave.
func (bc branchChoice) branchRequest() *BranchRequest {
	if bc.verbatim != "" || (bc.cfg.Mode == BranchModePrefix && bc.hint != "") {
		return nil
	}
	return &BranchRequest{Mode: bc.cfg.Mode, Instructions: bc.cfg.Instructions, Hint: bc.hint}
}

// composeBranch builds a branch for cfg from the namer's branch field (reply), its
// title (a slug of last resort) and the user's slug (hint, which wins over the
// model's). "" when there is nothing to build one from. A custom branch is not
// validated here (validBranch).
func composeBranch(cfg BranchNaming, hint, reply, title string) string {
	reply = strings.TrimSpace(reply)
	slug := func(fromReply string) string {
		return cmp.Or(hint, slugify(fromReply), slugify(title))
	}
	switch cfg.Mode {
	case BranchModeCustom:
		if b := strings.Join(strings.Fields(reply), "-"); b != "" {
			return b
		}
		if hint != "" {
			return fallbackPrefix + hint
		}
		return ""
	case BranchModePrefix:
		s := slug(reply)
		if s == "" {
			return ""
		}
		if p := strings.Trim(cfg.Prefix, "/ "); p != "" {
			return p + "/" + s
		}
		return s
	default:
		typ, rest, found := strings.Cut(reply, "/")
		if !found {
			typ, rest = "", reply
			if t := strings.ToLower(reply); slices.Contains(BranchTypes, t) {
				typ, rest = t, "" // a bare type: the answer to a hint
			}
		}
		typ = strings.ToLower(strings.TrimSpace(typ))
		if !slices.Contains(BranchTypes, typ) {
			typ = defaultBranchType
		}
		s := slug(rest)
		if s == "" {
			return ""
		}
		return typ + "/" + s
	}
}

// offBranch is the branch when auto-naming is off (no model call): prefix mode names
// it after the user's slug or the thread's explicit name; the other modes keep only a
// user's slug (composeBranch's model-less shape), else "" (cf/<id>).
func offBranch(bc branchChoice, name string) string {
	if bc.cfg.Mode == BranchModePrefix {
		return composeBranch(bc.cfg, bc.hint, "", name)
	}
	if bc.hint != "" {
		return composeBranch(bc.cfg, bc.hint, "", "")
	}
	return ""
}

// slugPart is the last component of a branch: a workspace named after its branch takes
// it (feat/add-filter -> add-filter).
func slugPart(branch string) string {
	return branch[strings.LastIndexByte(branch, '/')+1:]
}

// pickBranch turns the composed branch (may be "") into the one to create, in every
// repository at projectPaths. A user-chosen branch is kept as it is (existing reports
// whether it exists locally or on origin in one of them, to be checked out; origin is
// asked first when no ref has it: userBranchExists). An auto-generated one gets -2..-9
// while it is taken there or reserved by another Create picking at the same time
// (reserveBranch); release ends the reservation once the worktrees are made (a no-op
// for a user-chosen branch, which parallel Creates share). Anything unusable is cf/<id>.
func (m *Manager) pickBranch(ctx context.Context, projectPaths []string, bc branchChoice, branch, id string) (picked string, existing bool, release func()) {
	none := func() {}
	fallback := fallbackPrefix + id
	if bc.verbatim != "" {
		return bc.verbatim, m.userBranchExists(ctx, projectPaths, bc.verbatim), none
	}
	if branch == "" {
		return fallback, false, none
	}
	if bc.cfg.Mode == BranchModeCustom && !validBranch(ctx, branch) {
		m.log.Warn("custom branch name is not a valid git branch; using a fallback", "thread", id, "branch", branch)
		if bc.hint != "" {
			return fallbackPrefix + bc.hint, m.userBranchExists(ctx, projectPaths, fallbackPrefix+bc.hint), none
		}
		return fallback, false, none
	}
	if bc.hint != "" {
		return branch, m.userBranchExists(ctx, projectPaths, branch), none
	}
	for i := 1; i <= maxBranchSuffix; i++ {
		b := branch
		if i > 1 {
			b += "-" + strconv.Itoa(i)
		}
		release, ok := m.reserveBranch(projectPaths, b)
		if !ok {
			continue
		}
		if !m.branchExists(ctx, projectPaths, b) {
			return b, false, release
		}
		release()
	}
	return fallback, false, none
}

// reserveBranch reserves branch in every repository at projectPaths for the Create that
// picked it, unless another Create holds it in one of them (ok false): two Creates
// naming their branch alike at the same time get branch and branch-2 instead of racing
// to make the same new branch.
func (m *Manager) reserveBranch(projectPaths []string, branch string) (release func(), ok bool) {
	m.branchResMu.Lock()
	defer m.branchResMu.Unlock()
	keys := make([]string, len(projectPaths))
	for i, p := range projectPaths {
		keys[i] = filepath.Clean(p) + "\x00" + branch
		if _, held := m.branchRes[keys[i]]; held {
			return nil, false
		}
	}
	if m.branchRes == nil {
		m.branchRes = map[string]struct{}{}
	}
	for _, k := range keys {
		m.branchRes[k] = struct{}{}
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			m.branchResMu.Lock()
			defer m.branchResMu.Unlock()
			for _, k := range keys {
				delete(m.branchRes, k)
			}
		})
	}, true
}

// branchExists reports whether branch exists locally or on origin in any of
// projectPaths (the refs on disk; nothing is fetched).
func (m *Manager) branchExists(ctx context.Context, projectPaths []string, branch string) bool {
	for _, p := range projectPaths {
		if m.opts.RefExists(ctx, p, "refs/heads/"+branch) || m.opts.RefExists(ctx, p, "refs/remotes/origin/"+branch) {
			return true
		}
	}
	return false
}

// userBranchExists is branchExists for a branch the user named, which may be on origin
// only and not fetched yet (pushed from another clone): when no ref has it, each
// repository's origin is asked (FetchBranch, which also writes the remote-tracking ref
// the new worktree's branch then tracks). Without that the branch would be made anew
// from the base, beside origin's.
func (m *Manager) userBranchExists(ctx context.Context, projectPaths []string, branch string) bool {
	if m.branchExists(ctx, projectPaths, branch) {
		return true
	}
	for _, p := range projectPaths {
		if m.opts.FetchBranch(ctx, p, branch) {
			m.log.Info("branch found on origin", "path", p, "branch", branch)
			return true
		}
	}
	return false
}

// validBranch reports whether git accepts branch as a branch name
// (git check-ref-format --branch, which needs no repository).
func validBranch(ctx context.Context, branch string) bool {
	if validateRef(branch) != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "git", "check-ref-format", "--branch", branch).Run() == nil
}
