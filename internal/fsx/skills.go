package fsx

import (
	"cmp"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

// Skills and slash commands for the composer's "/" completion
// (FilesystemService.ListSkills).

// Skill is one skill or command Claude Code would offer after "/".
type Skill struct {
	// Name is the skill's directory name or the command file's stem.
	Name string
	// Description is the frontmatter's description, else (commands only) the first
	// non-empty line that is not a heading. May be empty.
	Description string
	// Path is the absolute path of the SKILL.md or command file.
	Path string
}

// maxDescription bounds a description, in runes.
const maxDescription = 300

// maxSkillHead is how much of a skill or command file is read for its description.
const maxSkillHead = 64 << 10

// ReadSkills lists the skills and commands under claudeDir (a checkout's or the
// home's .claude directory), sorted by name, then path: skills/<name>/SKILL.md, and
// the commands/*.md files (in every subdirectory of commands when nested). A missing
// directory yields nothing; unreadable entries are skipped and logged at debug.
func ReadSkills(claudeDir string, nested bool, log *slog.Logger) []Skill {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	var out []Skill
	skillsDir := filepath.Join(claudeDir, "skills")
	if ents, err := os.ReadDir(skillsDir); err == nil {
		for _, e := range ents {
			p := filepath.Join(skillsDir, e.Name(), "SKILL.md")
			fi, err := os.Stat(p) // the skill directory may be a symlink
			if err != nil || !fi.Mode().IsRegular() {
				if err != nil && !os.IsNotExist(err) {
					log.Debug("skill skipped", "path", p, "err", err)
				}
				continue
			}
			desc, err := readDescription(p, false)
			if err != nil {
				log.Debug("skill skipped", "path", p, "err", err)
				continue
			}
			out = append(out, Skill{Name: e.Name(), Description: desc, Path: p})
		}
	} else if !os.IsNotExist(err) {
		log.Debug("skills directory skipped", "path", skillsDir, "err", err)
	}

	cmdDir := filepath.Join(claudeDir, "commands")
	// WalkDir does not follow a root that is a symlink (a commands directory kept in a
	// dotfiles checkout): walk its target and report the paths under cmdDir.
	root := cmdDir
	if real, err := filepath.EvalSymlinks(cmdDir); err == nil {
		root = real
	}
	walk := func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if !os.IsNotExist(err) {
				log.Debug("command skipped", "path", p, "err", err)
			}
			if d != nil && d.IsDir() && p != root {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if p != root && !nested {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(p), ".md") {
			return nil
		}
		if fi, err := os.Stat(p); err != nil || !fi.Mode().IsRegular() {
			return nil
		}
		desc, err := readDescription(p, true)
		if err != nil {
			log.Debug("command skipped", "path", p, "err", err)
			return nil
		}
		name := strings.TrimSuffix(d.Name(), filepath.Ext(d.Name()))
		if rel, err := filepath.Rel(root, p); err == nil {
			p = filepath.Join(cmdDir, rel)
		}
		out = append(out, Skill{Name: name, Description: desc, Path: p})
		return nil
	}
	_ = filepath.WalkDir(root, walk) // walk never returns an error itself

	slices.SortFunc(out, func(a, b Skill) int {
		return cmp.Or(cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)), cmp.Compare(a.Path, b.Path))
	})
	return out
}

// readDescription reads the head of a skill or command file and returns its
// description (see SkillDescription).
func readDescription(path string, command bool) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	head, err := io.ReadAll(io.LimitReader(f, maxSkillHead))
	if err != nil {
		return "", err
	}
	return SkillDescription(string(head), command), nil
}

// SkillDescription extracts a description from a SKILL.md or command file's text: the
// YAML frontmatter's description (plain, quoted, or a folded/literal block joined on
// one line). Without one, a command (command true) falls back to its first non-empty
// body line that is not a heading. The result is one line, at most 300 runes.
func SkillDescription(text string, command bool) string {
	text = strings.TrimPrefix(text, "\xef\xbb\xbf") // a UTF-8 byte order mark
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	body := lines
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		end := slices.IndexFunc(lines[1:], func(l string) bool { return strings.TrimSpace(l) == "---" })
		if end >= 0 {
			front := lines[1 : end+1]
			body = lines[end+2:]
			if d, ok := frontmatterDescription(front); ok {
				return clip(d)
			}
		}
	}
	if !command {
		return ""
	}
	for _, l := range body {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		return clip(l)
	}
	return ""
}

// frontmatterDescription finds the top-level "description:" key in YAML lines.
func frontmatterDescription(front []string) (string, bool) {
	for i, l := range front {
		v, ok := strings.CutPrefix(l, "description:")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if v == "" || strings.HasPrefix(v, ">") || strings.HasPrefix(v, "|") {
			// A block scalar (or a value on the next lines): the indented lines below.
			var parts []string
			for _, next := range front[i+1:] {
				if next != "" && next[0] != ' ' && next[0] != '\t' {
					break
				}
				if t := strings.TrimSpace(next); t != "" {
					parts = append(parts, t)
				}
			}
			return strings.Join(parts, " "), true
		}
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		return v, true
	}
	return "", false
}

// clip collapses whitespace and bounds s to maxDescription runes.
func clip(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= maxDescription {
		return s
	}
	r := []rune(s)
	return string(r[:maxDescription-1]) + "…"
}
