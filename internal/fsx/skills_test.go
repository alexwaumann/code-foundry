package fsx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillDescription(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		command bool
		want    string
	}{
		{"skill frontmatter", "---\nname: x\ndescription: Does x.\n---\nbody\n", false, "Does x."},
		{"double quoted", "---\ndescription: \"Quoted: yes\"\n---\n", false, "Quoted: yes"},
		{"single quoted", "---\ndescription: 'q'\n---\n", false, "q"},
		{"folded block", "---\ndescription: >\n  first line\n  second line\nname: x\n---\n", false, "first line second line"},
		{"literal block", "---\ndescription: |-\n  a\n\n  b\n---\n", false, "a b"},
		{"crlf and bom", "\xef\xbb\xbf---\r\ndescription: win\r\n---\r\n", false, "win"},
		{"skill without description", "---\nname: x\n---\nbody line\n", false, ""},
		{"skill without frontmatter", "body line\n", false, ""},
		{"nested key is not the description", "---\nmeta:\n  description: no\n---\n", false, ""},
		{"command first line", "# Title\n\n## Sub\n\n  Runs the thing.  \nmore\n", true, "Runs the thing."},
		{"command frontmatter wins", "---\ndescription: From front\n---\nBody.\n", true, "From front"},
		{"command frontmatter without description", "---\nallowed-tools: Bash\n---\n\nBody.\n", true, "Body."},
		{"command unterminated frontmatter", "---\ndescription: x\n", true, "---"},
		{"empty command", "\n\n# Only heading\n", true, ""},
		{"whitespace collapsed", "a   b\tc", true, "a b c"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SkillDescription(tt.text, tt.command); got != tt.want {
				t.Fatalf("SkillDescription = %q, want %q", got, tt.want)
			}
		})
	}
	long := SkillDescription(strings.Repeat("é", 400), true)
	if n := len([]rune(long)); n != maxDescription || !strings.HasSuffix(long, "…") {
		t.Fatalf("long description: %d runes, %q...", n, long[:10])
	}
}

func TestReadSkills(t *testing.T) {
	dir := realTemp(t)
	claude := filepath.Join(dir, ".claude")
	for p, s := range map[string]string{
		"skills/zeta/SKILL.md":       "---\ndescription: Last.\n---\n",
		"skills/alpha/SKILL.md":      "---\ndescription: First.\n---\n",
		"skills/no-skill-md/x.md":    "ignored",
		"commands/review.md":         "Review the diff.\n",
		"commands/notes.txt":         "not markdown",
		"commands/ops/deploy.md":     "# Deploy\nShip it.\n",
		"commands/ops/deep/build.md": "Build.\n",
	} {
		mkdir(t, filepath.Dir(filepath.Join(claude, p)))
		write(t, filepath.Join(claude, p), s)
	}
	// A skill directory that is a symlink (common for shared skills).
	shared := filepath.Join(dir, "shared", "linked")
	mkdir(t, shared)
	write(t, filepath.Join(shared, "SKILL.md"), "---\ndescription: Linked.\n---\n")
	symlink(t, shared, filepath.Join(claude, "skills", "linked"))
	// An unreadable skill is skipped.
	unreadable := filepath.Join(claude, "skills", "locked", "SKILL.md")
	mkdir(t, filepath.Dir(unreadable))
	write(t, unreadable, "---\ndescription: secret\n---\n")
	if err := os.Chmod(unreadable, 0); err != nil {
		t.Fatal(err)
	}

	type item struct{ name, desc, rel string }
	tests := []struct {
		name   string
		nested bool
		want   []item
	}{
		{"nested commands (project)", true, []item{
			{"alpha", "First.", "skills/alpha/SKILL.md"},
			{"build", "Build.", "commands/ops/deep/build.md"},
			{"deploy", "Ship it.", "commands/ops/deploy.md"},
			{"linked", "Linked.", "skills/linked/SKILL.md"},
			{"review", "Review the diff.", "commands/review.md"},
			{"zeta", "Last.", "skills/zeta/SKILL.md"},
		}},
		{"top-level commands only (user)", false, []item{
			{"alpha", "First.", "skills/alpha/SKILL.md"},
			{"linked", "Linked.", "skills/linked/SKILL.md"},
			{"review", "Review the diff.", "commands/review.md"},
			{"zeta", "Last.", "skills/zeta/SKILL.md"},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ReadSkills(claude, tt.nested, nil)
			var items []item
			for _, s := range got {
				rel, _ := filepath.Rel(claude, s.Path)
				items = append(items, item{s.Name, s.Description, rel})
			}
			if len(items) != len(tt.want) {
				t.Fatalf("ReadSkills = %v, want %v", items, tt.want)
			}
			for i := range items {
				if items[i] != tt.want[i] {
					t.Fatalf("ReadSkills[%d] = %v, want %v (all: %v)", i, items[i], tt.want[i], items)
				}
			}
		})
	}

	if got := ReadSkills(filepath.Join(dir, "missing"), true, nil); len(got) != 0 {
		t.Fatalf("missing dir: %v", got)
	}
}

func TestReadSkillsGitRepo(t *testing.T) {
	dir := gitRepo(t)
	got := ReadSkills(filepath.Join(dir, ".claude"), true, nil)
	if len(got) != 2 || got[0].Name != "x" || got[0].Description != "Does x." ||
		got[1].Name != "y" || got[1].Description != "Runs y." {
		t.Fatalf("ReadSkills = %+v", got)
	}
}
