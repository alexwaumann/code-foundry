package gitops

import (
	"os"
	"path/filepath"
	"strings"
)

// readHeadBranch reads the current branch directly from the git directory's HEAD file
// without spawning a git subprocess. It supports normal repositories (.git directory),
// linked worktrees and submodules (.git file with "gitdir: ..."), and subdirectories
// of a worktree.
//
// Return values:
//   - (branch, true, true): HEAD is a symbolic ref to refs/heads/<branch>
//   - ("", false, true): HEAD is detached at a commit SHA
//   - ("", false, false): .git/HEAD could not be resolved directly (e.g., not a git
//     repository, reftable backend, or unexpected format); callers should fall back to git.
func readHeadBranch(dir string) (branch string, attached bool, ok bool) {
	gitDir, found := findGitDir(dir)
	if !found {
		return "", false, false
	}
	b, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return "", false, false
	}
	return parseHeadFile(string(b))
}

// findGitDir walks upward from dir to locate the git directory (either a .git
// directory or the target of a .git file's "gitdir:" pointer).
func findGitDir(dir string) (string, bool) {
	cur := filepath.Clean(dir)
	for {
		dotGit := filepath.Join(cur, ".git")
		fi, err := os.Stat(dotGit)
		if err == nil {
			if fi.IsDir() {
				return dotGit, true
			}
			if fi.Mode().IsRegular() {
				raw, err := os.ReadFile(dotGit)
				if err != nil {
					return "", false
				}
				line := strings.TrimSpace(string(raw))
				target, ok := strings.CutPrefix(line, "gitdir:")
				if !ok {
					return "", false
				}
				target = strings.TrimSpace(target)
				if target == "" {
					return "", false
				}
				if !filepath.IsAbs(target) {
					target = filepath.Join(cur, target)
				}
				return filepath.Clean(target), true
			}
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", false
		}
		cur = parent
	}
}

// parseHeadFile parses the content of a git HEAD file.
func parseHeadFile(content string) (branch string, attached bool, ok bool) {
	line := strings.TrimSpace(content)
	if ref, isRef := strings.CutPrefix(line, "ref:"); isRef {
		ref = strings.TrimSpace(ref)
		b, isBranch := strings.CutPrefix(ref, "refs/heads/")
		if !isBranch || b == "" || b == ".invalid" {
			// ".invalid" is git's reftable placeholder; fall back to git symbolic-ref.
			return "", false, false
		}
		return b, true, true
	}
	if isCommitSHA(line) {
		return "", false, true
	}
	return "", false, false
}

// isCommitSHA reports whether s is a 40-char (SHA-1) or 64-char (SHA-256) hex commit ID.
func isCommitSHA(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}
