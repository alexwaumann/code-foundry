package gh

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	east "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/text"
)

// The task-list items of a pull request's description, as the GUI counts them
// (gui/frontend/src/lib/taskItems.ts): the same CommonMark + GFM parse (goldmark here,
// remark there) and the same rule, so the index a click sends names the same box here.
// testdata/task_items.json holds the cases both sides' tests check.
//
// An item is a list item, at any depth, whose first block is a paragraph starting with
// "[ ]", "[x]" or "[X]" and whitespace, with more text after it: micromark's rule, which
// is stricter than goldmark's TaskList about what follows the box, so that extension is
// not used. Fenced and inline code and raw HTML are not paragraphs' text, so the parse
// rules them out. Two things are left out on both sides: a tab as the blank (micromark
// takes it only where the tab is one column wide) and footnotes (they render apart from
// where they are written, and only when referenced).

// taskMarkdown is the parse. Table and Footnote change block structure ("- [ ] a | b"
// over a delimiter row is a table); nothing else does, and no inline extension matters.
var taskMarkdown = goldmark.New(goldmark.WithExtensions(extension.Table, extension.Footnote))

// taskItem is one task-list item of a body.
type taskItem struct {
	// box is the byte offset of its "[".
	box     int
	checked bool
	// text is the rest of the box's source line without the spaces around it: what the
	// client shows and sends back, compared byte for byte.
	text string
}

// taskItems returns body's task-list items in source order.
func taskItems(body []byte) []taskItem {
	var items []taskItem
	// The walker never fails.
	_ = ast.Walk(taskMarkdown.Parser().Parse(text.NewReader(body)), func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n.(type) {
		case *east.FootnoteList:
			return ast.WalkSkipChildren, nil
		case *ast.ListItem:
			if it, ok := taskItemOf(n, body); ok {
				items = append(items, it)
			}
		}
		return ast.WalkContinue, nil
	})
	return items
}

// taskItemOf reads the box at the start of item's first paragraph, if there is one.
func taskItemOf(item ast.Node, body []byte) (taskItem, bool) {
	first := item.FirstChild()
	if first == nil || (first.Kind() != ast.KindTextBlock && first.Kind() != ast.KindParagraph) {
		return taskItem{}, false
	}
	lines := first.Lines()
	if lines.Len() == 0 {
		return taskItem{}, false
	}
	seg := lines.At(0)
	line := body[seg.Start:seg.Stop]
	if len(line) < 4 || line[0] != '[' || line[2] != ']' || strings.IndexByte(" xX", line[1]) < 0 {
		return taskItem{}, false // shorter: the box ends the paragraph, with nothing to tick
	}
	rest := bytes.Trim(line[3:], " \t\r\n")
	if !bytes.ContainsAny(line[3:4], " \t\r\n") || (len(rest) == 0 && lines.Len() == 1) {
		return taskItem{}, false
	}
	if !afterListMarker(body[:seg.Start]) {
		return taskItem{}, false
	}
	return taskItem{box: seg.Start, checked: line[1] == 'x' || line[1] == 'X', text: string(rest)}, true
}

// afterListMarker reports whether before ends in a list marker, with only white space
// and block quote prefixes after it: the paragraph is the item's first content. A link
// definition in front of it is not paragraph text to goldmark but keeps micromark from
// seeing a box.
func afterListMarker(before []byte) bool {
	before = bytes.TrimRight(before, " \t\r\n>")
	return len(before) > 0 && strings.IndexByte("-+*.)", before[len(before)-1]) >= 0
}

// SetTaskItem returns body with its index-th task-list item (counted from 0) ticked or
// unticked, every other byte as it was, and whether that changed anything. refusal, when
// not empty, says why not: there is no such item, or it does not read shown any more.
func SetTaskItem(body string, index int, shown string, checked bool) (next string, changed bool, refusal string) {
	items := taskItems([]byte(body))
	if index < 0 || index >= len(items) {
		return "", false, fmt.Sprintf("has no task %d in its description any more (it has %d)", index+1, len(items))
	}
	it := items[index]
	if it.text != shown {
		return "", false, fmt.Sprintf("has a different task %d in its description now (%q, was %q)", index+1, clip(it.text), clip(shown))
	}
	if it.checked == checked {
		return body, false, ""
	}
	mark := " "
	if checked {
		mark = "x"
	}
	var b strings.Builder
	b.Grow(len(body))
	b.WriteString(body[:it.box+1])
	b.WriteString(mark)
	b.WriteString(body[it.box+2:])
	return b.String(), true, ""
}

// clip shortens s for a message: a task's line can be long.
func clip(s string) string {
	const limit = 60
	if r := []rune(s); len(r) > limit {
		return string(r[:limit]) + "…"
	}
	return s
}
