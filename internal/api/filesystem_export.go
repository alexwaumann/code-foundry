package api

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/fsx"
)

var _ command.FileExporter = (*Filesystem)(nil)

// ExportTarget is what file.export would find at rel inside dir (a thread's checkout).
// Not an RPC: the command asks by reading.
func (h *Filesystem) ExportTarget(_ context.Context, dir, rel string) (command.ExportTarget, error) {
	res, err := h.writer.Lookup(fsx.WriteRequest{BaseDir: dir, Path: rel, Within: dir})
	if err != nil {
		return command.ExportTarget{}, fileError(err)
	}
	if err := h.exportGuarded(res.Path); err != nil {
		return command.ExportTarget{}, err
	}
	return exportTarget(res), nil
}

// ExportFile writes file.export's file with the File tab's writer, inside dir.
func (h *Filesystem) ExportFile(_ context.Context, w command.ExportWrite) (command.ExportTarget, bool, error) {
	req := fsx.WriteRequest{BaseDir: w.Dir, Path: w.Rel, Contents: w.Contents, Within: w.Dir, Force: w.Force}
	switch {
	case w.Replace != nil:
		req.Size, req.ModifiedAt = w.Replace.Size, w.Replace.ModifiedAt
	case !w.Force:
		req.Create = true
	}
	look, err := h.writer.Lookup(req)
	if err != nil {
		return command.ExportTarget{}, false, fileError(err)
	}
	if err := h.exportGuarded(look.Path); err != nil {
		return command.ExportTarget{}, false, err
	}
	res, err := h.writer.Write(req)
	if err != nil {
		return command.ExportTarget{}, false, fileError(err)
	}
	return exportTarget(res), res.Conflict, nil
}

// exportGuarded refuses a file in a folder the preview guards (credentials, ~/Library):
// a thread without a project has the home folder as its checkout, and a page's file has
// no business there either.
func (h *Filesystem) exportGuarded(p string) error {
	if h.previewGuarded(p) {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s is in a protected folder (Code Foundry's own data, credentials or ~/Library)", p))
	}
	return nil
}

func exportTarget(r fsx.WriteResult) command.ExportTarget {
	return command.ExportTarget{Path: r.Path, Exists: !r.NotFound, Size: r.Size, ModifiedAt: r.ModifiedAt}
}
