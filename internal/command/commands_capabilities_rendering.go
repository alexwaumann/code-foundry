package command

import (
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bridge"
)

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
		"by the daemon's preview), through its path chip or view.panel.file; a toggle shows the source. A page that links " +
		"<link rel=\"stylesheet\" href=\"/cf/theme.css\"> gets the user's theme: --cf-* variables (surfaces, text, accent, " +
		"status colours, sidebar, diff, charts), the shadcn names (--background, --card…), radii and type-role classes " +
		"(.text-body…); /cf/theme.json has the same for scripts, and the frame is posted {type: \"cf:theme\", id, scheme, vars} " +
		"on load and on every theme change; a page that applies it replies {type: \"cf:theme:ack\"} and keeps its state, any other " +
		"reloads 300 ms later. The frame's prefers-color-scheme is the app's scheme, but paint with the variables, not fixed colours " +
		"or prefers-color-scheme blocks. view.inline shows a page inline in the conversation instead, in the same frame; " +
		"it may post {type: \"cf:resize\", height} (measure document.body, not the document, so it can shrink), or load the bridge, which does it."},
	{"bridge", "A page shown with view.inline can call Code Foundry: <script src=\"/cf/bridge.js\"></script> gives window.cf. " +
		"await cf.ready, then cf.thread is {id, name} and cf.theme {id, scheme, vars}. " +
		"cf.run(verb, {arg: value}) runs a command as your thread's CLI would (the same verbs and args, values as strings) and " +
		"resolves {text, json}. A verb that changes anything (all but reads such as thread get, settings get, pr checks) runs only " +
		"from a click or key press in the page, and a confirmation still asks the user. It rejects with {code, message}, code one of " +
		strings.Join(bridge.ErrorCodes, ", ") + ". " +
		"cf.on(source, fn) calls fn(event) for each daemon event and returns an unsubscribe; sources: " +
		strings.Join(bridge.Sources, ", ") + " (thread: this thread's status and pending requests, not its items). " +
		"cf.onTheme(fn) hears theme changes (the script applies them and acks); the card follows the page's height by itself " +
		"(cf.resize() forces it). cf.storage(prefix) is localStorage under this thread's keys: storage persists across reloads and " +
		"restarts and is shared by every page (raw localStorage too). A page runs only while it is on screen, so no background " +
		"work: that is a plugin. Sign-in redirects (SSO, OAuth) do not work in the frame: ask the user for a token instead."},
	{"themes", "theme save run from your thread adds a theme card to your conversation: the theme's swatches, its contrast check, " +
		"Undo (back to what the slot showed just before: another theme, or the colours the save replaced) and Edit (the Themes page's editor). When the save changes what a slot shows (--apply onto " +
		"another theme, or new colours for the theme in use) the user also gets a toast with Undo and Edit. A later save of the same theme adds a new card. " +
		"The save prints the app's contrast check of the file (failing pairs, stale pins) while the app is open; theme check <id> prints it again."},
	{"edits", "Edit, MultiEdit, Write and NotebookEdit calls show as diffs in the timeline."},
	{"file tab", "Opened by a path chip the user clicks, or by view.panel.file (view.panel.diff for a changed file's diff). " +
		"It renders markdown, images, PDFs and HTML, and highlights other text files."},
	{"not rendered", "Math (LaTeX) and mermaid or other diagrams show as text or code; data: URI images and raw " +
		"HTML blocks do not render."},
}
