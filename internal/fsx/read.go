package fsx

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

// File reads for the file viewer (FilesystemService.ReadFile).

const (
	// MaxReadBytes is ReadFile's default read, and its largest read of a text file.
	MaxReadBytes = 1 << 20
	// MaxBinaryReadBytes is ReadFile's largest read of a file that is not text (an
	// image or PDF the viewer shows whole).
	MaxBinaryReadBytes = 32 << 20
	// BinarySniff is how many leading bytes LooksBinary checks for NUL (git uses 8000).
	BinarySniff = 8000
)

// LooksBinary reports whether b's first BinarySniff bytes hold a NUL, git's test for
// binary content.
func LooksBinary(b []byte) bool {
	return bytes.IndexByte(b[:min(len(b), BinarySniff)], 0) >= 0
}

// ReadRoots are the trees ReadFile reads. Only reads reach Temp: everything else in the
// app, writes included, stays under home.
type ReadRoots struct {
	// Home is the resolved home directory (ResolveRoot): what "~" expands to, and what
	// the privacy messages name.
	Home string
	// Temp are the temp folders, in every form a path may spell them (TempRoots).
	Temp []string
}

// Allows reports whether p (absolute, cleaned) is under one of the roots.
func (r ReadRoots) Allows(p string) bool { return Within(r.Home, p) || r.InTemp(p) }

// InTemp reports whether p (absolute, cleaned) is under a temp folder.
func (r ReadRoots) InTemp(p string) bool {
	return slices.ContainsFunc(r.Temp, func(t string) bool { return Within(t, p) })
}

// TempRoot is the deepest temp folder holding p (TMPDIR may be below /tmp); "" when none does.
func (r ReadRoots) TempRoot(p string) string {
	top := ""
	for _, t := range r.Temp {
		if len(t) > len(top) && Within(t, p) {
			top = t
		}
	}
	return top
}

// outsideHome is FileContents.OutsideHome for the path p and the real file it leads to.
func (r ReadRoots) outsideHome(p, real string) bool {
	return !Within(r.Home, real) || (r.InTemp(p) && !Within(r.Home, p))
}

// open opens the file at real (symlinks resolved, under the roots) without blocking on a FIFO.
// real has no links, so a home file is opened with none allowed on the way: other users can
// write in parts of home (~/Public/Drop Box). What real names in a temp folder may have been
// swapped for a link too, and is opened through a Root at that folder, which no link leaves.
func (r ReadRoots) open(real string) (*os.File, error) {
	const flags = os.O_RDONLY | syscall.O_NONBLOCK
	if Within(r.Home, real) {
		return os.OpenFile(real, flags|NoFollowAny, 0)
	}
	top := r.TempRoot(real)
	root, err := os.OpenRoot(top)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	return root.OpenFile(below(top, real), flags, 0)
}

// FileContents is ReadFile's result.
type FileContents struct {
	// Path is the absolute, cleaned path asked for (symlinks not followed).
	Path string
	// RealPath is Path with its symlinks followed. NotFound: where it would be, "" without
	// its directory.
	RealPath string
	// Mode is the real file's permission bits.
	Mode fs.FileMode
	// OutsideHome: the file is only here by way of ReadRoots.Temp, as it lies in a temp
	// folder or was reached through one, so what the path leads to can change. The File tab
	// reads it and offers no editing, and no page gets the bridge from it.
	OutsideHome bool
	NotFound    bool
	IsDir       bool
	Contents    []byte
	Size        int64
	Truncated   bool
	Binary      bool
	MIMEType    string
	ModifiedAt  time.Time
}

// ReadFile reads at most maxBytes of the file at path. Zero means MaxReadBytes; a text
// file (a text MIME type and no NUL in the first BinarySniff bytes) is capped at
// MaxReadBytes and any other file at MaxBinaryReadBytes. path is absolute, "~" or
// "~/..." (under roots.Home), or relative to baseDir, which must then be absolute. The file
// its symlinks lead to must be under roots, and a path that does not exist must be too;
// otherwise, and for a path that is not a regular file or directory, the error wraps
// ErrInvalidArgument. A file macOS's privacy
// protection keeps closed is an ErrNotPermitted error that says where to allow it. A
// missing file is NotFound and a directory IsDir, not errors.
//
// The check and the read are not one step, and anything can write to a temp folder, so the
// open is what counts (ReadRoots.open) and what it opened decides what the file is. It never
// blocks: it takes no context, and a FIFO swapped in would otherwise hold it for good.
func ReadFile(roots ReadRoots, baseDir, path string, maxBytes int64) (FileContents, error) {
	if maxBytes < 0 {
		return FileContents{}, fmt.Errorf("%w: max_bytes %d is negative", ErrInvalidArgument, maxBytes)
	}
	if maxBytes == 0 {
		maxBytes = MaxReadBytes
	}
	p, err := ResolveReadPath(roots.Home, baseDir, path)
	if err != nil {
		return FileContents{}, err
	}
	out := FileContents{Path: p}
	real, err := filepath.EvalSymlinks(p)
	if errors.Is(err, fs.ErrNotExist) {
		if !roots.Allows(p) {
			return FileContents{}, outsideRoots(path)
		}
		out.NotFound, out.OutsideHome = true, roots.outsideHome(p, p)
		if dir, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil {
			out.RealPath = filepath.Join(dir, filepath.Base(p))
		}
		return out, nil
	}
	if err != nil {
		return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
	}
	if !roots.Allows(real) {
		return FileContents{}, outsideRoots(path)
	}
	out.OutsideHome = roots.outsideHome(p, real)
	out.RealPath = real
	fi, err := os.Stat(real)
	if err != nil {
		return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
	}
	// Asked first because a folder macOS keeps closed can be stat'd but not opened.
	if err := out.describe(fi, path); err != nil || out.IsDir {
		return out, err
	}
	f, err := roots.open(real)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) { // removed since the stat
			return FileContents{Path: p, NotFound: true, OutsideHome: out.OutsideHome}, nil
		}
		if isPrivacyDenial(err) { // TCC lets a stat through and refuses the open
			return FileContents{}, notPermitted(roots.Home, p, real, reading, err)
		}
		return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
	}
	defer func() { _ = f.Close() }()
	if fi, err = f.Stat(); err != nil {
		return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
	}
	if err := out.describe(fi, path); err != nil || out.IsDir {
		return out, err
	}
	// The type, and so the cap, comes from the name and a head of the file, read before
	// the rest so a large text file is not read only to be cut.
	head := make([]byte, BinarySniff)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
	}
	head = head[:n]
	out.MIMEType = DetectMIME(p, head)
	out.Binary = LooksBinary(head) || !TextMIME(out.MIMEType)
	limit := min(maxBytes, MaxBinaryReadBytes)
	if !out.Binary {
		limit = min(limit, MaxReadBytes)
	}
	b := head[:min(int64(n), limit)]
	if int64(n) == BinarySniff && limit > int64(n) { // more of the file may be wanted
		// Sized from the stat; a file that shrank since reads short, one that grew is
		// cut at its stat size (Truncated compares against that size).
		b = make([]byte, max(min(limit, out.Size), int64(n)))
		copy(b, head)
		m, err := io.ReadFull(f, b[n:])
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
		}
		b = b[:n+m]
	}
	out.Contents = b
	out.Truncated = int64(len(b)) < out.Size
	return out, nil
}

// describe fills in what fi says of the file at path, and refuses anything but a regular file
// or a directory: a FIFO has no end to read to, and a device is never a document.
func (c *FileContents) describe(fi fs.FileInfo, path string) error {
	c.Mode, c.Size, c.ModifiedAt, c.IsDir = fi.Mode().Perm(), fi.Size(), fi.ModTime(), fi.IsDir()
	if !c.IsDir && !fi.Mode().IsRegular() {
		return fmt.Errorf("%w: %s is not a regular file", ErrInvalidArgument, path)
	}
	return nil
}

// outsideRoots is ReadFile's refusal of path.
func outsideRoots(path string) error {
	return fmt.Errorf("%w: %s is outside your home directory and the temp folders", ErrInvalidArgument, path)
}

// ResolveReadPath makes path absolute and clean, as ReadFile does (see its doc).
func ResolveReadPath(root, baseDir, path string) (string, error) {
	switch {
	case path == "":
		return "", fmt.Errorf("%w: path is required", ErrInvalidArgument)
	case path == "~" || strings.HasPrefix(path, "~/"):
		return filepath.Join(root, path[1:]), nil
	case filepath.IsAbs(path):
		return filepath.Clean(path), nil
	case !filepath.IsAbs(baseDir):
		return "", fmt.Errorf("%w: relative path %q needs an absolute base_dir", ErrInvalidArgument, path)
	}
	return filepath.Join(baseDir, path), nil
}

// mimeByExt names the types the viewer cares about by extension. It is our own table,
// not the mime package's, which on macOS reads /etc/apache2/mime.types (where ".ts" is
// video/mp2t).
var mimeByExt = map[string]string{
	".md": "text/markdown", ".markdown": "text/markdown", ".mdx": "text/markdown",
	".html": "text/html", ".htm": "text/html",
	".css": "text/css", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
	".txt": "text/plain", ".log": "text/plain",
	".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".jsx": "text/javascript",
	".ts": "text/typescript", ".mts": "text/typescript", ".cts": "text/typescript", ".tsx": "text/typescript",
	".json": "application/json", ".jsonc": "application/json", ".jsonl": "application/json",
	".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
	".toml": "application/toml", ".svg": "image/svg+xml",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
	".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic",
	".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip",
	".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
	".ttf": "font/ttf", ".otf": "font/otf",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
}

// DetectMIME returns the MIME type of a file named name with leading bytes head: from
// mimeByExt, else sniffed (http.DetectContentType: "text/plain; charset=utf-8" for
// text, "application/octet-stream" when unknown).
func DetectMIME(name string, head []byte) string {
	if t, ok := mimeByExt[strings.ToLower(filepath.Ext(name))]; ok {
		return t
	}
	return http.DetectContentType(head)
}

// TextMIME reports whether a MIME type is text the viewer can show as source.
func TextMIME(t string) bool {
	t, _, _ = strings.Cut(t, ";")
	if strings.HasPrefix(t, "text/") {
		return true
	}
	switch t {
	case "application/json", "application/xml", "application/yaml", "application/toml", "image/svg+xml":
		return true
	}
	return false
}
