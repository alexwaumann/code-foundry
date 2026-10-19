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
	"strings"
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

// FileContents is ReadFile's result.
type FileContents struct {
	// Path is the absolute, cleaned path asked for (symlinks not followed).
	Path       string
	NotFound   bool
	IsDir      bool
	Contents   []byte
	Size       int64
	Truncated  bool
	Binary     bool
	MIMEType   string
	ModifiedAt time.Time
}

// ReadFile reads at most maxBytes of the file at path. Zero means MaxReadBytes; a text
// file (a text MIME type and no NUL in the first BinarySniff bytes) is capped at
// MaxReadBytes and any other file at MaxBinaryReadBytes. path is absolute, "~" or
// "~/..." (under root), or relative to baseDir, which must then be absolute. The path, and the file its symlinks lead to, must be under
// root (a resolved root, see ResolveRoot); otherwise, and for a path that is not a
// regular file or directory, the error wraps ErrInvalidArgument. A missing file is
// NotFound and a directory IsDir, not errors.
func ReadFile(root, baseDir, path string, maxBytes int64) (FileContents, error) {
	if maxBytes < 0 {
		return FileContents{}, fmt.Errorf("%w: max_bytes %d is negative", ErrInvalidArgument, maxBytes)
	}
	if maxBytes == 0 {
		maxBytes = MaxReadBytes
	}
	p, err := resolveReadPath(root, baseDir, path)
	if err != nil {
		return FileContents{}, err
	}
	out := FileContents{Path: p}
	real, err := filepath.EvalSymlinks(p)
	if errors.Is(err, fs.ErrNotExist) {
		if !Within(root, p) {
			return FileContents{}, fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, path)
		}
		out.NotFound = true
		return out, nil
	}
	if err != nil {
		return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
	}
	if !Within(root, real) {
		return FileContents{}, fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, path)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
	}
	out.Size, out.ModifiedAt = fi.Size(), fi.ModTime()
	switch {
	case fi.IsDir():
		out.IsDir = true
		return out, nil
	case !fi.Mode().IsRegular(): // a FIFO would block the read; a device is never a document
		return FileContents{}, fmt.Errorf("%w: %s is not a regular file", ErrInvalidArgument, path)
	}
	f, err := os.Open(real)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) { // removed since the stat
			return FileContents{Path: p, NotFound: true}, nil
		}
		return FileContents{}, fmt.Errorf("fsx: read %s: %w", p, err)
	}
	defer func() { _ = f.Close() }()
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

// resolveReadPath makes path absolute and clean.
func resolveReadPath(root, baseDir, path string) (string, error) {
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
