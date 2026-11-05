package fsx

import (
	"bytes"
	"fmt"
	"io/fs"
	"strings"
	"unicode/utf8"
)

// EditTarget is what Editable found: nothing of the file's contents.
type EditTarget struct {
	// Path is the absolute, cleaned path asked for (symlinks not followed).
	Path string
	// Missing: no file is there, and a create can make one.
	Missing bool
}

// byteOrderMark is UTF-8's, which the File tab's decode would drop.
var byteOrderMark = []byte{0xEF, 0xBB, 0xBF}

// Editable asks what Write and the File tab's editor would, before an agent sends the user
// to a tab that cannot save (view.panel.file --edit): Write's reach, then the rule of canEdit
// in gui/frontend/src/api/files.ts. Paths are as for ReadFile.
//
// The file may be one the agent is not to read, so the answer and every error say only what
// is wrong with it, by its path: no contents, and no size. A path Write would not reach, a
// directory, anything else that is not a regular file, a symlink leading nowhere, a missing
// directory, binary contents, an image, more than MaxReadBytes, invalid UTF-8 and a byte
// order mark all wrap ErrInvalidArgument. A file with no owner write bit is an
// ErrNotWritable error.
func (w *Writer) Editable(baseDir, path string) (EditTarget, error) {
	if strings.IndexByte(path, 0) >= 0 || strings.IndexByte(baseDir, 0) >= 0 {
		return EditTarget{}, fmt.Errorf("%w: the path holds a NUL", ErrInvalidArgument)
	}
	p, err := ResolveReadPath(w.Root, baseDir, path)
	if err != nil {
		return EditTarget{}, err
	}
	t, err := w.locate(p, path)
	if err != nil {
		return EditTarget{}, err
	}
	switch {
	case t.noDir:
		return EditTarget{}, fmt.Errorf("%w: the directory of %s does not exist", ErrInvalidArgument, p)
	case t.info == nil:
		return EditTarget{Path: p, Missing: true}, nil
	case t.info.IsDir():
		return EditTarget{}, fmt.Errorf("%w: %s is a directory, not a file", ErrInvalidArgument, p)
	case t.info.Mode()&fs.ModeSymlink != 0: // locate resolved the rest
		return EditTarget{}, fmt.Errorf("%w: %s is a symlink that leads nowhere", ErrInvalidArgument, p)
	case !t.info.Mode().IsRegular():
		return EditTarget{}, fmt.Errorf("%w: %s is not a regular file", ErrInvalidArgument, p)
	case t.info.Mode()&0o200 == 0:
		return EditTarget{}, refused(ErrNotWritable, fmt.Sprintf("%s is read-only", p), nil)
	}
	f, err := ReadFile(w.Root, baseDir, path, 0)
	if err != nil {
		return EditTarget{}, err
	}
	if f.NotFound { // removed since the look above
		return EditTarget{Path: p, Missing: true}, nil
	}
	if why := notEditable(f); why != "" {
		return EditTarget{}, fmt.Errorf("%w: %s %s", ErrInvalidArgument, p, why)
	}
	return EditTarget{Path: p}, nil
}

// notEditable is why the File tab's editor would not take a read, "" when it would.
func notEditable(f FileContents) string {
	switch {
	case strings.HasPrefix(f.MIMEType, "image/"): // an SVG is text, and shows as a picture
		return "is an image, which the File tab shows but does not edit"
	case f.Binary:
		return "is a binary file, which the File tab does not edit"
	case f.Truncated:
		return "is over 1 MiB, the most the File tab edits"
	case bytes.HasPrefix(f.Contents, byteOrderMark):
		return "starts with a byte order mark, which saving would drop"
	case !utf8.Valid(f.Contents):
		return "is not valid UTF-8, which saving would damage"
	}
	return ""
}
