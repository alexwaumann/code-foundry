package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// EventFilesDropped is emitted to the frontend when files are dropped from the OS on an
// element with `data-file-drop-target` (the composers). The data is a FilesDropped.
const EventFilesDropped = "app:files-dropped"

// dropIDAttribute names the drop target: each composer gives its drop surface a unique
// value and acts only on drops whose Target is its own.
const dropIDAttribute = "data-drop-id"

// FilesDropped is the payload of EventFilesDropped.
type FilesDropped struct {
	// Paths are the dropped files' and folders' absolute paths, in the order the OS gave them.
	Paths []string `json:"paths"`
	// Target is the drop target's data-drop-id ("" when it has none).
	Target string `json:"target"`
}

// filesDropped shapes a native drop into the event payload; false when nothing was
// dropped. The runtime reports only drops on a drop target, but one without a
// data-drop-id still gives Target "" (no composer takes it).
func filesDropped(paths []string, target *application.DropTargetDetails) (FilesDropped, bool) {
	if len(paths) == 0 {
		return FilesDropped{}, false
	}
	out := FilesDropped{Paths: append([]string(nil), paths...)}
	if target != nil {
		out.Target = target.Attributes[dropIDAttribute]
	}
	return out, true
}

// forwardFileDrops hands the window's native file drops to the page. With EnableFileDrop
// a native overlay takes every file drag from the OS (the page sees no DOM drop for
// them); the Wails runtime finds the drop target under the point and reports it here.
func forwardFileDrops(w *application.WebviewWindow) {
	w.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		ctx := e.Context()
		if p, ok := filesDropped(ctx.DroppedFiles(), ctx.DropTargetDetails()); ok {
			w.EmitEvent(EventFilesDropped, p)
		}
	})
}

// PickFiles shows the native open panel for the composer's attach button: files and
// folders, several at once, no type filter (the composer attaches images and PDFs and
// inserts any other path as text). It opens at startDir when that is an existing
// directory (the thread's checkout), else at home. Returns the chosen paths, empty when
// the user cancels.
func (s *AppService) PickFiles(startDir string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("pick files: %w", err)
	}
	app := application.Get()
	d := app.Dialog.OpenFile().
		CanChooseFiles(true).
		CanChooseDirectories(true).
		ResolvesAliases(true).
		SetTitle("Attach files").
		SetButtonText("Attach").
		SetDirectory(filesStart(startDir, home, isDir))
	if w := app.Window.Current(); w != nil {
		d.AttachToWindow(w)
	}
	paths, err := d.PromptForMultipleSelection()
	if err != nil {
		return nil, fmt.Errorf("pick files: %w", err)
	}
	if paths == nil {
		paths = []string{}
	}
	s.log.Debug("files picked", "count", len(paths))
	return paths, nil
}

// filesStart is where the file picker opens: startDir when it is an absolute path to an
// existing directory, else home.
func filesStart(startDir, home string, isDir func(string) bool) string {
	if !filepath.IsAbs(startDir) {
		return home
	}
	p := filepath.Clean(startDir)
	if !isDir(p) {
		return home
	}
	return p
}
