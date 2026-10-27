package preview

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"regexp"
)

// A page a thread shows paints in the app's theme from its first byte
// (docs/notes/inline-page-frame.md). Its frame (the GUI's HtmlFrame) is transparent over the
// card's surface and shows the page once it has loaded, but a document that has not painted
// yet, has no background of its own, or paints only once its /cf/theme.css arrives would
// otherwise show the white canvas a document with no colour-scheme gets in a dark frame. So
// the daemon writes, as the first thing in the document's <head>,
//
//	<meta name="color-scheme" content="dark">
//	<style>:where(html){background-color:var(--cf-surface, #0d1117)}</style>
//
// with the live theme's scheme and surface. The scheme matching the frame's own makes WebKit
// draw the document's canvas transparent; the background is the one /cf/theme.css gives
// html anyway (frame.css), at zero specificity and first, so any rule of the page wins.
//
// Only for the themed frames, which the GUI marks with ThemedParam in the page's URL (a
// thread's pages; the File tab's preview of any other HTML file keeps the bytes as written
// and looks like a browser). Every other response is the file byte for byte.

// ThemedParam is the query parameter (value "1") the GUI adds to the URL of a page shown
// with a thread (gui/frontend/src/components/files/HtmlFrame.tsx): its HTML is painted.
const ThemedParam = "cf-page"

// Paint returns the live theme's scheme ("dark" or "light") and its --cf-surface
// (#rrggbb); empty strings while nothing is published.
type Paint func() (scheme, surface string)

// maxPainted is the largest document painted; a bigger one is served as written.
const maxPainted = 16 << 20

var paintHexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$`)

// paintTag is what goes into the document: the scheme's meta and the surface as html's
// background. Before a theme is published, "light dark" (the frame's own scheme decides)
// and the system's Canvas colour.
func paintTag(scheme, surface string) []byte {
	if scheme != "dark" && scheme != "light" {
		scheme = "light dark"
	}
	if !paintHexRe.MatchString(surface) {
		surface = "Canvas"
	}
	return []byte(`<meta name="color-scheme" content="` + scheme + `"><style>:where(html){background-color:var(--cf-surface, ` + surface + `)}</style>`)
}

// paintAt is where the tag goes in doc so that the parser reads it as the first thing in
// the head: just after the <head> start tag; with none, after <html>'s; with neither, before
// the first thing past the prologue (a byte-order mark, white space, comments and the
// doctype; content before the doctype would put the page in quirks mode). Tags match in
// any case. -1 when the prologue or a start tag does not end in doc (nothing is painted).
func paintAt(doc []byte) int {
	i := 0
	if bytes.HasPrefix(doc, []byte("\xef\xbb\xbf")) {
		i = 3
	}
	if i = skipPrologue(doc, i); i < 0 {
		return -1
	}
	if startTag(doc, i, "html") {
		end := tagEnd(doc, i)
		if end < 0 {
			return -1
		}
		if i = skipPrologue(doc, end); i < 0 {
			return -1
		}
	}
	if startTag(doc, i, "head") {
		return tagEnd(doc, i)
	}
	return i
}

// skipPrologue skips white space, comments, the doctype and processing instructions from
// i; -1 when one of them does not end.
func skipPrologue(doc []byte, i int) int {
	for {
		for i < len(doc) && isSpace(doc[i]) {
			i++
		}
		switch {
		case bytes.HasPrefix(doc[i:], []byte("<!--")):
			end := bytes.Index(doc[i+4:], []byte("-->"))
			if end < 0 {
				return -1
			}
			i += 4 + end + 3
		case bytes.HasPrefix(doc[i:], []byte("<!")), bytes.HasPrefix(doc[i:], []byte("<?")):
			end := bytes.IndexByte(doc[i:], '>')
			if end < 0 {
				return -1
			}
			i += end + 1
		default:
			return i
		}
	}
}

// startTag reports whether doc has the start tag name (lower case) at i, in any case.
func startTag(doc []byte, i int, name string) bool {
	n := i + 1 + len(name)
	if n >= len(doc) || doc[i] != '<' || !bytes.EqualFold(doc[i+1:n], []byte(name)) {
		return false
	}
	return isSpace(doc[n]) || doc[n] == '>' || doc[n] == '/'
}

// tagEnd is the index just past the '>' closing the tag at i (quoted attribute values may
// hold one); -1 when it does not close.
func tagEnd(doc []byte, i int) int {
	var quote byte
	for j := i + 1; j < len(doc); j++ {
		c := doc[j]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '>':
			return j + 1
		}
	}
	return -1
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' }

// painted returns doc with tag at paintAt, or doc and false when it has no place for it.
func painted(doc, tag []byte) ([]byte, bool) {
	at := paintAt(doc)
	if at < 0 {
		return doc, false
	}
	out := make([]byte, 0, len(doc)+len(tag))
	out = append(out, doc[:at]...)
	out = append(out, tag...)
	return append(out, doc[at:]...), true
}

// servePainted serves the HTML document f painted with tag (the headers are set), or
// reports false, having written nothing, for one too big to paint or that cannot be read.
func servePainted(w http.ResponseWriter, r *http.Request, f *os.File, fi os.FileInfo, tag []byte) bool {
	if fi.Size() > maxPainted {
		return false
	}
	doc, err := io.ReadAll(io.LimitReader(f, maxPainted+1))
	if err != nil || len(doc) > maxPainted {
		return false
	}
	doc, _ = painted(doc, tag)
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), bytes.NewReader(doc))
	return true
}
