package skills_test

import (
	"regexp"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/skills"
)

// htmlBlock is a fenced html block of a skill file.
var htmlBlock = regexp.MustCompile("(?s)```html\n(.*?)```")

// The skill's own pages use only classes /cf/ui.css has (or define them), as view.inline's
// check asks of a page (docs/notes/pages-skill-trial.md): the welcome page shipped three that
// did nothing (size-7, disabled:opacity-60, group-hover:text-cf-accent).
func TestPagesSkillClassesExist(t *testing.T) {
	files, err := skills.Render(realSources(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range pagesSkillFiles {
		body := string(files[p])
		pages := []string{body}
		if strings.HasSuffix(p, ".md") {
			pages = nil
			for _, m := range htmlBlock.FindAllStringSubmatch(body, -1) {
				pages = append(pages, m[1])
			}
		}
		for i, page := range pages {
			if names := command.UnknownClasses(page); len(names) > 0 {
				t.Errorf("%s (page %d) uses classes /cf/ui.css lacks: %v", p, i, names)
			}
		}
	}
}
