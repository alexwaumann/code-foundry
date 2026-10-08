package gitops

import (
	"fmt"
	"regexp"
	"strings"
)

// The summaries match git's and gh's English messages; ExecRunner pins LC_ALL=C.

func lines(out string) []string {
	var ls []string
	for l := range strings.SplitSeq(strings.ReplaceAll(out, "\r", "\n"), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			ls = append(ls, l)
		}
	}
	return ls
}

var spaces = regexp.MustCompile(`\s+`)

// failureSummary picks the most telling line of a failed command's output: a rejected
// ref, then git's fatal:/error:, then gh's last line. The prefix is dropped.
func failureSummary(out string) string {
	ls := lines(out)
	for _, l := range ls {
		if strings.HasPrefix(l, "! [") {
			return spaces.ReplaceAllString(strings.TrimPrefix(l, "! "), " ")
		}
	}
	for _, prefix := range []string{"fatal: ", "error: "} {
		for _, l := range ls {
			if s, ok := strings.CutPrefix(l, prefix); ok {
				return s
			}
		}
	}
	for i := len(ls) - 1; i >= 0; i-- {
		if !strings.HasPrefix(ls[i], "hint:") && !strings.HasPrefix(ls[i], "$ ") {
			return ls[i]
		}
	}
	return "failed"
}

// fetchSummary counts the ref lines `git fetch --prune` printed.
func fetchSummary(out string) string {
	var updated, pruned int
	for _, l := range lines(out) {
		switch {
		case strings.HasPrefix(l, "- [deleted]") || strings.HasPrefix(l, "x [deleted]"):
			pruned++
		case strings.Contains(l, " -> "):
			updated++
		}
	}
	switch {
	case updated == 0 && pruned == 0:
		return "already up to date"
	case pruned == 0:
		return fmt.Sprintf("fetched %s", plural(updated, "updated ref"))
	case updated == 0:
		return fmt.Sprintf("pruned %s", plural(pruned, "ref"))
	default:
		return fmt.Sprintf("fetched %s, pruned %d", plural(updated, "updated ref"), pruned)
	}
}

var shortstat = regexp.MustCompile(`^\d+ files? changed`)

// pullSummary describes a successful `git pull`.
func pullSummary(out string, rebase bool) string {
	ls := lines(out)
	stat := ""
	for _, l := range ls {
		if shortstat.MatchString(l) {
			stat = l
		}
	}
	for _, l := range ls {
		switch {
		case strings.HasPrefix(l, "Already up to date") || strings.HasPrefix(l, "Current branch") && strings.HasSuffix(l, "is up to date."):
			return "already up to date"
		case strings.HasPrefix(l, "Successfully rebased"):
			if stat != "" {
				return "rebased: " + stat
			}
			return "rebased onto upstream"
		case l == "Fast-forward":
			if stat != "" {
				return "fast-forwarded: " + stat
			}
			return "fast-forwarded"
		}
	}
	if rebase {
		return "rebased onto upstream"
	}
	if stat != "" {
		return "pulled: " + stat
	}
	return "pulled"
}

// pushSummary describes a successful `git push` of branch.
func pushSummary(out, branch, remote string) string {
	ls := lines(out)
	for _, l := range ls {
		if strings.HasPrefix(l, "Everything up-to-date") {
			return "already up to date"
		}
	}
	for _, l := range ls {
		switch {
		case strings.HasPrefix(l, "* [new branch]"):
			return fmt.Sprintf("pushed %s to %s (new branch)", branch, remote)
		case strings.HasPrefix(l, "+ ") && strings.Contains(l, "(forced update)"):
			return fmt.Sprintf("force-pushed %s to %s", branch, remote)
		}
	}
	return fmt.Sprintf("pushed %s to %s", branch, remote)
}

var prURL = regexp.MustCompile(`https://\S+/pull/(\d+)`)

// findPRURL returns the last pull request URL in out and its number.
func findPRURL(out string) (url, number string) {
	m := prURL.FindAllStringSubmatch(out, -1)
	if len(m) == 0 {
		return "", ""
	}
	last := m[len(m)-1]
	return last[0], last[1]
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}
