package marketplace

import (
	"slices"
	"strings"
)

// Frontmatter is the part of a SKILL.md's YAML frontmatter the marketplace reads. Every
// field may be missing.
type Frontmatter struct {
	Name        string
	Description string
	// Owner and Author are the top-level keys; MetaOwner and MetaAuthor the metadata
	// map's.
	Owner, Author         string
	MetaOwner, MetaAuthor string
	// MetaVersion is metadata.version (display only: the registry's version of a
	// skill is its last commit's date).
	MetaVersion string
	// Keywords is metadata.keywords, else the top-level keywords: a YAML list (block
	// or flow) or a comma-separated string.
	Keywords []string
}

// By is who the skill is by: owner, else metadata.owner, else metadata.author, else
// author, else "".
func (f Frontmatter) By() string {
	for _, v := range []string{f.Owner, f.MetaOwner, f.MetaAuthor, f.Author} {
		if v != "" {
			return v
		}
	}
	return ""
}

// ParseFrontmatter reads the YAML frontmatter at the top of a SKILL.md: the lines
// between a first line "---" and the next "---". It understands the subset skills use
// (scalars plain or quoted, folded and literal blocks, one nested map, block and flow
// lists), ignores anything else and never fails. Text without frontmatter yields the
// zero value.
func ParseFrontmatter(text string) Frontmatter {
	text = strings.TrimPrefix(text, "\xef\xbb\xbf")
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return Frontmatter{}
	}
	end := slices.IndexFunc(lines[1:], func(l string) bool {
		t := strings.TrimSpace(l)
		return t == "---" || t == "..."
	})
	if end < 0 {
		return Frontmatter{}
	}
	top := parseMap(lines[1:end+1], 0)
	f := Frontmatter{
		Name:        top.scalars["name"],
		Description: top.scalars["description"],
		Owner:       top.scalars["owner"],
		Author:      top.scalars["author"],
		Keywords:    top.list("keywords"),
	}
	if meta := top.maps["metadata"]; meta != nil {
		f.MetaOwner = meta.scalars["owner"]
		f.MetaAuthor = meta.scalars["author"]
		f.MetaVersion = meta.scalars["version"]
		if kw := meta.list("keywords"); len(kw) > 0 {
			f.Keywords = kw
		}
	}
	return f
}

// yamlMap is one level of a parsed YAML mapping.
type yamlMap struct {
	scalars map[string]string
	lists   map[string][]string
	maps    map[string]*yamlMap
}

// list is key's list, or its scalar split on commas.
func (m *yamlMap) list(key string) []string {
	if l, ok := m.lists[key]; ok {
		return l
	}
	return splitList(m.scalars[key])
}

// parseMap reads the "key: value" lines indented exactly indent, each with its nested
// lines (the ones below it indented further, and a block list's "- " lines at the same
// indent).
func parseMap(lines []string, indent int) *yamlMap {
	m := &yamlMap{scalars: map[string]string{}, lists: map[string][]string{}, maps: map[string]*yamlMap{}}
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if blank(l) || indentOf(l) != indent {
			continue
		}
		key, val, ok := strings.Cut(strings.TrimSpace(l), ":")
		if !ok || strings.HasPrefix(key, "-") {
			continue
		}
		key = unquote(strings.TrimSpace(key))
		val = stripComment(strings.TrimSpace(val))
		j := i + 1
		for j < len(lines) && (blank(lines[j]) || indentOf(lines[j]) > indent ||
			(indentOf(lines[j]) == indent && strings.HasPrefix(strings.TrimSpace(lines[j]), "-"))) {
			j++
		}
		nested := lines[i+1 : j]
		i = j - 1
		switch {
		case val == "" && len(nested) > 0:
			first := strings.TrimSpace(firstNonBlank(nested))
			switch {
			case strings.HasPrefix(first, "-"):
				m.lists[key] = blockList(nested)
			case isKeyLine(first):
				m.maps[key] = parseMap(nested, indentOf(firstNonBlank(nested)))
			default:
				m.scalars[key] = joinFolded(nested)
			}
		case strings.HasPrefix(val, "|"):
			m.scalars[key] = joinLiteral(nested)
		case strings.HasPrefix(val, ">"):
			m.scalars[key] = joinFolded(nested)
		case strings.HasPrefix(val, "[") && strings.HasSuffix(val, "]"):
			m.lists[key] = splitList(val[1 : len(val)-1])
		default:
			v := unquote(val)
			// A plain scalar may continue on more-indented lines.
			if !strings.HasPrefix(val, `"`) && !strings.HasPrefix(val, "'") {
				if rest := joinFolded(nested); rest != "" {
					v += " " + rest
				}
			}
			m.scalars[key] = v
		}
	}
	return m
}

// isKeyLine reports whether t (trimmed) looks like "key: value" or "key:".
func isKeyLine(t string) bool {
	key, _, ok := strings.Cut(t, ":")
	return ok && key != "" && !strings.ContainsAny(key, " \"'")
}

func blockList(lines []string) []string {
	var out []string
	for _, l := range lines {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "-"); ok {
			if v = unquote(stripComment(strings.TrimSpace(v))); v != "" {
				out = append(out, v)
			}
		}
	}
	return out
}

// splitList splits "a, b, c" (a flow list's inside, or a comma-separated string).
func splitList(s string) []string {
	var out []string
	for p := range strings.SplitSeq(s, ",") {
		if p = unquote(strings.TrimSpace(p)); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func joinFolded(lines []string) string {
	var parts []string
	for _, l := range lines {
		if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, " ")
}

func joinLiteral(lines []string) string {
	parts := make([]string, 0, len(lines))
	for _, l := range lines {
		parts = append(parts, strings.TrimSpace(l))
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func unquote(s string) string {
	if len(s) < 2 {
		return s
	}
	switch {
	case s[0] == '"' && s[len(s)-1] == '"':
		return strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\n`, "\n", `\t`, "\t").Replace(s[1 : len(s)-1])
	case s[0] == '\'' && s[len(s)-1] == '\'':
		return strings.ReplaceAll(s[1:len(s)-1], "''", "'")
	}
	return s
}

// stripComment drops a trailing " # comment" from an unquoted value.
func stripComment(s string) string {
	if strings.HasPrefix(s, `"`) || strings.HasPrefix(s, "'") {
		return s
	}
	if i := strings.Index(s, " #"); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func blank(l string) bool {
	t := strings.TrimSpace(l)
	return t == "" || strings.HasPrefix(t, "#")
}

func indentOf(l string) int { return len(l) - len(strings.TrimLeft(l, " \t")) }

func firstNonBlank(lines []string) string {
	for _, l := range lines {
		if !blank(l) {
			return l
		}
	}
	return ""
}
