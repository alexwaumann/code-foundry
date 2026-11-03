package thread

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Path chips as the GUI reads them (gui/frontend/src/lib/pathChips.ts), for renderedText:
// a relative link whose target reads as a path shows the path, and an inline code span
// that reads as one shows it trimmed. Only the code strictness is here: a prose path's chip
// shows the word as it is, so it does not change the text. The lists are pathChips.ts's
// (TestPathChipListsMatchTheGUI reads them from there).

var pathExtensions = setOf(
	// code
	"ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "py", "pyi", "rb", "rs", "java", "kt", "kts", "scala", "swift",
	"c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "lua", "pl", "php", "dart", "ex", "exs", "erl", "hs", "ml", "clj",
	"elm", "zig", "nim", "sh", "bash", "zsh", "fish", "ps1", "sql", "proto", "graphql", "gql", "vue", "svelte", "astro", "wasm",
	"ipynb", "tmpl", "gotmpl", "tf", "hcl", "nix", "gradle", "mk", "cmake",
	// web and config
	"html", "htm", "css", "scss", "sass", "less", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
	"xml", "plist", "lock", "mod", "sum", "csv", "tsv", "patch", "diff",
	// prose
	"md", "mdx", "markdown", "txt", "rst", "adoc",
	// media and archives
	"png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "icns", "pdf", "zip", "gz", "tgz", "tar", "dmg",
)

// pathNames are file names without a (known) extension that are files all the same.
var pathNames = setOf(
	"Makefile", "makefile", "Dockerfile", "Justfile", "Gemfile", "Rakefile", "Procfile", "Brewfile", "LICENSE", "CODEOWNERS",
	".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".env", ".envrc", ".zshrc", ".bashrc",
	".profile", ".prettierrc", ".eslintrc",
)

// refHeads start a one-slash token that is a git ref, not a folder.
var refHeads = setOf("origin", "upstream", "refs", "heads", "remotes", "tags", "cf", "feat", "fix", "chore")

// mimeHeads are MIME top-level types.
var mimeHeads = setOf("application", "text", "image", "audio", "video", "font", "multipart", "message")

func setOf(s ...string) map[string]bool {
	m := make(map[string]bool, len(s))
	for _, v := range s {
		m[v] = true
	}
	return m
}

var (
	pathSuffix   = regexp.MustCompile(`:(\d+)(?:[:-](\d+))?$`)
	pathChars    = regexp.MustCompile(`^[\p{L}\p{N}_.\-+@~/%]+$`)
	spacedChars  = regexp.MustCompile(`^[\p{L}\p{N}_.\-+@~/%() \x{00a0}\x{202f}]+$`)
	pathSpace    = regexp.MustCompile(`[ \x{00a0}\x{202f}]`)
	pathSpaces2  = regexp.MustCompile(`[ \x{00a0}\x{202f}]{2}`)
	pathLetter   = regexp.MustCompile(`\p{L}`)
	pathDomain   = regexp.MustCompile(`(?i)^[a-z0-9-]+(\.[a-z0-9-]+)+$`)
	jsName       = regexp.MustCompile(`^[A-Z][^.]*\.js$`)
	dotsSegment  = regexp.MustCompile(`^\.{3,}$`)
	spacedHead   = regexp.MustCompile(`^(/|~/|\.\.?/)`)
	spacedWord   = regexp.MustCompile(`^[-/~$@]`)
	urlScheme    = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.\-]*:`)
	lineAnchor   = regexp.MustCompile(`^L(\d+)(?:-L?\d+)?$`)
	queryPattern = regexp.MustCompile(`\?.*$`)
)

func hasKnownExtension(name string) bool {
	if pathNames[name] {
		return true
	}
	i := strings.LastIndex(name, ".")
	if i <= 0 || i == len(name)-1 {
		return false
	}
	return pathExtensions[strings.ToLower(name[i+1:])]
}

func balancedParens(s string) bool {
	open := false
	for _, c := range s {
		switch c {
		case '(':
			if open {
				return false
			}
			open = true
		case ')':
			if !open {
				return false
			}
			open = false
		}
	}
	return !open
}

func afterSlash(s string) string { return s[strings.LastIndex(s, "/")+1:] }

// spacedPathOk is pathChips.ts spacedPathOk.
func spacedPathOk(path string) bool {
	if !spacedChars.MatchString(path) || !balancedParens(path) {
		return false
	}
	first, _ := utf8.DecodeRuneInString(path)
	last, _ := utf8.DecodeLastRuneInString(path)
	if pathSpace.MatchString(string(first)) || pathSpace.MatchString(string(last)) || pathSpaces2.MatchString(path) {
		return false
	}
	words := pathSpace.Split(path, -1)
	for _, w := range words[1:] {
		if spacedWord.MatchString(w) {
			return false
		}
	}
	for _, w := range words[:len(words)-1] {
		if hasKnownExtension(afterSlash(w)) {
			return false
		}
	}
	if strings.HasSuffix(path, "/") || !hasKnownExtension(afterSlash(path)) {
		return false
	}
	if spacedHead.MatchString(path) {
		return true
	}
	slash := strings.Index(path, "/")
	return slash > 0 && !pathSpace.MatchString(path[:slash])
}

// matchPath is pathChips.ts matchPath(token, "code"): whether token reads as a path (with
// an optional :line, :line:col or :line-line), the chip's text then being token.
func matchPath(token string) (string, bool) {
	if !isCodePath(token) {
		return "", false
	}
	return token, true
}

func isCodePath(token string) bool {
	if n := len(utf16.Encode([]rune(token))); n < 2 || n > 400 {
		return false
	}
	path := token
	if m := pathSuffix.FindStringSubmatchIndex(path); m != nil {
		line, err := strconv.ParseInt(path[m[2]:m[3]], 10, 64)
		if err != nil || line <= 0 || line > 1<<53-1 {
			return false
		}
		path = path[:m[0]]
	}
	if pathSpace.MatchString(path) {
		if !spacedPathOk(path) {
			return false
		}
	} else if !pathChars.MatchString(path) {
		return false
	}
	if !pathLetter.MatchString(path) || strings.Contains(path, "://") || strings.ContainsAny(path[:1], "-@$") {
		return false
	}
	if path == "~" || path == "." || path == ".." || strings.Trim(path, "/") == "" {
		return false
	}
	dir := strings.HasSuffix(path, "/")
	var segments []string
	for _, s := range strings.Split(path, "/") {
		if s != "" {
			segments = append(segments, s)
		}
	}
	if len(segments) == 0 {
		return false
	}
	for _, s := range segments {
		if dotsSegment.MatchString(s) || s != ".." && strings.Contains(s, "..") {
			return false
		}
	}
	name := segments[len(segments)-1]
	known := !dir && hasKnownExtension(name)
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, "./") || strings.HasPrefix(path, "../") {
		return len(segments) > 1
	}
	if strings.HasPrefix(path, "/") {
		return len(segments) >= 2 || known
	}
	head := segments[0]
	if len(segments) > 1 && strings.Contains(head, ".") && pathDomain.MatchString(head) && !hasKnownExtension(head) {
		return false
	}
	if !strings.Contains(path, "/") {
		return known && !jsName.MatchString(name)
	}
	if known || dir {
		return true
	}
	if len(segments) == 2 && (refHeads[head] || mimeHeads[head]) {
		return false
	}
	return true
}

// linkPath is pathChips.ts linkPath: the path chip's text for a markdown link's target,
// when it is relative and reads as a path (a #L12 or #L12-L30 anchor as its line).
func linkPath(href string) (string, bool) {
	if href == "" || strings.HasPrefix(href, "#") || strings.HasPrefix(href, "//") || urlScheme.MatchString(href) {
		return "", false
	}
	path, anchor, _ := strings.Cut(href, "#")
	path, ok := decodeURIComponent(queryPattern.ReplaceAllString(path, ""))
	if !ok {
		return "", false
	}
	if m := lineAnchor.FindStringSubmatch(anchor); m != nil && !pathSuffix.MatchString(path) {
		path += ":" + m[1]
	}
	return matchPath(path)
}

// decodeURIComponent decodes %XX escapes as the GUI's href reads (a % that starts none is
// itself); false when the bytes are not UTF-8, where the GUI's decode throws.
func decodeURIComponent(s string) (string, bool) {
	if !strings.Contains(s, "%") {
		return s, true
	}
	var b []byte
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			v, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			b = append(b, byte(v))
			i += 2
			continue
		}
		b = append(b, s[i])
	}
	return string(b), utf8.Valid(b)
}

func isHex(c byte) bool {
	return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}
