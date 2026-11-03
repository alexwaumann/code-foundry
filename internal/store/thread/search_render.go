package thread

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	east "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// Rendered text for agent search's quotes (docs/notes/search-5-agent-daemon.md): a hit's
// quote is stored as the words read in the rendered reply, the plain text the GUI's
// locateQuote anchors a citation in (gui/frontend/src/lib/citation.ts; white space aside),
// not as the raw markdown thread read --full prints. renderedText reads a reply as
// gui/frontend/src/lib/markdownText does: the same CommonMark + GFM parse (goldmark here,
// remark there) and the same reading of the tree. testdata/rendered_text.json, written by
// the GUI's markdownText, holds the cases both sides' tests check. Each output rune keeps
// the index of the source rune it came from, so the part of the source a quote matched
// can be read rendered.

// mapped is text with, for each rune, the index of the source rune it came from.
type mapped struct {
	r  []rune
	at []int
}

func (m *mapped) add(r rune, at int) {
	m.r = append(m.r, r)
	m.at = append(m.at, at)
}

func (m mapped) String() string { return string(m.r) }

// identity is s mapped onto itself.
func identity(s []rune) mapped {
	m := mapped{r: s, at: make([]int, len(s))}
	for i := range s {
		m.at[i] = i
	}
	return m
}

// squeeze is m with white space runs as one space and none at the ends (the extractor's
// strings.Fields join).
func squeeze(m mapped) mapped {
	var out mapped
	space := false
	for i, r := range m.r {
		if unicode.IsSpace(r) {
			space = len(out.r) > 0
			continue
		}
		if space {
			out.add(' ', m.at[i-1])
			space = false
		}
		out.add(r, m.at[i])
	}
	return out
}

// formMapped is quoteForm with the map: links as their text, without the markers
// * _ ` # >, white space runs as one space.
func formMapped(m mapped) mapped {
	var out mapped
	for i := 0; i < len(m.r); i++ {
		if m.r[i] == '[' {
			if text, end, ok := linkAt(m.r, i); ok {
				for j := i + 1; j < text; j++ {
					if !strings.ContainsRune("*_`#>", m.r[j]) {
						out.add(m.r[j], m.at[j])
					}
				}
				i = end - 1
				continue
			}
		}
		if !strings.ContainsRune("*_`#>", m.r[i]) {
			out.add(m.r[i], m.at[i])
		}
	}
	return squeeze(out)
}

// linkAt reads [text](target) at r[i] (markdownLink's shape: no ] in the text, no ) in
// the target): the text's end (the ]) and the link's end.
func linkAt(r []rune, i int) (textEnd, end int, ok bool) {
	j := i + 1
	for j < len(r) && r[j] != ']' {
		j++
	}
	if j+1 >= len(r) || r[j+1] != '(' {
		return 0, 0, false
	}
	k := j + 2
	for k < len(r) && r[k] != ')' {
		k++
	}
	if k >= len(r) {
		return 0, 0, false
	}
	return j, k + 1, true
}

// indexRunes is the first index of needle in hay, -1 when none.
func indexRunes(hay, needle []rune) int {
	if len(needle) == 0 {
		return -1
	}
outer:
	for i := 0; i+len(needle) <= len(hay); i++ {
		for j := range needle {
			if hay[i+j] != needle[j] {
				continue outer
			}
		}
		return i
	}
	return -1
}

// quoteSpan is where quote q (cleanQuote'd) is in src, the item's text as the extractor
// gives it (line breaks kept), as source rune indices [from, to): (markdown, a reply) in
// the rendered text first, else as it is (white space aside), else in quoteForm on both
// sides. ok is false when it is in none.
func quoteSpan(src []rune, q string, markdown bool) (from, to int, ok bool) {
	flat := squeeze(identity(src))
	var tries []func() (mapped, []rune)
	if markdown {
		tries = append(tries, func() (mapped, []rune) { return squeeze(renderedText(src)), []rune(q) })
	}
	tries = append(tries,
		func() (mapped, []rune) { return flat, []rune(q) },
		func() (mapped, []rune) { return formMapped(flat), []rune(quoteForm(q)) },
	)
	for _, try := range tries {
		m, want := try()
		if k := indexRunes(m.r, want); k >= 0 {
			return m.at[k], m.at[k+len(want)-1] + 1, true
		}
	}
	return 0, 0, false
}

// renderedQuote is the part [from, to) of src as it reads: rendered markdown for a reply
// (markdown), the text itself otherwise, white space runs as one space.
func renderedQuote(src []rune, from, to int, markdown bool) string {
	m := identity(src)
	if markdown {
		m = renderedText(src)
	}
	var b strings.Builder
	for i, r := range m.r {
		if at := m.at[i]; at >= from && at < to {
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// replyMarkdown parses a reply as the GUI's renderer does (gui/frontend/src/lib/markdownPlugins:
// CommonMark and GFM with remark-gfm's tables, strikethrough, literal autolinks and
// footnotes). Task boxes are read by renderedText itself: goldmark's take a box with no
// space after it, remark's do not.
var replyMarkdown = goldmark.New(goldmark.WithExtensions(extension.Table, extension.Strikethrough, extension.Linkify, extension.Footnote))

// renderedText is src (a reply's markdown) as its rendered plain text reads, mapped: the
// text gui/frontend/src/lib/markdownText gives (white space runs aside;
// testdata/rendered_text.json holds both sides' reading). Text as the thread draws it:
// escapes and entities decoded; code and fenced blocks as they are; links as their text,
// but a relative link that reads as a path as the path (a path chip); images, task boxes
// and rules as nothing; HTML as text, except a bare matched pair of a few inline tags
// (htmlElements), which renders as its contents, and br; footnote references as their
// numbers, the footnotes at the end under "Footnotes", each with a ↩. A new block starts
// on a new line.
func renderedText(src []rune) mapped {
	s := string(src)
	b := []byte(s)
	w := &walker{src: b, runeAt: make([]int, len(b)+1), skipFrom: -1}
	k := 0
	for i := range s {
		for j := i; j < len(b) && (j == i || !utf8.RuneStart(b[j])); j++ {
			w.runeAt[j] = k
		}
		k++
	}
	w.runeAt[len(b)] = k
	w.block(replyMarkdown.Parser().Parse(text.NewReader(b)))
	return w.out
}

// walker reads a parsed reply into its rendered text. Positions are byte offsets into
// src until emit maps them to runes.
type walker struct {
	src    []byte
	runeAt []int // byte offset -> rune index
	out    mapped
	// newline: a block starts, so the next rune goes on a new line.
	newline bool
	// at: the source just read, the place of what has no source of its own.
	at int
	// skipFrom, skipTo: a task box's source, left out.
	skipFrom, skipTo int
}

// emit adds rune r from source byte at.
func (w *walker) emit(r rune, at int) {
	if at >= w.skipFrom && at < w.skipTo {
		return
	}
	at = min(max(at, 0), len(w.src))
	if w.newline {
		if len(w.out.r) > 0 {
			w.out.add('\n', w.runeAt[at])
		}
		w.newline = false
	}
	w.out.add(r, w.runeAt[at])
}

// raw adds src[from:to] as it is.
func (w *walker) raw(from, to int) {
	for i, r := range string(w.src[from:to]) {
		w.emit(r, from+i)
	}
	w.at = max(w.at, to)
}

// text adds src[from:to] with backslash escapes and entity references decoded.
func (w *walker) text(from, to int) {
	s := w.src[from:to]
	for i := 0; i < len(s); {
		if s[i] == '\\' && i+1 < len(s) && isASCIIPunct(rune(s[i+1])) {
			w.emit(rune(s[i+1]), from+i+1)
			i += 2
			continue
		}
		if s[i] == '&' {
			if n, val := entityAt(s[i:]); n > 0 {
				for _, r := range val {
					w.emit(r, from+i)
				}
				i += n
				continue
			}
		}
		r, size := utf8.DecodeRune(s[i:])
		w.emit(r, from+i)
		i += size
	}
	w.at = max(w.at, to)
}

// synth adds s, text the renderer adds (a footnote's number), at the source just read.
func (w *walker) synth(s string) {
	for _, r := range s {
		w.emit(r, w.at)
	}
}

func (w *walker) lines(n ast.Node) {
	l := n.Lines()
	for i := 0; i < l.Len(); i++ {
		seg := l.At(i)
		w.raw(seg.Start, seg.Stop)
	}
}

func (w *walker) children(n ast.Node) {
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		w.block(c)
	}
}

// block reads a block node.
func (w *walker) block(n ast.Node) {
	switch n := n.(type) {
	case *ast.Paragraph, *ast.TextBlock, *ast.Heading, *east.TableCell:
		w.newline = true
		w.inlines(n)
	case *ast.CodeBlock, *ast.FencedCodeBlock:
		w.newline = true
		w.lines(n)
	case *ast.HTMLBlock:
		w.newline = true
		w.lines(n)
		if n.HasClosure() {
			w.raw(n.ClosureLine.Start, n.ClosureLine.Stop)
		}
	case *ast.ThematicBreak:
	case *ast.ListItem:
		w.taskBox(n)
		w.children(n)
	case *east.FootnoteList:
		w.newline = true
		w.synth("Footnotes")
		w.children(n)
	default:
		w.children(n)
	}
}

// taskBoxLine is a GFM task box starting a list item's first paragraph: [ ], [x] or [X],
// then white space and more on the line.
var taskBoxLine = regexp.MustCompile(`^\[[ xX]\][ \t]+[^ \t\r\n]`)

// taskBox leaves out item's task box, if it has one.
func (w *walker) taskBox(item *ast.ListItem) {
	first := item.FirstChild()
	if first == nil || first.Kind() != ast.KindParagraph && first.Kind() != ast.KindTextBlock || first.Lines().Len() == 0 {
		return
	}
	at := first.Lines().At(0).Start
	if taskBoxLine.Match(w.src[at:]) {
		w.skipFrom, w.skipTo = at, at+3
	}
}

// inlines reads an inline container's children.
func (w *walker) inlines(parent ast.Node) {
	elements := htmlElements(parent, w.src)
	for c := parent.FirstChild(); c != nil; c = c.NextSibling() {
		w.inline(c, elements)
	}
}

// inline reads an inline node; elements are its parent's raw HTML tags that render as
// elements (no text).
func (w *walker) inline(n ast.Node, elements map[ast.Node]bool) {
	switch n := n.(type) {
	case *ast.Text:
		w.text(n.Segment.Start, n.Segment.Stop)
		if n.SoftLineBreak() || n.HardLineBreak() {
			w.emit('\n', n.Segment.Stop)
		}
	case *ast.String:
		w.synth(string(n.Value))
	case *ast.CodeSpan:
		w.codeSpan(n)
	case *ast.Image:
		// Nothing: a loaded image has no text, an unloaded one's chip is not read.
		w.skipNode(n)
	case *ast.Link:
		w.link(n)
	case *ast.AutoLink:
		label := n.Label(w.src)
		if i := bytes.Index(w.src[w.at:], label); i >= 0 {
			w.raw(w.at+i, w.at+i+len(label))
		} else {
			w.synth(string(label))
		}
	case *ast.RawHTML:
		for i := 0; i < n.Segments.Len(); i++ {
			seg := n.Segments.At(i)
			if elements[n] {
				w.at = max(w.at, seg.Stop)
			} else {
				w.raw(seg.Start, seg.Stop)
			}
		}
	case *east.FootnoteLink:
		w.synth(strconv.Itoa(n.Index))
	case *east.FootnoteBacklink:
		// After the paragraph's last rune, so a quote ending there leaves it out.
		w.at++
		w.synth(" ↩")
		if n.RefIndex > 0 {
			w.synth(strconv.Itoa(n.RefIndex + 1))
		}
	default:
		w.inlines(n)
	}
}

// skipNode moves past n's source, reading nothing.
func (w *walker) skipNode(n ast.Node) {
	_ = ast.Walk(n, func(c ast.Node, entering bool) (ast.WalkStatus, error) {
		if t, ok := c.(*ast.Text); ok && entering {
			w.at = max(w.at, t.Segment.Stop)
		}
		return ast.WalkContinue, nil
	})
}

// codeSpan reads an inline code span as it is (line endings as spaces); one that reads
// as a path is the chip's trimmed path.
func (w *walker) codeSpan(n *ast.CodeSpan) {
	var m mapped
	for c := n.FirstChild(); c != nil; c = c.NextSibling() {
		t, ok := c.(*ast.Text)
		if !ok {
			continue
		}
		for i, r := range string(t.Segment.Value(w.src)) {
			if r == '\n' {
				r = ' '
			}
			m.add(r, t.Segment.Start+i)
		}
		w.at = max(w.at, t.Segment.Stop)
	}
	from, to := 0, len(m.r)
	if trimmed := strings.TrimSpace(string(m.r)); trimmed != "" {
		if _, ok := matchPath(trimmed); ok {
			for from < to && unicode.IsSpace(m.r[from]) {
				from++
			}
			for to > from && unicode.IsSpace(m.r[to-1]) {
				to--
			}
		}
	}
	for i := from; i < to; i++ {
		w.emit(m.r[i], m.at[i])
	}
}

// link reads a link as its text, or, when its target is relative and reads as a path
// (linkPath), as the path chip's text, placed on the link text's last rune: a quote that
// takes in the link's text, as written or as shown, takes in the whole chip.
func (w *walker) link(n *ast.Link) {
	path, ok := linkPath(unescape(n.Destination))
	if !ok {
		w.inlines(n)
		return
	}
	before := w.at
	w.skipNode(n)
	at := w.at
	if at > before {
		at-- // the text's last byte
	}
	for _, r := range path {
		w.emit(r, at)
	}
	// An inline link's target follows its text ("](" then the target): read past it.
	if i := bytes.Index(w.src[w.at:], n.Destination); i >= 0 && i <= 8 {
		w.at += i + len(n.Destination)
	}
}

// unescape is b with backslash escapes and entity references decoded (a link target as
// the GUI's URL reads before it is percent-decoded).
func unescape(b []byte) string {
	var out strings.Builder
	for i := 0; i < len(b); {
		if b[i] == '\\' && i+1 < len(b) && isASCIIPunct(rune(b[i+1])) {
			out.WriteByte(b[i+1])
			i += 2
			continue
		}
		if b[i] == '&' {
			if n, val := entityAt(b[i:]); n > 0 {
				out.WriteString(val)
				i += n
				continue
			}
		}
		out.WriteByte(b[i])
		i++
	}
	return out.String()
}

// inlineTagRE is a raw HTML node that is exactly one tag without attributes
// (gui/frontend/src/lib/inlineHtml inlineTag).
var inlineTagRE = regexp.MustCompile(`^<(/?)([a-zA-Z]+)\s*(/?)>$`)

// pairedTags render in a thread's answer as a matched pair (inlineHtml INLINE_HTML_TAGS
// but br, which renders alone).
var pairedTags = map[string]bool{"small": true, "mark": true, "sub": true, "sup": true, "kbd": true, "ins": true, "s": true, "del": true, "u": true}

// htmlElements is which of parent's raw HTML children render as elements (no text):
// matched pairs of pairedTags among its children and br, as inlineHtml buildInline makes
// them. Every other raw node renders as its text.
func htmlElements(parent ast.Node, src []byte) map[ast.Node]bool {
	var out map[ast.Node]bool
	type open struct {
		name string
		node ast.Node
	}
	var stack []open
	for c := parent.FirstChild(); c != nil; c = c.NextSibling() {
		h, ok := c.(*ast.RawHTML)
		if !ok {
			continue
		}
		var raw []byte
		for i := 0; i < h.Segments.Len(); i++ {
			seg := h.Segments.At(i)
			raw = append(raw, seg.Value(src)...)
		}
		m := inlineTagRE.FindSubmatch(raw)
		if m == nil {
			continue
		}
		closing, name, self := len(m[1]) > 0, strings.ToLower(string(m[2])), len(m[3]) > 0
		if out == nil {
			out = map[ast.Node]bool{}
		}
		switch {
		case name == "br":
			if !closing {
				out[c] = true
			}
		case !pairedTags[name] || self:
		case !closing:
			stack = append(stack, open{name, c})
		default:
			i := len(stack) - 1
			for i >= 0 && stack[i].name != name {
				i--
			}
			if i < 0 {
				continue
			}
			// Tags opened inside the pair and never closed stay text.
			out[stack[i].node], out[c] = true, true
			stack = stack[:i]
		}
	}
	return out
}

// entityRef is an HTML entity or numeric character reference.
var entityRef = regexp.MustCompile(`^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));`)

// entityAt decodes the entity reference b starts with: its length and text; 0 when none.
func entityAt(b []byte) (int, string) {
	m := entityRef.FindSubmatch(b)
	if m == nil {
		return 0, ""
	}
	switch {
	case m[1] != nil, m[2] != nil:
		base, digits := 16, m[1]
		if m[2] != nil {
			base, digits = 10, m[2]
		}
		v, err := strconv.ParseInt(string(digits), base, 32)
		if err != nil || v > unicode.MaxRune {
			v = utf8.RuneError
		}
		return len(m[0]), string(util.ToValidRune(rune(v)))
	default:
		e, ok := util.LookUpHTML5EntityByName(string(m[3]))
		if !ok {
			return 0, ""
		}
		return len(m[0]), string(e.Characters)
	}
}

func isASCIIPunct(r rune) bool {
	return r < 128 && (unicode.IsPunct(r) || unicode.IsSymbol(r))
}
