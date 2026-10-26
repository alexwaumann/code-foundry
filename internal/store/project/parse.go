package project

import (
	"bytes"
	"cmp"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// idLen is how many hex characters of sha1(main worktree path) form a project id.
const idLen = 12

// projectID derives a stable id from a project's main worktree path.
func projectID(mainPath string) string {
	sum := sha1.Sum([]byte(mainPath))
	return hex.EncodeToString(sum[:])[:idLen]
}

// mainWorktreeFromCommonDir maps the output of
// `git rev-parse --path-format=absolute --git-common-dir` to the main worktree path.
// Every worktree of a project shares the common dir, which for a non-bare repository is
// <main worktree>/.git.
func mainWorktreeFromCommonDir(out string) (string, error) {
	dir := filepath.Clean(strings.TrimSpace(out))
	if dir == "." || !filepath.IsAbs(dir) {
		return "", fmt.Errorf("%w: unexpected git common dir %q", ErrInvalidArgument, out)
	}
	if filepath.Base(dir) != ".git" {
		return "", fmt.Errorf("%w: %s is a bare repository or uses a separate git dir; only repositories with a .git directory are supported",
			ErrInvalidArgument, dir)
	}
	return filepath.Dir(dir), nil
}

// statusInfo is what `git status --porcelain=v2 --branch -z` reports.
type statusInfo struct {
	Head       string // "" when unborn
	Branch     string // "" when detached
	Detached   bool
	Upstream   string
	Ahead      int
	Behind     int
	Staged     int
	Modified   int
	Untracked  int // files: untracked directories are expanded (--untracked-files=all)
	Conflicted int
	// Entries lists every changed path in output order, nil when there are none. It
	// stays here rather than on Status, which is compared with ==; the detail job
	// derives the uncommitted file list from it (wtSlot.entries, uncommittedFiles).
	Entries []statusEntry
}

// statusEntry is one path `git status --porcelain=v2` reports.
type statusEntry struct {
	Path string
	// OrigPath is the source of a rename or copy (X is R or C); "" otherwise.
	OrigPath string
	// X and Y are the index (HEAD to index) and worktree (index to working tree)
	// letters, '.' when unchanged. For an unmerged entry they are the two sides'
	// letters (UU, AA, DU, ...); for an untracked one both are '?'.
	X, Y      byte
	Unmerged  bool
	Untracked bool
}

// statusArgs runs `git status` so that its output depends on the repository, not on
// user config: status.showUntrackedFiles (no, or normal, which collapses an untracked
// directory to "dir/") and status.renames (false) are overridden. Every untracked,
// non-ignored file is listed on its own. status.renames=copies still reports copies
// (C): --find-renames raises detection to renames but never lowers it. Ignored files
// are never listed (no --ignored).
var statusArgs = []string{"status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--find-renames"}

// parseStatusV2 parses `git status --porcelain=v2 --branch -z` (statusArgs).
//
//	# branch.oid <sha> | (initial)
//	# branch.head <name> | (detached)
//	# branch.upstream <upstream>
//	# branch.ab +<ahead> -<behind>
//	1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//	2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
//	u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
//	? <path>
//	! <path>
//
// X is the index (staged) state and Y the worktree state; "." means unchanged.
func parseStatusV2(out []byte) (statusInfo, error) {
	var st statusInfo
	fields := bytes.Split(out, []byte{0})
	for i := 0; i < len(fields); i++ {
		rec := string(fields[i])
		if rec == "" {
			continue
		}
		switch rec[0] {
		case '#':
			key, val, _ := strings.Cut(strings.TrimPrefix(rec, "# "), " ")
			switch key {
			case "branch.oid":
				if val != "(initial)" {
					st.Head = val
				}
			case "branch.head":
				if val == "(detached)" {
					st.Detached = true
				} else {
					st.Branch = val
				}
			case "branch.upstream":
				st.Upstream = val
			case "branch.ab":
				a, b, ok := strings.Cut(val, " ")
				ahead, err1 := strconv.Atoi(strings.TrimPrefix(a, "+"))
				behind, err2 := strconv.Atoi(strings.TrimPrefix(b, "-"))
				if !ok || err1 != nil || err2 != nil {
					return statusInfo{}, fmt.Errorf("parse status: bad branch.ab %q", val)
				}
				st.Ahead, st.Behind = ahead, behind
			}
		case '1', '2':
			if len(rec) < 4 || rec[1] != ' ' {
				return statusInfo{}, fmt.Errorf("parse status: bad entry %q", rec)
			}
			if rec[2] != '.' {
				st.Staged++
			}
			if rec[3] != '.' {
				st.Modified++
			}
			// Eight space-separated fields precede an ordinary entry's path, nine a
			// rename's or copy's; the path may contain spaces.
			n := 9
			if rec[0] == '2' {
				n = 10
			}
			f := strings.SplitN(rec, " ", n)
			if len(f) != n || f[n-1] == "" {
				return statusInfo{}, fmt.Errorf("parse status: bad entry %q", rec)
			}
			e := statusEntry{Path: f[n-1], X: rec[2], Y: rec[3]}
			if rec[0] == '2' {
				i++ // the original path of a rename/copy is the next NUL field
				if i < len(fields) {
					e.OrigPath = string(fields[i])
				}
			}
			st.Entries = append(st.Entries, e)
		case 'u':
			// Ten space-separated fields precede the path, which may contain spaces.
			f := strings.SplitN(rec, " ", 11)
			if len(f) != 11 || f[10] == "" {
				return statusInfo{}, fmt.Errorf("parse status: bad unmerged entry %q", rec)
			}
			st.Conflicted++
			st.Entries = append(st.Entries, statusEntry{Path: f[10], X: rec[2], Y: rec[3], Unmerged: true})
		case '?':
			if len(rec) < 3 || rec[1] != ' ' {
				return statusInfo{}, fmt.Errorf("parse status: bad untracked entry %q", rec)
			}
			st.Untracked++
			st.Entries = append(st.Entries, statusEntry{Path: rec[2:], X: '?', Y: '?', Untracked: true})
		case '!':
			// ignored files are only listed with --ignored; never counted
		default:
			return statusInfo{}, fmt.Errorf("parse status: unknown entry %q", rec)
		}
	}
	return st, nil
}

// listedWorktree is one record of `git worktree list --porcelain -z`.
type listedWorktree struct {
	Path     string
	Head     string
	Branch   string // short name
	Detached bool
	Bare     bool
	Locked   bool
	Prunable bool
}

// parseWorktreeList parses `git worktree list --porcelain -z`: attributes are
// NUL-terminated, records are separated by an empty field. The first record is the
// main worktree.
//
//	worktree <path>  HEAD <sha>  branch refs/heads/<name> | detached | bare
//	[locked [<reason>]]  [prunable [<reason>]]
func parseWorktreeList(out []byte) ([]listedWorktree, error) {
	var (
		list []listedWorktree
		cur  *listedWorktree
	)
	for _, f := range bytes.Split(out, []byte{0}) {
		line := string(f)
		if line == "" {
			cur = nil
			continue
		}
		key, val, _ := strings.Cut(line, " ")
		if key == "worktree" {
			list = append(list, listedWorktree{Path: val})
			cur = &list[len(list)-1]
			continue
		}
		if cur == nil {
			return nil, fmt.Errorf("parse worktree list: %q before any worktree line", line)
		}
		switch key {
		case "HEAD":
			cur.Head = val
		case "branch":
			cur.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "detached":
			cur.Detached = true
		case "bare":
			cur.Bare = true
		case "locked":
			cur.Locked = true
		case "prunable":
			cur.Prunable = true
		}
	}
	return list, nil
}

// parseLeftRightCount parses `git rev-list --left-right --count A...B` ("3\t5\n"):
// commits only in A, then commits only in B.
func parseLeftRightCount(out []byte) (left, right int, err error) {
	parts := strings.Fields(string(out))
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("parse rev-list count: %q", out)
	}
	if left, err = strconv.Atoi(parts[0]); err != nil {
		return 0, 0, fmt.Errorf("parse rev-list count: %q: %w", out, err)
	}
	if right, err = strconv.Atoi(parts[1]); err != nil {
		return 0, 0, fmt.Errorf("parse rev-list count: %q: %w", out, err)
	}
	return left, right, nil
}

// parseRemotes parses `git remote` output (one name per line) into sorted names, nil
// when there are none.
func parseRemotes(out []byte) []string {
	names := strings.Fields(string(out))
	if len(names) == 0 {
		return nil
	}
	slices.Sort(names)
	return slices.Compact(names)
}

// parseOriginHead maps `git symbolic-ref refs/remotes/origin/HEAD` output
// ("refs/remotes/origin/main") to the branch name ("main").
func parseOriginHead(out []byte) string {
	ref := strings.TrimSpace(string(out))
	return strings.TrimPrefix(ref, "refs/remotes/origin/")
}

// githubHosts are remote hosts treated as GitHub.
var githubHosts = map[string]bool{"github.com": true, "www.github.com": true, "ssh.github.com": true}

// parseGitHubSlug extracts "owner/name" from a GitHub remote URL, or returns "".
// Accepted forms:
//
//	git@github.com:owner/name.git            (scp-like ssh)
//	ssh://git@github.com[:port]/owner/name.git
//	https://[user@]github.com/owner/name[.git][/]
//	git://github.com/owner/name.git
func parseGitHubSlug(remote string) string {
	remote = strings.TrimSpace(remote)
	var host, p string
	if u, err := url.Parse(remote); err == nil && u.Scheme != "" && u.Host != "" {
		switch u.Scheme {
		case "https", "http", "ssh", "git", "git+ssh", "ssh+git":
		default:
			return ""
		}
		host, p = u.Hostname(), u.Path
	} else {
		// scp-like: [user@]host:path. A "/" before the ":" means a local path.
		at := strings.Index(remote, "@")
		colon := strings.Index(remote, ":")
		if colon < 0 || strings.Contains(remote[:colon], "/") {
			return ""
		}
		host, p = remote[at+1:colon], remote[colon+1:]
	}
	if !githubHosts[strings.ToLower(host)] {
		return ""
	}
	p = strings.Trim(p, "/")
	p = strings.TrimSuffix(p, ".git")
	owner, name, ok := strings.Cut(p, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return ""
	}
	return owner + "/" + name
}

// worktreeDirName maps a branch to a directory name: "alex/fix-x" -> "alex-fix-x".
func worktreeDirName(branch string) string {
	return strings.ReplaceAll(branch, "/", "-")
}

// localOwner is the owner directory for projects without a GitHub origin. GitHub owner
// names cannot start with "_", so it never collides with a real owner.
const localOwner = "_local"

// defaultWorktreePath is <root>/<key>/<branch, "/" -> "-">, where key is the project's
// directory (Git.worktreeDirKey: owner/repo for a GitHub slug, else _local/<repo
// name>, suffixed when another project has it).
func defaultWorktreePath(root, key, branch string) string {
	return filepath.Join(root, filepath.FromSlash(key), worktreeDirName(branch))
}

// refsFormat is the for-each-ref format parseRefs reads: the full ref name, its
// symbolic-ref target and its commit date (unix seconds), tab separated (ref names
// cannot contain tabs).
const refsFormat = "--format=%(refname)%09%(symref)%09%(committerdate:unix)"

// parseRefs parses `git for-each-ref <refsFormat> refs/heads refs/remotes` into
// sorted local branch names and "<remote>/<branch>" names, and Branches: the local
// and origin's branch short names merged by name, newest commit first (a name's
// newest date of the two; ties by name). Symbolic refs (each remote's HEAD) are
// dropped.
func parseRefs(out []byte) Refs {
	var r Refs
	newest := map[string]int64{}
	branch := func(name string, date int64) {
		if d, ok := newest[name]; !ok || date > d {
			newest[name] = date
		}
	}
	for line := range strings.Lines(string(out)) {
		name, rest, _ := strings.Cut(strings.TrimRight(line, "\r\n"), "\t")
		symref, dateField, _ := strings.Cut(rest, "\t")
		if symref != "" {
			continue
		}
		date, _ := strconv.ParseInt(strings.TrimSpace(dateField), 10, 64)
		if b, ok := strings.CutPrefix(name, "refs/heads/"); ok && b != "" {
			r.Local = append(r.Local, b)
			branch(b, date)
		} else if rr, ok := strings.CutPrefix(name, "refs/remotes/"); ok && rr != "" {
			r.Remote = append(r.Remote, rr)
			if b, ok := strings.CutPrefix(rr, "origin/"); ok && b != "" && b != "HEAD" {
				branch(b, date)
			}
		}
	}
	slices.Sort(r.Local)
	slices.Sort(r.Remote)
	if len(newest) > 0 {
		r.Branches = make([]string, 0, len(newest))
		for name := range newest {
			r.Branches = append(r.Branches, name)
		}
		slices.SortFunc(r.Branches, func(a, b string) int {
			if c := cmp.Compare(newest[b], newest[a]); c != 0 {
				return c
			}
			return strings.Compare(a, b)
		})
	}
	return r
}
