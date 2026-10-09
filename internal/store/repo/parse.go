package repo

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/url"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// idLen is how many hex characters of sha1(main worktree path) form a repo id.
const idLen = 12

// repoID derives a stable id from a repo's main worktree path.
func repoID(mainPath string) string {
	sum := sha1.Sum([]byte(mainPath))
	return hex.EncodeToString(sum[:])[:idLen]
}

// mainWorktreeFromCommonDir maps the output of
// `git rev-parse --path-format=absolute --git-common-dir` to the main worktree path.
// Every worktree of a repo shares the common dir, which for a non-bare repository is
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
	Untracked  int
	Conflicted int
}

// parseStatusV2 parses `git status --porcelain=v2 --branch -z`.
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
			if rec[0] == '2' {
				i++ // the original path of a rename/copy is the next NUL field
			}
		case 'u':
			st.Conflicted++
		case '?':
			st.Untracked++
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

// localOwner is the owner directory for repos without a GitHub origin. GitHub owner
// names cannot start with "_", so it never collides with a real owner.
const localOwner = "_local"

// defaultWorktreePath is <root>/<owner>/<repo>/<branch, "/" -> "-">, where owner/repo
// is the GitHub slug, or _local/<repo name> when there is none.
func defaultWorktreePath(root, slug, name, branch string) string {
	if slug == "" {
		slug = localOwner + "/" + name
	}
	return filepath.Join(root, filepath.FromSlash(slug), worktreeDirName(branch))
}

// refsFormat is the for-each-ref format parseRefs reads. Ref names cannot contain
// spaces, so one separates the name from its symbolic-ref target.
const refsFormat = "--format=%(refname) %(symref)"

// parseRefs parses `git for-each-ref <refsFormat> refs/heads refs/remotes` into
// sorted local branch names and "<remote>/<branch>" names. Symbolic refs (each
// remote's HEAD) are dropped.
func parseRefs(out []byte) Refs {
	var r Refs
	for line := range strings.Lines(string(out)) {
		name, symref, _ := strings.Cut(strings.TrimRight(line, "\r\n"), " ")
		if symref != "" {
			continue
		}
		if b, ok := strings.CutPrefix(name, "refs/heads/"); ok && b != "" {
			r.Local = append(r.Local, b)
		} else if rr, ok := strings.CutPrefix(name, "refs/remotes/"); ok && rr != "" {
			r.Remote = append(r.Remote, rr)
		}
	}
	slices.Sort(r.Local)
	slices.Sort(r.Remote)
	return r
}
