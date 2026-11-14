package command

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// The item verbs that open one item of a thread: a file (File tab), a changed file's diff
// (Diff tab) and a pull request (Pull request tab) (docs/notes/control-5-fixes.md), as a tab
// linked to the thread (commands_view_open.go). They are always scoped to a thread, the app's
// selection included (its context names it): the item is the thread's. Each checks the item
// first, so a call that would show nothing fails instead.
//
// The tabs' params are what the window's surfaces read:
//   - a File tab: path (absolute), line (1-based, optional), project and base (the thread's
//     project and checkout); --edit adds the request (fileAskParams);
//   - a Diff tab: project and worktree, with what the call set of own, thread, base, head,
//     path, oldPath, paths, title, note and hide (commands_view_diff.go);
//   - a Pull request tab: slug ("owner/name") and number.

// FileReader reads a file the way the File tab does (FilesystemService.ReadFile): under
// the home directory or a temp folder only, relative paths against a base directory.
type FileReader interface {
	ReadFile(context.Context, *connect.Request[v1.ReadFileRequest]) (*connect.Response[v1.ReadFileResponse], error)
}

// WorktreeComparer reads what differs in a checkout the way the Diff tab does
// (ProjectService.CompareWorktree).
type WorktreeComparer interface {
	CompareWorktree(context.Context, *connect.Request[v1.CompareWorktreeRequest]) (*connect.Response[v1.CompareWorktreeResponse], error)
}

// FileEditChecker says whether the File tab can edit a file, or make it where nothing is
// (Filesystem.CheckEdit): its path, or a refusal fit to show, which holds nothing from
// inside the file.
type FileEditChecker interface {
	CheckEdit(ctx context.Context, base, path string) (resolved string, err error)
}

// ProjectLister lists the registered projects (ProjectService.List).
type ProjectLister interface {
	List(context.Context, *connect.Request[v1.ListProjectsRequest]) (*connect.Response[v1.ListProjectsResponse], error)
}

var (
	_ FileReader       = codefoundryv1connect.FilesystemServiceHandler(nil)
	_ WorktreeComparer = codefoundryv1connect.ProjectServiceHandler(nil)
	_ ProjectLister    = codefoundryv1connect.ProjectServiceHandler(nil)
)

// itemCommands are view.open.file, view.open.diff and view.open.pr, each with its classic
// view.panel.<item> alias (commands_view_open.go).
func (d ViewDeps) itemCommands() []Command {
	thread := openThreadArg
	item := func(kind string, check panelCheck) func(context.Context, Context, Args) (Result, error) {
		return func(ctx context.Context, uctx Context, a Args) (Result, error) {
			id := a.String("thread")
			if id == "" {
				return Result{}, InvalidArg("thread", "needs a thread whose tab to open (--thread, or run it inside a thread)")
			}
			return d.showItem(ctx, uctx, a, id, kind, check)
		}
	}
	return withAliases(
		Command{
			Name:      "view.open.file",
			Page:      PageState,
			NoPalette: true,
			Title:     "Open File Tab",
			Description: "Open a file in a File tab " + openLead +
				"text with syntax colours and an optional line marked, markdown rendered, images, PDFs, and HTML pages run interactively. " +
				"With --edit the user edits it instead: for a secret, or a file you cannot read, never ask for the value in chat or try to read the file; " +
				"run this with --line and a --note saying what to put where, then end your turn: a message tells you when it is saved, and you continue without reading its values. " +
				"A missing file starts empty and is made on save, in a directory that must exist. Refused for what the tab cannot edit: tell the user.",
			Category:     "View",
			NoKeybinding: true,
			// Any thread: a thread without a project reads files under home and in the temp folders.
			When: hasThread,
			Args: []ArgSpec{
				{Name: "path", Type: Path, Required: true, Positional: true, Description: "File to show: absolute, ~/…, or relative to the current directory; under the home directory or in a temp folder (/tmp, $TMPDIR; not with --edit)"},
				{Name: "line", Type: Int, Description: "1-based line to scroll to and mark"},
				{Name: "edit", Type: Bool, Description: "Ask the user to edit the file: the tab opens editing, with a band naming this thread and Save and tell thread, whose message says only that it was saved"},
				{Name: "note", Type: String, Description: fmt.Sprintf("With --edit: what to put where, shown as one plain paragraph in the band, quoted as yours; at most %d characters", maxEditNote)},
				thread, openFocusArg, openPaneArg,
			},
			Run: d.runPanelFile,
		},
		Command{
			Name:      "view.open.diff",
			Page:      PageState,
			NoPalette: true,
			Title:     "Open Diff Tab",
			Description: "Open a Diff tab " + openLead +
				"any two of the working tree, the index, or a ref, compared file by file, side by side or unified. " +
				"With no flags, what the branch changed. Narrow it to the files you mean with --path and say why with --note; --title names a tab of your own, so the checkout's stays the user's. " +
				"The user can change what it compares; --hide takes the controls away for a focused view, and they can bring them back.",
			Category:     "View",
			NoKeybinding: true,
			When:         func(c Context) bool { return hasWorktreeThreadContext(c) || cliThread(c) },
			Args:         append(diffArgs(), thread, openFocusArg, openPaneArg),
			Run:          d.runPanelDiff,
		},
		Command{
			Name:      "view.open.pr",
			Page:      PageState,
			NoPalette: true,
			Title:     "Open Pull Request Tab",
			Description: "Open a pull request in a tab " + openLead +
				"the pull request's summary, checks, reviews, timeline and changed files, with Merge and Review.",
			Category:     "View",
			NoKeybinding: true,
			When:         hasThread,
			Args: []ArgSpec{
				{Name: "number", Type: Int, Required: true, Positional: true,
					Description: "Pull request number: one the thread links, else one in its project's GitHub repository"},
				thread, openFocusArg, openPaneArg,
			},
			Run: item(tabPR, d.prCheck),
		},
	)
}

// maxEditNote is the longest --note, in characters: a band above a file, not a message.
const maxEditNote = 500

// runPanelFile is view.open.file. An --edit is asked by the thread running it, which may
// not be the thread whose tab opens: the message goes back to the one that asked.
func (d ViewDeps) runPanelFile(ctx context.Context, uctx Context, a Args) (Result, error) {
	id := a.String("thread")
	if id == "" {
		return Result{}, InvalidArg("thread", "needs a thread whose tab to open (--thread, or run it inside a thread)")
	}
	asker := id
	if uctx.ActiveView == "" && uctx.CallerThreadID != "" {
		asker = uctx.CallerThreadID
	}
	res, err := d.showItem(ctx, uctx, a, id, tabFile, func(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
		switch {
		case a.Bool("edit"):
			return d.editCheck(ctx, t, a, asker)
		case a.Given("note"):
			return nil, InvalidArg("note", "only with --edit: it tells the user what to put in the file")
		}
		return d.fileCheck(ctx, t, a)
	})
	if out, ok := res.JSON.(PanelResult); ok && err == nil && a.Bool("edit") && out.Windows > 0 && res.Message != "" {
		res.Message += editNext
	}
	return res, err
}

// editNext follows --edit's message: what the model does now.
const editNext = "; the user is asked to edit it: end your turn, a message says when it is saved; then continue without reading its values"

// editCheck is view.open.file --edit's check: the tab could edit and save the file, or
// make it (docs/notes/file-edit-3-agent.md). A file the agent may not read comes through
// here, so nothing from inside it reaches the params, the result or an error.
func (d ViewDeps) editCheck(ctx context.Context, t *v1.Thread, a Args, asker string) (map[string]string, error) {
	line, err := fileLine(a)
	if err != nil {
		return nil, err
	}
	note := plainNote(a.String("note"))
	if n := utf8.RuneCountInString(note); n > maxEditNote {
		return nil, InvalidArg("note", "%d characters, at most %d: say what to put where, in a line or two", n, maxEditNote)
	}
	base := t.GetWorktreePath()
	path, err := d.FileEdits.CheckEdit(ctx, base, a.Path("path"))
	if err != nil {
		var ce *connect.Error
		if errors.As(err, &ce) && ce.Code() == connect.CodeInvalidArgument {
			return nil, InvalidArg("path", "%s", strings.TrimPrefix(ce.Message(), "invalid argument: "))
		}
		return nil, err
	}
	// Write takes a link in a temp folder that leads into home, but the tab shows such a file
	// read-only (canEdit): anything could repoint the link while the user typed.
	res, err := d.Files.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{BaseDir: base, Path: a.Path("path"), MaxBytes: 1}))
	if err != nil {
		return nil, err
	}
	if res.Msg.GetOutsideHome() {
		return nil, InvalidArg("path", "%s is reached through a temp folder, so the tab cannot edit it: pass the path it leads to", path)
	}
	params := map[string]string{"path": path, "project": t.GetProjectId(), "base": base}
	if line > 0 {
		params["line"] = strconv.Itoa(line)
	}
	maps.Copy(params, fileAskParams(asker, note, a.Bool("focus")))
	return params, nil
}

// fileAskParams are a request to edit a file, as its File tab's params
// (gui/frontend/src/surfaces/fileTarget.ts ASK_PARAMS): edit, the thread that asked (asker),
// the request's own id (askId: two requests are two, the same note or not), the note when
// there is one, and focus=1 when the user asked to be taken there (the window then puts the
// caret on the line). The window only reads them; its Save and tell answers the asker.
func fileAskParams(asker, note string, focus bool) map[string]string {
	p := map[string]string{"edit": "1", "asker": asker, "askId": newAskID()}
	if note != "" {
		p["note"] = note
	}
	if focus {
		p["focus"] = "1"
	}
	return p
}

// newAskID is a fresh request id: 12 random hex digits.
func newAskID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// maxNoteMarks is the most combining marks a note's character keeps: enough for any script,
// too few to paint over what is around it.
const maxNoteMarks = 3

// plainNote is what a note may show. A note is model text, and a model's input can be
// written by anyone, so it gets no layout of its own: one paragraph, its white space
// collapsed, with no control, format or bidi characters and no towers of combining marks.
// The band cleans it again (lib/plainText.ts), and a thread's name with it.
func plainNote(s string) string {
	var b strings.Builder
	space, marks := false, 0
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			space = b.Len() > 0
			continue
		case unicode.Is(unicode.C, r) || r == utf8.RuneError:
			continue
		case unicode.Is(unicode.M, r):
			if marks++; marks > maxNoteMarks {
				continue
			}
		default:
			marks = 0
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// fileLine is the file verbs' --line: 0 for none.
func fileLine(a Args) (int, error) {
	line := a.Int("line")
	if line < 0 || (a.Given("line") && line == 0) {
		return 0, InvalidArg("line", "want a line number from 1, got %d", line)
	}
	return line, nil
}

// fileCheck is view.open.file's check: the file exists (and is not a directory) where
// the File tab would read it, under the home directory or in a temp folder (ReadFile
// refuses anything else, symlinks followed). The path is absolute: the CLI resolves a
// relative one against its own directory, a thread's worktree when the model runs it.
func (d ViewDeps) fileCheck(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
	params, _, err := d.readCheck(ctx, t, a)
	return params, err
}

// readCheck is fileCheck, with whether the file is outside home (ReadFileResponse.outside_home).
func (d ViewDeps) readCheck(ctx context.Context, t *v1.Thread, a Args) (params map[string]string, outsideHome bool, err error) {
	line, err := fileLine(a)
	if err != nil {
		return nil, false, err
	}
	base := t.GetWorktreePath()
	res, err := d.Files.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{BaseDir: base, Path: a.Path("path"), MaxBytes: 1}))
	if err != nil {
		return nil, false, err
	}
	path := res.Msg.GetResolvedPath()
	switch {
	case res.Msg.GetNotFound():
		return nil, false, connect.NewError(connect.CodeNotFound, fmt.Errorf("no file at %s", path))
	case res.Msg.GetIsDir():
		return nil, false, InvalidArg("path", "%s is a directory, not a file", path)
	}
	params = map[string]string{"path": path, "project": t.GetProjectId(), "base": base}
	if line > 0 {
		params["line"] = strconv.Itoa(line)
	}
	return params, res.Msg.GetOutsideHome(), nil
}

// prCheck is view.open.pr's check: the number names a pull request the thread links
// (in whichever repository), else one in the thread's project's GitHub repository, and
// the gh store can read it (from its cache, else GitHub).
func (d ViewDeps) prCheck(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
	n := a.Int("number")
	if n <= 0 {
		return nil, InvalidArg("number", "want a pull request number from 1, got %d", n)
	}
	var linked []string
	for _, l := range t.GetLinkedPullRequests() {
		if int(l.GetNumber()) == n && !slices.Contains(linked, strings.ToLower(l.GetSlug())) {
			linked = append(linked, strings.ToLower(l.GetSlug()))
		}
	}
	slug := ""
	switch len(linked) {
	case 0:
		s, err := d.projectSlug(ctx, t.GetProjectId())
		if err != nil {
			return nil, err
		}
		if s == "" {
			return nil, refuse(t, fmt.Sprintf("links no pull request #%d and its project has no GitHub repository", n))
		}
		slug = s
	case 1:
		slug = linked[0]
	default:
		return nil, InvalidArg("number", "thread %s links #%d in %d repositories (%s); open it from the thread info card's pull request rows", t.GetId(), n, len(linked), strings.Join(linked, ", "))
	}
	res, err := d.PullRequests.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{RepoSlug: slug, Number: int32(n)}))
	switch {
	case connect.CodeOf(err) == connect.CodeNotFound:
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no pull request #%d in %s", n, slug))
	case err != nil:
		// The CLI prints a connect error's own message: name the pull request in it.
		var ce *connect.Error
		if errors.As(err, &ce) {
			return nil, connect.NewError(ce.Code(), fmt.Errorf("pull request %s#%d: %s", slug, n, ce.Message()))
		}
		return nil, fmt.Errorf("pull request %s#%d: %w", slug, n, err)
	}
	if s := res.Msg.GetPullRequest().GetRepoSlug(); s != "" {
		slug = s
	}
	return map[string]string{"slug": slug, "number": strconv.Itoa(n)}, nil
}

// projectSlug is a project's GitHub repository ("owner/name"), "" without one (or
// without a project).
func (d ViewDeps) projectSlug(ctx context.Context, id string) (string, error) {
	if id == "" {
		return "", nil
	}
	res, err := d.Projects.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
	if err != nil {
		return "", err
	}
	for _, p := range res.Msg.GetProjects() {
		if p.GetId() == id {
			return strings.ToLower(p.GetGithubSlug()), nil
		}
	}
	return "", nil
}
