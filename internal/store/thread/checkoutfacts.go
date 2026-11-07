package thread

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// What a wake says about a thread's work is read from git, not taken from the thread: a
// report could only claim its branch and push state (docs/notes/wake-final-message.md).
// Local refs only: a push from the checkout moves its remote-tracking ref, so nothing here
// touches the network.

// checkoutFactsTimeout bounds one checkout's git calls: the wake goes without them after.
const checkoutFactsTimeout = 3 * time.Second

// CheckoutFacts is one checkout in a wake.
type CheckoutFacts struct {
	Project string `json:"project,omitempty"`
	Path    string `json:"path"`
	// Branch is what it has checked out, "" when detached; Head its short commit.
	Branch string `json:"branch,omitempty"`
	Head   string `json:"head,omitempty"`
	// Pushed: origin's branch has HEAD. Unpushed counts the commits it lacks, against
	// origin's branch or, before the first push, the base.
	Pushed   bool `json:"pushed"`
	Unpushed int  `json:"unpushed,omitempty"`
	// Uncommitted counts changed and untracked files.
	Uncommitted int `json:"uncommitted,omitempty"`
	// Base is origin/<default>; Files, Added and Deleted are `git diff base...HEAD`.
	Base    string `json:"base,omitempty"`
	Files   int    `json:"files,omitempty"`
	Added   int    `json:"added,omitempty"`
	Deleted int    `json:"deleted,omitempty"`
}

// touched reports whether the checkout holds any work.
func (c CheckoutFacts) touched() bool { return c.Files > 0 || c.Unpushed > 0 || c.Uncommitted > 0 }

// wakeCheckouts is what git says about t's checkouts: those made for it, and any other
// with work in it (a thread inherits checkouts it never touched). Off the locks: git runs.
func (m *Manager) wakeCheckouts(ctx context.Context, t Thread) []CheckoutFacts {
	var out []CheckoutFacts
	var defaults map[string]string
	if m.opts.Projects != nil {
		defaults = map[string]string{}
		for _, p := range m.opts.Projects.Snapshot().Projects {
			defaults[p.ID] = p.DefaultBranch
		}
	}
	for _, c := range m.checkouts(t) {
		if !c.Git || c.Missing || c.Path == "" {
			continue
		}
		f, ok := m.opts.CheckoutFacts(ctx, c.Path, defaults[c.ProjectID])
		if !ok || (!c.WorktreeMode && !f.touched()) {
			continue
		}
		f.Project, f.Path = c.ProjectName, c.Path
		out = append(out, f)
	}
	return out
}

// pullRequestURLs are the pull requests linked to t.
func pullRequestURLs(t Thread) []string {
	var out []string
	for _, p := range t.LinkedPullRequests {
		out = append(out, p.URL)
	}
	return out
}

var shortstatNumber = regexp.MustCompile(`(\d+) (file|insertion|deletion)`)

// parseShortstat reads `git diff --shortstat`: " 3 files changed, 41 insertions(+), 2 deletions(-)".
func parseShortstat(s string) (files, added, deleted int) {
	for _, m := range shortstatNumber.FindAllStringSubmatch(s, -1) {
		n, _ := strconv.Atoi(m[1])
		switch m[2] {
		case "file":
			files = n
		case "insertion":
			added = n
		case "deletion":
			deleted = n
		}
	}
	return files, added, deleted
}

// gitCheckoutFacts is the default Options.CheckoutFacts. False when dir has no commit or
// git fails; a base that does not exist only leaves the diff out.
func gitCheckoutFacts(ctx context.Context, dir, defaultBranch string) (CheckoutFacts, bool) {
	ctx, cancel := context.WithTimeout(ctx, checkoutFactsTimeout)
	defer cancel()
	git := func(args ...string) (string, bool) {
		var out bytes.Buffer
		cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
		cmd.Env = fsx.GitEnv(os.Environ())
		cmd.Stdout = &out
		if cmd.Run() != nil {
			return "", false
		}
		return strings.TrimSpace(out.String()), true
	}
	count := func(rng string) (int, bool) {
		s, ok := git("rev-list", "--count", rng)
		n, err := strconv.Atoi(s)
		return n, ok && err == nil
	}
	var f CheckoutFacts
	var ok bool
	if f.Head, ok = git("rev-parse", "--short", "HEAD"); !ok {
		return CheckoutFacts{}, false
	}
	if b, ok := git("symbolic-ref", "--quiet", "--short", "HEAD"); ok {
		f.Branch = b
	}
	base := ""
	if defaultBranch != "" {
		if _, ok := git("rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+defaultBranch+"^{commit}"); ok {
			base = "origin/" + defaultBranch
		}
	}
	remote := "origin/" + f.Branch
	_, tracked := git("rev-parse", "--verify", "--quiet", "refs/remotes/"+remote+"^{commit}")
	switch {
	case f.Branch != "" && tracked:
		// A count git could not make says nothing: never "pushed" on a failure.
		n, ok := count(remote + "..HEAD")
		f.Unpushed, f.Pushed = n, ok && n == 0
	case base != "":
		f.Unpushed, _ = count(base + "..HEAD")
	}
	if s, ok := git("status", "--porcelain"); ok && s != "" {
		f.Uncommitted = strings.Count(s, "\n") + 1
	}
	if base != "" {
		f.Base = base
		if s, ok := git("diff", "--shortstat", base+"...HEAD"); ok {
			f.Files, f.Added, f.Deleted = parseShortstat(s)
		}
	}
	return f, true
}
