package fsx

import (
	"bytes"
	"fmt"
	"io/fs"
	"strings"
	"unicode/utf8"
)

// byteOrderMark is UTF-8's, which the File tab's decode would drop.
var byteOrderMark = []byte{0xEF, 0xBB, 0xBF}

// Editable asks what Write and the File tab's editor would, before an agent sends the user
// to a tab that cannot save (view.open.file --edit): Write's reach, then the rule of canEdit
// in gui/frontend/src/api/files.ts. Paths are as for ReadFile. It returns the absolute, cleaned
// path asked for, where nothing may be yet: a create can make it.
//
// The file may be one the agent is not to read, so an error says only which rule it failed,
// by its path: no contents, and no size. A path Write would not reach, a
// directory, anything else that is not a regular file, a symlink leading nowhere, a missing
// directory, binary contents, an image, more than MaxReadBytes, invalid UTF-8 and a byte
// order mark all wrap ErrInvalidArgument. A file with no owner write bit is an
// ErrNotWritable error.
func (w *Writer) Editable(baseDir, path string) (string, error) {
	if strings.IndexByte(path, 0) >= 0 || strings.IndexByte(baseDir, 0) >= 0 {
		return "", fmt.Errorf("%w: the path holds a NUL", ErrInvalidArgument)
	}
	p, err := ResolveReadPath(w.Root, baseDir, path)
	if err != nil {
		return "", err
	}
	t, err := w.locate(p, path)
	if err != nil {
		return "", err
	}
	switch {
	case t.noDir:
		return "", fmt.Errorf("%w: the directory of %s does not exist", ErrInvalidArgument, p)
	case t.info == nil:
		return p, nil
	case t.info.IsDir():
		return "", fmt.Errorf("%w: %s is a directory, not a file", ErrInvalidArgument, p)
	case t.info.Mode()&fs.ModeSymlink != 0: // locate resolved the rest
		return "", fmt.Errorf("%w: %s is a symlink that leads nowhere", ErrInvalidArgument, p)
	case !t.info.Mode().IsRegular():
		return "", fmt.Errorf("%w: %s is not a regular file", ErrInvalidArgument, p)
	case t.info.Mode()&0o200 == 0:
		return "", refused(ErrNotWritable, fmt.Sprintf("%s is read-only", p), nil)
	}
	f, err := ReadFile(ReadRoots{Home: w.Root}, baseDir, path, 0)
	if err != nil {
		return "", err
	}
	if why := notEditable(f); why != "" {
		return "", fmt.Errorf("%w: %s %s", ErrInvalidArgument, p, why)
	}
	return p, nil // a file removed since the look above reads as text: the tab makes it again
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
