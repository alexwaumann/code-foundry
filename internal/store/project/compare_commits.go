package project

import (
	"bytes"
	"cmp"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// The commits of a comparison (docs/notes/diff-commits.md): the Diff tab's Commits section.
// WorktreeDetail's log is HEAD against the checkout's base, with no parents or messages, and
// the section follows the two sides instead.

const (
	// CompareCommitsMax caps the list: a branch that long is read by ranges, not row by row.
	CompareCommitsMax = 500
	// commitSubjectMax caps a subject, and commitBodyMax the message under one. No message is
	// held whole: the list carries no bodies and every field is cut as git writes it
	// (runFields), since a commit's message can be any size and the list is read again on
	// every live update.
	commitSubjectMax = 1 << 10
	commitBodyMax    = 8 << 10
	// commitFormat is sha, short sha, parents, author time and subject, which `-z` ends with a
	// NUL too: no message can hold one.
	commitFormat = "%H%x00%h%x00%P%x00%at%x00%s"
	// commitFields is how many NUL-separated fields one commit has.
	commitFields = 5
	// commitGone is the answer for a sha that names no commit here.
	commitGone = "this commit is not in this checkout"
)

// commitLogArgs start every read of a message. A checkout's config is not to be trusted: a fifo
// in mailmap.file would hang the read and i18n.logOutputEncoding would change the bytes.
var commitLogArgs = []string{"log", "-z", "--no-color", "--no-show-signature", "--no-mailmap", "--encoding=UTF-8"}

// CompareCommit is one commit of a comparison.
type CompareCommit struct {
	SHA, ShortSHA string
	// Parent is the first parent, which a merge compares against; "" for a root commit.
	Parent  string
	Subject string
	// AuthoredAt is zero when the commit's date cannot be read.
	AuthoredAt time.Time
	// Shallow is a commit with no Parent only because the clone stops there.
	Shallow bool
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

// CompareCommitRequest names one commit of a checkout, by its full sha.
type CompareCommitRequest struct {
	ProjectID, Path, SHA string
}

// CompareCommitMessage is what the list leaves out of one commit.
type CompareCommitMessage struct {
	// Body is the message under the subject, at most commitBodyMax.
	Body string
	// Error says why the commit could not be read.
	Error string
}

// commitOf is the commit a side stands on, "" for the empty tree or an unborn branch: the
// working tree and the index are HEAD's.
func (c *comparison) commitOf(r ResolvedSource) string {
	return strings.TrimPrefix(cmp.Or(r.SHA, c.headSHA), emptyTree)
}

// commitText is a message's text as a response can carry it: valid UTF-8, within limit bytes
// and marked when cut.
func commitText(s string, limit int) string {
	s = strings.TrimSpace(strings.ToValidUTF8(s, "\uFFFD"))
	if len(s) <= limit {
		return s
	}
	return strings.ToValidUTF8(s[:limit-len("…")], "") + "…"
}

// parseCompareCommits reads `git log -z --format=commitFormat`. What does not start with a sha
// is not a row: nothing else is to be trusted about it. A date that is no number stays zero.
func parseCompareCommits(out []byte) []CompareCommit {
	f := strings.Split(string(out), "\x00")
	var res []CompareCommit
	for ; len(f) >= commitFields; f = f[commitFields:] {
		if !isSHA(f[0]) {
			continue
		}
		c := CompareCommit{SHA: f[0], ShortSHA: f[1], Subject: commitText(f[4], commitSubjectMax)}
		if parent, _, _ := strings.Cut(f[2], " "); isSHA(parent) {
			c.Parent = parent
		}
		if sec, err := strconv.ParseInt(f[3], 10, 64); err == nil {
			c.AuthoredAt = time.Unix(sec, 0)
		}
		res = append(res, c)
	}
	return res
}

// markShallow marks the parentless commits of a shallow clone: git shows the boundary as a root,
// and only says which kind of repository this is. One question, asked only with such a commit.
func (c *comparison) markShallow(commits []CompareCommit) error {
	if !slices.ContainsFunc(commits, func(x CompareCommit) bool { return x.Parent == "" }) {
		return nil
	}
	out, err := c.run("rev-parse", "--is-shallow-repository")
	if err != nil {
		return err
	}
	for i := range commits {
		commits[i].Shallow = commits[i].Parent == "" && string(trimNL(out)) == "true"
	}
	return nil
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
	// The extra bytes let commitText see that a field was cut.
	args := append(slices.Clone(commitLogArgs), "-n", strconv.Itoa(CompareCommitsMax), "--format="+commitFormat, rng, "--")
	out, err := runFields(ctx, g.runner, c.dir, commitSubjectMax+utf8.UTFMax, args...)
	if isMissingObject(err) {
		return CompareLog{Error: objectsMissing}, nil
	}
	if err != nil {
		return CompareLog{}, err
	}
	res := CompareLog{Commits: parseCompareCommits(out)}
	if err := c.markShallow(res.Commits); err != nil {
		return CompareLog{}, err
	}
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

// CompareCommitBody implements Store.
func (g *Git) CompareCommitBody(ctx context.Context, req CompareCommitRequest) (CompareCommitMessage, error) {
	if !isSHA(req.SHA) {
		return CompareCommitMessage{}, fmt.Errorf("%w: %q is not a full sha", ErrInvalidArgument, req.SHA)
	}
	ctx = guarded(ctx)
	_, _, dir, err := g.gitWorktree(req.ProjectID, req.Path)
	if err != nil {
		return CompareCommitMessage{}, err
	}
	// Only a commit: anything else this sha names has no message to show.
	if _, err := g.runner.Run(ctx, dir, "rev-parse", "--verify", "--quiet", "--end-of-options", req.SHA+"^{commit}"); err != nil {
		if noSuchCommit(err) {
			return CompareCommitMessage{Error: commitGone}, nil
		}
		return CompareCommitMessage{}, err
	}
	args := append(slices.Clone(commitLogArgs), "-n", "1", "--format=%b", req.SHA, "--")
	out, err := runFields(ctx, g.runner, dir, commitBodyMax+utf8.UTFMax, args...)
	if isMissingObject(err) {
		return CompareCommitMessage{Error: objectsMissing}, nil
	}
	if err != nil {
		return CompareCommitMessage{}, err
	}
	return CompareCommitMessage{Body: commitText(string(bytes.TrimRight(out, "\x00")), commitBodyMax)}, nil
}
