package command

// Rendering is one thing the thread view (or the side panel's File tab, reached from it)
// shows, for daemon.capabilities --group rendering.
type Rendering struct {
	Name string `json:"name"`
	What string `json:"what"`
}

// Renderings is what the GUI renders for a thread's model to rely on. It is the one
// hand-kept capabilities group: what the window draws lives in the frontend, which the
// daemon cannot list. Keep it honest: check gui/frontend/src (components/thread/Code.tsx,
// components/pr/Markdown.tsx, lib/inlineHtml.ts, lib/codeActions.ts, lib/pathChips.ts,
// components/thread/ToolDetail.tsx, components/files/) before adding or changing a line,
// and say what does not render too. docs/notes/control-4-capabilities.md.
var Renderings = []Rendering{
	{"markdown", "GitHub-flavoured markdown in replies: headings, lists, task lists, tables (scroll sideways), " +
		"strikethrough, links (absolute ones open in the browser). Raw HTML shows as text, except the inline " +
		"tags kbd, sub, sup, mark, small, ins, del, s, u and br."},
	{"code", "Fenced code with syntax highlighting and a Copy button. A finished bash, sh, shell, zsh or " +
		"console (`$ ` lines) block in your reply also gets Run in terminal, which runs it in a bottom-panel shell."},
	{"paths", "A file path in prose, inline code or a relative link (with :line, :line:col or #L12-L30) becomes " +
		"a chip; clicking it opens the file in the side panel's File tab at that line."},
	{"images", "https images (![alt](https://…)) render inline in a reply. A local image's path in prose or inline code is " +
		"a chip that opens the image in the File tab; markdown image syntax with a local path (![](a.png)) shows only a label that does not open. " +
		"A Read of an image shows it in the tool's detail; the user's attached images show as tiles."},
	{"pdfs", "The user's attached PDFs show a first-page thumbnail and page count. A PDF path chip opens it in the " +
		"File tab, which draws its pages. Replies do not render PDFs inline."},
	{"html", "An .html or .htm file opens rendered and interactive in the File tab (scripts on, sandboxed, served " +
		"by the daemon's preview), through its path chip or view.panel.file; a toggle shows the source."},
	{"edits", "Edit, MultiEdit, Write and NotebookEdit calls show as diffs in the timeline."},
	{"file tab", "Opened by a path chip the user clicks, or by view.panel.file (view.panel.diff for a changed file's diff). " +
		"It renders markdown, images, PDFs and HTML, and highlights other text files."},
	{"not rendered", "Math (LaTeX) and mermaid or other diagrams show as text or code; data: URI images and raw " +
		"HTML blocks do not render."},
}
