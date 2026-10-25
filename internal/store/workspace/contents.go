package workspace

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// InstructionNames are the instructions files a workspace's folder can hold, in the
// order a spawn reads them (InstructionsFile).
var InstructionNames = []string{"CLAUDE.md", "AGENTS.md"}

// InstructionsFile is the instructions file in dir: CLAUDE.md, else AGENTS.md, the
// first that is a regular file (through symlinks). skipped are the names that exist but
// are not one (a folder, a symlink loop or one to nothing), for the caller to log; ""
// when there is none. The card (contents) and a spawn (the thread store) both pick the
// file this way, so they always agree.
func InstructionsFile(dir string) (path string, skipped []string) {
	if dir == "" {
		return "", nil
	}
	for _, name := range InstructionNames {
		p := filepath.Join(dir, name)
		fi, err := os.Stat(p)
		if err == nil && fi.Mode().IsRegular() {
			return p, skipped
		}
		if _, lerr := os.Lstat(p); lerr == nil {
			skipped = append(skipped, p)
		}
	}
	return "", skipped
}

// contents reads what w's folder (Dir: a rooted workspace's root, else its managed dir)
// holds: the instructions file (InstructionsFile) and the skills in .claude/skills
// (folders with a SKILL.md, sorted). Reading the root itself, not the managed dir's
// links, makes the root's files the workspace's even when a stray real file sits in the
// managed dir (Strays). rootMissing: w is rooted and its root is not a folder now.
// Missing or unreadable entries count as absent.
func contents(w Workspace) (instructions string, skills []string, rootMissing bool) {
	dir := w.Dir()
	if dir == "" {
		return "", nil, false
	}
	if w.RootPath != "" {
		if fi, err := os.Stat(w.RootPath); err != nil || !fi.IsDir() {
			return "", nil, true
		}
	}
	if p, _ := InstructionsFile(dir); p != "" {
		instructions = filepath.Clean(p)
	}
	sdir := filepath.Join(dir, ".claude", "skills")
	entries, err := os.ReadDir(sdir)
	if err != nil {
		return instructions, nil, false
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if fi, err := os.Stat(filepath.Join(sdir, e.Name(), "SKILL.md")); err == nil && fi.Mode().IsRegular() {
			skills = append(skills, e.Name())
		}
	}
	slices.Sort(skills)
	return instructions, skills, false
}

// withContents is w with its folder's contents read again.
func withContents(w Workspace) Workspace {
	w.Instructions, w.Skills, w.RootMissing = contents(w)
	return w
}

// sameContents reports whether a and b hold the same instructions file and skills, and
// agree on whether the root is there.
func sameContents(a, b Workspace) bool {
	return a.Instructions == b.Instructions && slices.Equal(a.Skills, b.Skills) && a.RootMissing == b.RootMissing
}
