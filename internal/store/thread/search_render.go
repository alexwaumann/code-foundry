package thread

import (
	"regexp"
	"strings"
	"unicode"
)

// Rendered text for agent search's quotes (docs/notes/search-5-agent-daemon.md): a hit's
// quote is stored as the words read in the rendered reply, the plain text the GUI's
// locateQuote anchors a citation in (gui/frontend/src/lib/citation.ts; white space aside),
// not as the raw markdown thread read --full prints. renderedText is a small CommonMark +
// GFM reading of a reply, enough for the constructs Claude writes: fences, headings,
// quotes, lists, task boxes, tables, rules, code spans, links, autolinks, escapes and
// emphasis. Each output rune keeps the index of the source rune it came from, so the part
// of the source a quote matched can be read rendered.

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
// gives it (line breaks kept), as source rune indices [from, to): found as it is (white
// space aside), else in quoteForm on both sides, else (markdown, a reply) in the rendered
// text. ok is false when it is in none.
func quoteSpan(src []rune, q string, markdown bool) (from, to int, ok bool) {
	flat := squeeze(identity(src))
	tries := []func() (mapped, []rune){
		func() (mapped, []rune) { return flat, []rune(q) },
		func() (mapped, []rune) { return formMapped(flat), []rune(quoteForm(q)) },
	}
	if markdown {
		tries = append(tries, func() (mapped, []rune) { return squeeze(renderedText(src)), []rune(q) })
	}
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

var (
	fenceLine     = regexp.MustCompile("^ {0,3}(```+|~~~+)")
	ruleLine      = regexp.MustCompile(`^ {0,3}([-*_])( *[-*_]){2,} *$`)
	setextLine    = regexp.MustCompile(`^ {0,3}=+ *$`)
	tableSepLine  = regexp.MustCompile(`^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$`)
	headingPrefix = regexp.MustCompile(`^ {0,3}#{1,6}( +|$)`)
	quotePrefix   = regexp.MustCompile(`^ {0,3}> ?`)
	listPrefix    = regexp.MustCompile(`^ *([-*+]|[0-9]{1,9}[.)]) +(\[[ xX]\] +)?`)
)

// tok is a source rune on its way to the rendered text.
type tok struct {
	r    rune
	at   int
	drop bool // markup: not in the rendered text
	lit  bool // literal: code or escaped, never markup
}

// renderedText is src (markdown) as its rendered plain text reads, mapped.
func renderedText(src []rune) mapped {
	toks := blockPass(src)
	inlinePass(toks)
	emphasisPass(toks)
	var out mapped
	for _, t := range toks {
		if !t.drop {
			out.add(t.r, t.at)
		}
	}
	return out
}

// blockPass drops line markup: fences, rules, setext underlines, table separators and
// pipes, and the heading, quote and list markers starting a line. A fence's lines are
// literal.
func blockPass(src []rune) []tok {
	var toks []tok
	lines := strings.Split(string(src), "\n")
	table := tableLines(lines)
	at := 0
	fence := ""
	for li, line := range lines {
		lr := []rune(line)
		start := at
		at += len(lr) + 1
		emit := func(from int, lit bool) {
			for i := from; i < len(lr); i++ {
				toks = append(toks, tok{r: lr[i], at: start + i, lit: lit})
			}
		}
		if li > 0 {
			toks = append(toks, tok{r: '\n', at: start - 1})
		}
		if m := fenceLine.FindStringSubmatch(line); m != nil {
			switch {
			case fence == "":
				fence = m[1][:1]
				continue
			case strings.HasPrefix(m[1], fence) && strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), fence)) == "":
				fence = ""
				continue
			}
		}
		if fence != "" {
			emit(0, true)
			continue
		}
		if ruleLine.MatchString(line) || table[li] && tableSepLine.MatchString(line) ||
			setextLine.MatchString(line) && li > 0 && strings.TrimSpace(lines[li-1]) != "" {
			continue
		}
		from := 0
		for {
			rest := string(lr[from:])
			loc := quotePrefix.FindStringIndex(rest)
			if loc == nil {
				loc = listPrefix.FindStringIndex(rest)
			}
			if loc == nil {
				loc = headingPrefix.FindStringIndex(rest)
			}
			if loc == nil || loc[1] == 0 {
				break
			}
			from += len([]rune(rest[:loc[1]]))
		}
		if table[li] {
			for i := from; i < len(lr); i++ {
				toks = append(toks, tok{r: lr[i], at: start + i, drop: lr[i] == '|' && (i == 0 || lr[i-1] != '\\')})
			}
			continue
		}
		emit(from, false)
	}
	return toks
}

// tableLines marks a GFM table's lines: a row with a pipe followed by a separator line,
// and the rows after it up to a line without a pipe.
func tableLines(lines []string) []bool {
	out := make([]bool, len(lines))
	for i := 0; i+1 < len(lines); i++ {
		if !strings.Contains(lines[i], "|") || !strings.Contains(lines[i+1], "-") || !tableSepLine.MatchString(lines[i+1]) {
			continue
		}
		out[i], out[i+1] = true, true
		j := i + 2
		for ; j < len(lines) && strings.Contains(lines[j], "|"); j++ {
			out[j] = true
		}
		i = j - 1
	}
	return out
}

// inlinePass drops inline markup but emphasis: escapes, code spans (their text literal),
// links and images (their text kept) and autolinks.
func inlinePass(toks []tok) {
	n := len(toks)
	next := func(i int) int { // the next live token after i
		for i++; i < n && toks[i].drop; i++ {
		}
		return i
	}
	for i := 0; i < n; i = next(i) {
		t := &toks[i]
		if t.lit {
			continue
		}
		switch {
		case t.r == '\\':
			if j := next(i); j < n && !toks[j].lit && (isASCIIPunct(toks[j].r) || toks[j].r == '\n') {
				t.drop = true
				if toks[j].r != '\n' {
					toks[j].lit = true
				}
			}
		case t.r == '`':
			ticks := 1
			for i+ticks < n && toks[i+ticks].r == '`' && !toks[i+ticks].lit {
				ticks++
			}
			if end := closingTicks(toks, i+ticks, ticks); end >= 0 {
				for j := i; j < i+ticks; j++ {
					toks[j].drop = true
				}
				for j := i + ticks; j < end; j++ {
					toks[j].lit = true
				}
				for j := end; j < end+ticks; j++ {
					toks[j].drop = true
				}
				i = end + ticks - 1
				continue
			}
			for j := i; j < i+ticks; j++ {
				toks[j].lit = true
			}
			i += ticks - 1
		case t.r == '[':
			if close, end, ok := linkToks(toks, i); ok {
				t.drop = true
				if i > 0 && toks[i-1].r == '!' && !toks[i-1].lit {
					toks[i-1].drop = true
				}
				for j := close; j < end; j++ {
					toks[j].drop = true
				}
			}
		case t.r == '<':
			if end := autolinkEnd(toks, i); end > 0 {
				t.drop, toks[end].drop = true, true
				for j := i + 1; j < end; j++ {
					toks[j].lit = true
				}
			}
		}
	}
}

// closingTicks is the start of the run of exactly n backticks closing a code span opened
// before from; -1 when none.
func closingTicks(toks []tok, from, n int) int {
	for i := from; i < len(toks); i++ {
		if toks[i].r != '`' || toks[i].lit {
			continue
		}
		j := i
		for j < len(toks) && toks[j].r == '`' {
			j++
		}
		if j-i == n {
			return i
		}
		i = j - 1
	}
	return -1
}

// linkToks reads [text](target) at toks[i], the text's brackets balanced and the target
// on one line: the closing ] and the link's end.
func linkToks(toks []tok, i int) (close, end int, ok bool) {
	depth := 0
	j := i
	for ; j < len(toks); j++ {
		if toks[j].lit {
			continue
		}
		if toks[j].r == '[' {
			depth++
		} else if toks[j].r == ']' {
			if depth--; depth == 0 {
				break
			}
		}
	}
	if j+1 >= len(toks) || toks[j+1].r != '(' {
		return 0, 0, false
	}
	depth = 0
	for k := j + 1; k < len(toks); k++ {
		switch toks[k].r {
		case '\n':
			return 0, 0, false
		case '(':
			depth++
		case ')':
			if depth--; depth == 0 {
				return j, k + 1, true
			}
		}
	}
	return 0, 0, false
}

// autolinkEnd is the > closing an autolink <scheme:…> or <a@b.c> at toks[i]; 0 when none.
func autolinkEnd(toks []tok, i int) int {
	var b strings.Builder
	for j := i + 1; j < len(toks); j++ {
		r := toks[j].r
		if r == '>' {
			s := b.String()
			if (strings.Contains(s, "://") || strings.HasPrefix(s, "mailto:") || strings.Contains(s, "@")) && !strings.ContainsAny(s, " \n<") {
				return j
			}
			return 0
		}
		if unicode.IsSpace(r) || r == '<' {
			return 0
		}
		b.WriteRune(r)
	}
	return 0
}

func isASCIIPunct(r rune) bool {
	return r < 128 && unicode.IsPunct(r) || r < 128 && unicode.IsSymbol(r)
}

// delim is a run of * _ or ~ that may open or close emphasis.
type delim struct {
	ch          rune
	from, n     int // toks[from:from+n], live ones
	open, close bool
}

// emphasisPass drops the emphasis and strikethrough delimiters that pair up (CommonMark's
// flanking rules, `_` not inside a word); an unpaired one stays as text.
func emphasisPass(toks []tok) {
	var runs []delim
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.drop || t.lit || (t.r != '*' && t.r != '_' && t.r != '~') {
			continue
		}
		j := i
		for j < len(toks) && toks[j].r == t.r && !toks[j].drop && !toks[j].lit {
			j++
		}
		before, after := neighbour(toks, i, -1), neighbour(toks, j-1, 1)
		left := !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before))
		right := !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after))
		d := delim{ch: t.r, from: i, n: j - i, open: left, close: right}
		if t.r == '_' {
			d.open = left && (!right || isPunct(before))
			d.close = right && (!left || isPunct(after))
		}
		runs = append(runs, d)
		i = j - 1
	}
	for c := range runs {
		if !runs[c].close {
			continue
		}
		for o := c - 1; o >= 0 && runs[c].n > 0; o-- {
			if runs[o].ch != runs[c].ch || !runs[o].open || runs[o].n == 0 {
				continue
			}
			k := min(runs[o].n, runs[c].n)
			// The opener's inner end and the closer's inner start pair up.
			for x := 0; x < k; x++ {
				toks[runs[o].from+runs[o].n-1-x].drop = true
				toks[runs[c].from+x].drop = true
			}
			runs[o].n -= k
			runs[c].from += k
			runs[c].n -= k
			// Openers between the pair cannot close anything any more.
			for m := o + 1; m < c; m++ {
				runs[m].open = false
			}
		}
	}
}

// neighbour is the rune next to toks[i] in direction dir (-1, 1), skipping dropped
// markup; ' ' at the text's ends.
func neighbour(toks []tok, i, dir int) rune {
	for j := i + dir; j >= 0 && j < len(toks); j += dir {
		if !toks[j].drop {
			return toks[j].r
		}
	}
	return ' '
}

func isSpace(r rune) bool { return unicode.IsSpace(r) }
func isPunct(r rune) bool { return unicode.IsPunct(r) || unicode.IsSymbol(r) }
