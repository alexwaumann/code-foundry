package skills

import (
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bridge"
)

// Pages is the skill for HTML pages that call Code Foundry through /cf/bridge.js
// (docs/notes/bridge-3-skill.md). Its SKILL.md is static; the API block and the error
// codes are filled in from internal/bridge, so they match the script the daemon serves
// (the tests check it names every event source).
const Pages = "code-foundry-pages"

// bridgeAPI is the API list of bridge.js's header comment, verbatim: from "gives the page
// window.cf:" to the blank line after it, without the comment marks.
func bridgeAPI() string {
	src := string(bridge.Script())
	head, _, ok := strings.Cut(src, "*/")
	if !ok {
		return ""
	}
	var out []string
	in := false
	for _, line := range strings.Split(head, "\n") {
		text := strings.TrimPrefix(strings.TrimPrefix(line, " *"), " ")
		switch {
		case strings.HasPrefix(text, "gives the page window.cf"):
			in = true
		case in && strings.TrimSpace(text) == "":
			return strings.Join(out, "\n")
		case in:
			out = append(out, strings.TrimLeft(text, " "))
		}
	}
	return strings.Join(out, "\n")
}
