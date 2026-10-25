package workspace

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// InstructionNames are the instructions files a workspace's managed dir can hold, in the
// order a spawn reads them (the thread store's readInstructions).
var InstructionNames = []string{"CLAUDE.md", "AGENTS.md"}

// contents reads what w's managed dir holds: the instructions file (CLAUDE.md, else
// AGENTS.md) and the skills in .claude/skills (folders with a SKILL.md, sorted). A link
// of a rooted workspace reports its target, the real file under the root, so a client
// can open it. Missing or unreadable entries count as absent.
func contents(w Workspace) (instructions string, skills []string) {
	if w.ManagedDir == "" {
		return "", nil
	}
	for _, name := range InstructionNames {
		p := filepath.Join(w.ManagedDir, name)
		fi, err := os.Stat(p)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		if t, err := os.Readlink(p); err == nil {
			if !filepath.IsAbs(t) {
				t = filepath.Join(w.ManagedDir, t)
			}
			p = filepath.Clean(t)
		}
		instructions = p
		break
	}
	dir := filepath.Join(w.ManagedDir, ".claude", "skills")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return instructions, nil
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if fi, err := os.Stat(filepath.Join(dir, e.Name(), "SKILL.md")); err == nil && fi.Mode().IsRegular() {
			skills = append(skills, e.Name())
		}
	}
	slices.Sort(skills)
	return instructions, skills
}

// withContents is w with its managed dir's contents read again.
func withContents(w Workspace) Workspace {
	w.Instructions, w.Skills = contents(w)
	return w
}

// sameContents reports whether a and b hold the same instructions file and skills.
func sameContents(a, b Workspace) bool {
	return a.Instructions == b.Instructions && slices.Equal(a.Skills, b.Skills)
}
