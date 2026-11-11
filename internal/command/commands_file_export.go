package command

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// file.export saves a file a page made (an Export button's CSV) into its thread's checkout
// (docs/notes/page-save.md). A page's frame has no download, so this is where its files go.

// MaxExportBytes is the most file.export writes: the bridge's cap on a call (lib/bridge.ts
// BRIDGE_LIMITS.messageChars), so a page never makes a file the CLI could not.
const MaxExportBytes = 256 << 10

// ExportTarget is what is at a file.export path: Path, absolute, and the file there, if any.
type ExportTarget struct {
	Path             string
	Exists           bool
	Size, ModifiedAt int64
}

// ExportWrite is one file.export write: Rel inside Dir. Replace is the file the user agreed
// to replace (nil: make a new file only); Force replaces whatever is there.
type ExportWrite struct {
	Dir, Rel string
	Contents []byte
	Replace  *ExportTarget
	Force    bool
}

// FileExporter writes inside a checkout with the File tab's writer (Filesystem.ExportTarget
// and ExportFile): never outside dir, symlinks resolved, nor into what the writer protects
// or the preview's guarded folders. A refusal is InvalidArgument.
type FileExporter interface {
	ExportTarget(ctx context.Context, dir, rel string) (ExportTarget, error)
	// ExportFile writes, or answers conflict with nothing written when the file is not what
	// w expects (there now without Replace, or changed since).
	ExportFile(ctx context.Context, w ExportWrite) (written ExportTarget, conflict bool, err error)
}

// FileExportDeps are RegisterFileExport's dependencies.
type FileExportDeps struct {
	Thread ThreadGetter
	Files  FileExporter
}

// FileExportResult is file.export's JSON.
type FileExportResult struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Replaced bool   `json:"replaced,omitempty"`
}

// exportReplacesArg is what the confirmation binds: the file the user agreed to replace.
var exportReplacesArg = ArgSpec{Name: "replaces", Type: String,
	Description: "Set by the confirmation: the file you were asked to replace; it refuses if that file changed by then (--yes alone replaces what is there)"}

// noFileExports is FileExportDeps.Files when nothing backs it.
type noFileExports struct{}

func (noFileExports) ExportTarget(context.Context, string, string) (ExportTarget, error) {
	return ExportTarget{}, connect.NewError(connect.CodeUnimplemented, errors.New("no file exports here"))
}

func (noFileExports) ExportFile(context.Context, ExportWrite) (ExportTarget, bool, error) {
	return ExportTarget{}, false, connect.NewError(connect.CodeUnimplemented, errors.New("no file exports here"))
}

// RegisterFileExport registers file.export. A nil Files fails it with Unimplemented.
func RegisterFileExport(r *Registry, d FileExportDeps) error {
	if d.Files == nil {
		d.Files = noFileExports{}
	}
	return r.Register(Command{
		Name:  "file.export",
		Title: "Export File",
		Description: fmt.Sprintf("Save a file into a thread's checkout (its working directory): for a page's Export button, since a page cannot download. "+
			"Pass the contents as --text, or as --base64 for bytes, at most %d KiB. "+
			"A file already there is replaced only after the user agrees. Prints the path it wrote.", MaxExportBytes>>10),
		Category:     "View",
		NoPalette:    true,
		NoKeybinding: true,
		NoIndex:      true,
		When:         hasThread,
		Args: []ArgSpec{
			{Name: "path", Type: String, Required: true, Positional: true,
				Description: "A file name, or a path relative to the checkout that stays inside it, in a folder that exists; no name may start with a dot"},
			{Name: "text", Type: String, FileOrStdin: true, PageShowsSize: true, Description: "The contents, as text (@file: from a file, -: stdin)"},
			{Name: "base64", Type: String, FileOrStdin: true, PageShowsSize: true, Description: "The contents, as base64, for a file that is not text (@file: from a file, -: stdin)"},
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
				Description: "Thread whose checkout it goes in (default: the thread this runs in, $CODE_FOUNDRY_THREAD)" + IDHelp},
			exportReplacesArg,
		},
		PageDetail: func(ctx context.Context, _ Context, a Args) (string, error) {
			c, err := d.exportCall(ctx, a)
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("Saves %s to %s", byteSize(len(c.contents)), c.target.Path), nil
		},
		Confirm:      "Replace {path}?",
		ConfirmLabel: "Replace",
		BindConfirm:  exportReplacesArg.Name,
		ConfirmIf: func(ctx context.Context, _ Context, a Args) bool {
			c, err := d.exportCall(ctx, a)
			return err == nil && c.target.Exists // Run reports an error
		},
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			c, err := d.exportCall(ctx, a)
			if err != nil {
				return ""
			}
			return fmt.Sprintf("Replace %s? A file is there already (%s); it becomes %s.", c.target.Path, byteSize(int(c.target.Size)), byteSize(len(c.contents)))
		},
		ConfirmBind: func(ctx context.Context, _ Context, a Args, _ string) string {
			c, err := d.exportCall(ctx, a)
			if err != nil || !c.target.Exists {
				return ""
			}
			return exportStamp(c.target)
		},
		Run: d.runExport,
	})
}

func (d FileExportDeps) runExport(ctx context.Context, uctx Context, a Args) (Result, error) {
	c, err := d.exportCall(ctx, a)
	if err != nil {
		return Result{}, err
	}
	w := ExportWrite{Dir: c.dir, Rel: c.rel, Contents: c.contents}
	switch replaces := a.String(exportReplacesArg.Name); {
	case replaces != "":
		size, modified, ok := parseExportStamp(replaces)
		if !ok {
			return Result{}, InvalidArg(exportReplacesArg.Name, "is set by the confirmation; leave it out")
		}
		w.Replace = &ExportTarget{Path: c.target.Path, Exists: true, Size: size, ModifiedAt: modified}
	case ConfirmedIn(ctx) && !uctx.Untrusted():
		// The CLI's --yes: whatever is there. A page's yes to its question is not one to
		// replace a file that appeared since.
		w.Force = true
	}
	written, conflict, err := d.Files.ExportFile(ctx, w)
	switch {
	case err != nil:
		return Result{}, exportError(err)
	case conflict && w.Replace != nil:
		return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s changed since you were asked; nothing was saved, so ask again", c.target.Path))
	case conflict:
		return Result{}, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s exists now; nothing was saved, so ask again", c.target.Path))
	}
	verb := "saved"
	if c.target.Exists {
		verb = "replaced"
	}
	return Result{
		Message: fmt.Sprintf("%s %s (%s)", verb, written.Path, byteSize(int(written.Size))),
		JSON:    FileExportResult{Path: written.Path, Size: written.Size, Replaced: c.target.Exists},
	}, nil
}

// exportPlan is a checked file.export call.
type exportPlan struct {
	dir, rel string
	target   ExportTarget
	contents []byte
}

// exportCall checks a call: the thread's checkout, the path in it, and the contents. It
// is asked again at each step (the question, the confirmation, the run), so each sees the
// file as it is then.
func (d FileExportDeps) exportCall(ctx context.Context, a Args) (exportPlan, error) {
	contents, err := exportContents(a)
	if err != nil {
		return exportPlan{}, err
	}
	dir, rel, err := d.exportPlace(ctx, a)
	if err != nil {
		return exportPlan{}, err
	}
	t, err := d.Files.ExportTarget(ctx, dir, rel)
	if err != nil {
		return exportPlan{}, exportError(err)
	}
	return exportPlan{dir: dir, rel: rel, target: t, contents: contents}, nil
}

// exportPlace is the thread's checkout and the path in it.
func (d FileExportDeps) exportPlace(ctx context.Context, a Args) (dir, rel string, err error) {
	rel, err = exportPath(a.String("path"))
	if err != nil {
		return "", "", err
	}
	id := a.String("thread")
	if id == "" {
		return "", "", InvalidArg("thread", "needs a thread whose checkout to save in (--thread, or run it inside a thread)")
	}
	res, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
	if err != nil {
		return "", "", err
	}
	dir = res.Msg.GetThread().GetWorktreePath()
	if dir == "" {
		// Its worktree is still being made, or its setup failed before it was.
		return "", "", connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("thread %s has no checkout yet", id))
	}
	return dir, rel, nil
}

// exportPath is a file.export path, cleaned: relative, inside the checkout as spelled, and
// with no name starting with a dot. Such names are where programs read their settings and
// run what they say (.git/config, .claude/settings.json, a shell's .zshrc), which a page's
// data has no business in. Symlinks are the writer's (Within).
func exportPath(p string) (string, error) {
	switch {
	case strings.TrimSpace(p) == "":
		return "", InvalidArg("path", "needs a file name")
	case filepath.IsAbs(p) || strings.HasPrefix(p, "~"):
		return "", InvalidArg("path", "%q is not relative: give a file name, or a path inside the thread's checkout", p)
	case !filepath.IsLocal(p):
		return "", InvalidArg("path", "%q leads outside the thread's checkout", p)
	}
	clean := filepath.Clean(p)
	for _, name := range strings.Split(clean, string(filepath.Separator)) {
		if strings.HasPrefix(name, ".") {
			return "", InvalidArg("path", "%q has a name starting with a dot, where programs keep their settings: choose another name", p)
		}
	}
	return clean, nil
}

// exportContents is --text or --base64, exactly one, within MaxExportBytes.
func exportContents(a Args) ([]byte, error) {
	var b []byte
	switch text, enc := a.Given("text") || a.Blank("text"), a.Given("base64") || a.Blank("base64"); {
	case text && enc:
		return nil, InvalidArg("base64", "pass the contents once: --text or --base64")
	case text:
		b = []byte(a.String("text"))
	case enc:
		var err error
		if b, err = base64.StdEncoding.DecodeString(a.String("base64")); err != nil {
			return nil, InvalidArg("base64", "is not base64: %v", err)
		}
	default:
		return nil, InvalidArg("text", "needs the contents: --text, or --base64 for bytes")
	}
	if len(b) > MaxExportBytes {
		return nil, InvalidArg("text", "the contents are %d bytes, at most %d (%d KiB)", len(b), MaxExportBytes, MaxExportBytes>>10)
	}
	return b, nil
}

// exportError is an ExportTarget or ExportFile refusal as the path arg's error.
func exportError(err error) error {
	var ce *connect.Error
	if errors.As(err, &ce) && ce.Code() == connect.CodeInvalidArgument {
		return InvalidArg("path", "%s", strings.TrimPrefix(ce.Message(), "invalid argument: "))
	}
	return err
}

// exportStamp binds a yes to the file it named: its size and modification time.
func exportStamp(t ExportTarget) string {
	return strconv.FormatInt(t.Size, 10) + ":" + strconv.FormatInt(t.ModifiedAt, 10)
}

func parseExportStamp(s string) (size, modified int64, ok bool) {
	a, b, found := strings.Cut(s, ":")
	size, err1 := strconv.ParseInt(a, 10, 64)
	modified, err2 := strconv.ParseInt(b, 10, 64)
	return size, modified, found && err1 == nil && err2 == nil
}

// exportSize is a byte count for people: "812 bytes", "12.4 KiB".
func byteSize(n int) string {
	if n < 1024 {
		if n == 1 {
			return "1 byte"
		}
		return strconv.Itoa(n) + " bytes"
	}
	return strconv.FormatFloat(float64(n)/1024, 'f', 1, 64) + " KiB"
}
