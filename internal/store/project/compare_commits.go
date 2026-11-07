package project

import (
	"cmp"
	"context"
	"strconv"
	"strings"
	"time"
)

// The commits of a comparison (docs/notes/diff-commits.md): the Diff tab's Commits section.
// WorktreeDetail's log is HEAD against the checkout's base, with no parents or messages, and
// the section follows the two sides instead.

const (
	// CompareCommitsMax caps the list: a branch that long is read by ranges, not row by row.
	CompareCommitsMax = 500
	// commitTextMax caps a subject and a body: the list goes whole in one response.
	commitTextMax = 8 << 10
	// commitFormat is sha, short sha, parents, author time, subject and body, which `-z` ends
	// with a NUL too: no message can hold one.
	commitFormat = "%H%x00%h%x00%P%x00%at%x00%s%x00%b"
	// commitFields is how many NUL-separated fields one commit has.
	commitFields = 6
)

// CompareCommit is one commit of a comparison.
type CompareCommit struct {
	SHA, ShortSHA string
	// Parent is the first parent, which a merge compares against; "" for a root commit.
	Parent        string
	Subject, Body string
	AuthoredAt    time.Time
}

// CompareLog is the commits between two sources.
type CompareLog struct {
	// Commits is newest first, at most CompareCommitsMax; Total counts them all.
	Commits []CompareCommit
	Total   int
	// Error says why a source could not be resolved; the list is then empty.
	Error string
}

// CompareCommitsRequest names the two sides of a comparison.
type CompareCommitsRequest struct {
	ProjectID, Path string
	Base, Head      DiffSource
}

// commitOf is the commit a side stands on, "" for the empty tree or an unborn branch: the
// working tree and the index are HEAD's.
func (c *comparison) commitOf(r ResolvedSource) string {
	return strings.TrimPrefix(cmp.Or(r.SHA, c.headSHA), emptyTree)
}

// commitText is a message's text as a response can carry it: valid UTF-8, within the cap.
func commitText(s string) string {
	s = strings.TrimSpace(strings.ToValidUTF8(s, "\uFFFD"))
	if len(s) <= commitTextMax {
		return s
	}
	return strings.ToValidUTF8(s[:commitTextMax], "")
}

// parseCompareCommits reads `git log -z --format=commitFormat`.
func parseCompareCommits(out []byte) []CompareCommit {
	f := strings.Split(string(out), "\x00")
	var res []CompareCommit
	for ; len(f) >= commitFields; f = f[commitFields:] {
		c := CompareCommit{SHA: f[0], ShortSHA: f[1], Subject: commitText(f[4]), Body: commitText(f[5])}
		if parent, _, _ := strings.Cut(f[2], " "); parent != "" {
			c.Parent = parent
		}
		if sec, err := strconv.ParseInt(f[3], 10, 64); err == nil {
			c.AuthoredAt = time.Unix(sec, 0)
		}
		res = append(res, c)
	}
	return res
}

// CompareCommits implements Store.
func (g *Git) CompareCommits(ctx context.Context, req CompareCommitsRequest) (CompareLog, error) {
	ctx = guarded(ctx)
	c, err := g.openCompare(ctx, req.ProjectID, req.Path, req.Base, req.Head)
	if err != nil {
		return CompareLog{}, err
	}
	if c.err != "" {
		return CompareLog{Error: c.err}, nil
	}
	from, to := c.commitOf(c.base), c.commitOf(c.head)
	if to == "" {
		return CompareLog{}, nil
	}
	rng := to
	if from != "" {
		rng = from + ".." + to
	}
	out, err := c.run("log", "-z", "-n", strconv.Itoa(CompareCommitsMax), "--no-color", "--no-show-signature", "--format="+commitFormat, rng, "--")
	if isMissingObject(err) {
		return CompareLog{Error: objectsMissing}, nil
	}
	if err != nil {
		return CompareLog{}, err
	}
	res := CompareLog{Commits: parseCompareCommits(out)}
	res.Total = len(res.Commits)
	if res.Total < CompareCommitsMax {
		return res, nil
	}
	if out, err = c.run("rev-list", "--count", rng, "--"); err != nil {
		return CompareLog{}, err
	}
	res.Total, _ = strconv.Atoi(string(trimNL(out)))
	return res, nil
}
