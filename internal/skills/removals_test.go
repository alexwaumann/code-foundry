package skills_test

import (
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/skills"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The plugin skill's removals reference is rendered from the SDK's list, so it cannot
// drift: every entry is a row with its symbols, stage, dates, replacement and move, and
// SKILL.md sends an agent there before it changes a plugin.
func TestRemovalsReference(t *testing.T) {
	files, err := skills.Render(realSources(t))
	if err != nil {
		t.Fatal(err)
	}
	ref := string(files["code-foundry-plugin/reference/removals.md"])
	if len(pluginsdk.Removals) == 0 {
		t.Skip("nothing is marked for removal")
	}
	for _, r := range pluginsdk.Removals {
		row := ""
		for _, line := range strings.Split(ref, "\n") {
			if strings.HasPrefix(line, "| `"+r.Symbol()+"` |") {
				row = line
			}
		}
		if row == "" {
			t.Errorf("no row for %s in removals.md:\n%s", r.Symbol(), ref)
			continue
		}
		for _, want := range append([]string{string(r.Stage), r.Since(), "`" + r.Replacement + "`", r.Hint, "`" + r.Method + "`"}, r.Symbols[1:]...) {
			if !strings.Contains(row, want) {
				t.Errorf("%s's row lacks %q: %s", r.Symbol(), want, row)
			}
		}
	}
	if skill := string(files["code-foundry-plugin/SKILL.md"]); !strings.Contains(skill, "`reference/removals.md`") || !strings.Contains(skill, "code-foundry plugin removals") {
		t.Error("SKILL.md does not point at the removal list")
	}
}
