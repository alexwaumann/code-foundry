package command

import (
	"regexp"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/pagelib"
)

// The unknown-class check of view.inline's page warnings (docs/notes/pages-skill-trial.md):
// /cf/ui.css is a fixed set of utilities, not all of Tailwind, so a page that links it and
// uses a class it lacks (line-through) gets nothing, silently. The set is the stylesheet the
// daemon serves (pagelib.UIClass), so the check cannot drift from it.

// WarnUnknownClass takes the classes, joined.
const WarnUnknownClass = "page uses classes /cf/ui.css does not have, so they do nothing: %s. /cf/ui.css is a fixed set, " +
	"not all of Tailwind: layout, spacing, sizes on the 4px scale, the type roles, rounded-*, the cf colours " +
	"(bg-, text-, border- and hover:bg-cf-surface-raised, text-cf-text-muted, bg-cf-error-surface…); use one of those, " +
	`a style attribute or a rule in the page's own <style>, or add <script src="/cf/tailwind.js"></script> for any utility`

// unknownClassMax is how many unknown classes the warning names.
const unknownClassMax = 8

func init() {
	pageListChecks = append(pageListChecks, pageListCheck{WarnUnknownClass, unknownClasses})
}

var (
	// quotedClass is a class or className attribute's quoted value (HTML, JSX, or a
	// className = "…" in script); exprClass the { opening a JSX className={…} expression.
	quotedClass = regexp.MustCompile(`\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)')`)
	exprClass   = regexp.MustCompile(`\bclass(?:Name)?\s*=\s*\{`)
	// hookClass is a class a script looks up by name rather than by selector: the page's own.
	hookClass = regexp.MustCompile(`(?:getElementsByClassName|classList\.contains)\(\s*["']([^"']+)["']`)
	// classToken is what a class name looks like; anything else in a class string (an
	// interpolation, an operator) is not one.
	classToken = regexp.MustCompile(`^-?[A-Za-z_][A-Za-z0-9_:/.%@-]*!?$`)
	// classCall names a call whose string arguments are class names (cn("a", x && "b")).
	classCall = map[string]bool{"cn": true, "clsx": true, "cx": true, "classNames": true, "classnames": true, "twMerge": true, "twJoin": true}
)

// UnknownClasses is unknownClasses of a page's text: the skill's own pages are tested with it
// (internal/skills).
func UnknownClasses(text string) []string { return unknownClasses(page{text: text}) }

// unknownClasses returns the classes a page uses that /cf/ui.css lacks and the page does
// not define itself, in the order they first appear, at most unknownClassMax (the last
// "…" when there are more). Nothing for a page that does not link /cf/ui.css (a plain page or
// a mockup paints itself) or that loads /cf/tailwind.js (it makes any utility). An
// arbitrary value (min-h-[420px]) is WarnArbitraryClass's.
func unknownClasses(p page) []string {
	if !strings.Contains(p.text, pagelib.UICSSPath) || strings.Contains(p.text, pagelib.TailwindPath) {
		return nil
	}
	// The page's own: every .name in it (its <style>, a querySelector(".row")), and the
	// classes a script looks up by name.
	own := pagelib.CSSClasses(p.text)
	for _, m := range hookClass.FindAllStringSubmatch(p.text, -1) {
		for _, c := range strings.Fields(m[1]) {
			own[c] = true
		}
	}
	var out []string
	for _, c := range pageClasses(p.text) {
		if strings.ContainsAny(c, "[]") || own[c] || pagelib.UIClass(c) || slices.Contains(out, c) {
			continue
		}
		if len(out) == unknownClassMax {
			return append(out, "…")
		}
		out = append(out, c)
	}
	return out
}

// pageClasses returns the class names text uses, in order: quoted class attributes, and the
// class strings of className={…} expressions.
func pageClasses(text string) []string {
	type at struct {
		i    int
		text string
	}
	var found []at
	for _, m := range quotedClass.FindAllStringSubmatchIndex(text, -1) {
		v := m[2:4]
		if v[0] < 0 {
			v = m[4:6]
		}
		// In a script's template (`<b class="row ${cls}">`), the ${…} parts are not classes.
		found = append(found, at{m[0], strings.Join(templateText(text[v[0]:v[1]]), " ")})
	}
	for _, m := range exprClass.FindAllStringIndex(text, -1) {
		open := m[1] - 1
		end := closeOf(text, open)
		if end < 0 {
			continue
		}
		for _, s := range classStrings(text[open+1 : end]) {
			found = append(found, at{m[0], s})
		}
	}
	slices.SortStableFunc(found, func(a, b at) int { return a.i - b.i })
	var out []string
	for _, f := range found {
		for _, c := range strings.Fields(f.text) {
			if classToken.MatchString(c) {
				out = append(out, c)
			}
		}
	}
	return out
}

// classStrings returns the string literals of a className expression that are class names:
// a literal on its own or a branch of a ternary or &&, an argument of cn or clsx, a
// template's text. Not one compared against (x === "done"), indexed with (tones["ok"]) or
// passed to any other call (fmt("a")): those are values, not classes.
func classStrings(expr string) []string {
	var out []string
	// stack holds, per open bracket, whether strings directly inside it are classes.
	stack := []bool{true}
	for i := 0; i < len(expr); {
		c := expr[i]
		switch c {
		case '(':
			// A grouping keeps its context; a call's arguments are classes only for cn and the like.
			name := identBefore(expr, i)
			stack = append(stack, name == "" && stack[len(stack)-1] || classCall[name])
			i++
			continue
		case '[':
			stack = append(stack, false)
			i++
			continue
		case '{':
			stack = append(stack, stack[len(stack)-1])
			i++
			continue
		case ')', ']', '}':
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
			}
			i++
			continue
		case '"', '\'', '`':
			end := skipJS(expr, i)
			lit := expr[i+1 : max(i+1, end-1)]
			if stack[len(stack)-1] && !compared(expr, i, end) {
				if c == '`' {
					out = append(out, templateText(lit)...)
				} else {
					out = append(out, lit)
				}
			}
			if c == '`' {
				// A template's ${…} holds expressions of its own (${done ? "line-through" : ""}).
				for _, e := range templateExprs(lit) {
					out = append(out, classStrings(e)...)
				}
			}
			i = end
			continue
		}
		if j := skipJS(expr, i); j != i {
			i = j
			continue
		}
		i++
	}
	return out
}

// compared reports whether the literal at expr[start:end] is an operand of a comparison
// (=== "done", "done" !==), so a value rather than a class.
func compared(expr string, start, end int) bool {
	before := strings.TrimRight(expr[:start], " \t\n")
	after := strings.TrimLeft(expr[end:], " \t\n")
	return strings.HasSuffix(before, "==") || strings.HasSuffix(before, "!=") ||
		strings.HasPrefix(after, "==") || strings.HasPrefix(after, "!=")
}

// templateText is a template literal's text outside its ${…} parts.
func templateText(lit string) []string {
	var out []string
	for {
		i := strings.Index(lit, "${")
		if i < 0 {
			return append(out, lit)
		}
		out = append(out, lit[:i])
		end := closeOf(lit, i+1)
		if end < 0 {
			return out
		}
		lit = lit[end+1:]
	}
}

// templateExprs are a template literal's ${…} expressions.
func templateExprs(lit string) []string {
	var out []string
	for {
		i := strings.Index(lit, "${")
		if i < 0 {
			return out
		}
		end := closeOf(lit, i+1)
		if end < 0 {
			return out
		}
		out = append(out, lit[i+2:end])
		lit = lit[end+1:]
	}
}
