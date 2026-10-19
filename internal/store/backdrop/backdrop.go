// Package backdrop keeps the images the user added as backdrops (appearance.backdrop =
// custom). Each import copies the file into the backdrops directory (paths.Backdrops)
// under a name made from its content, <32 hex of the SHA-256>.<ext>, so adding the same
// picture twice keeps one copy; the original is never referenced again. Import selects
// the image (appearance.backdrop = custom, appearance.backdrop_file = its name); Remove
// deletes one and, when it was the one custom showed, falls back to the forest art.
//
// The store keeps no state beyond the directory: List reads it every time, and the
// settings store publishes the selection.
package backdrop

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// MaxBytes bounds one backdrop image.
const MaxBytes = 24 << 20

// Types maps the accepted (sniffed) MIME types to the extension a copy is stored with.
var Types = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif":  ".gif",
}

// listed are the extensions List shows: the stored ones, and ".jpeg" for a file put
// there by hand.
var listed = []string{".png", ".jpg", ".jpeg", ".webp", ".gif"}

// Errors. Match with errors.Is; internal/api maps them to Connect codes.
var (
	// ErrInvalidArgument: a relative path, a directory, an unsupported type, a file over
	// MaxBytes, or a name that is not a plain file name.
	ErrInvalidArgument = errors.New("invalid argument")
	// ErrNotFound: the file to import, or the named backdrop, does not exist.
	ErrNotFound = errors.New("not found")
)

// Entry is one image in the backdrops directory.
type Entry struct {
	// Name is the file name in the directory (appearance.backdrop_file).
	Name string
	Size int64
	// Width and Height are the image's pixel size, 0 when its header does not say.
	Width, Height int
	// Added is when it was imported (the copy's modification time).
	Added time.Time
}

// Service is the backdrop store as API handlers see it. *Store implements it;
// backdroptest provides a fake.
type Service interface {
	// List returns the images in the directory, oldest first.
	List(ctx context.Context) ([]Entry, error)
	// Import copies the image at an absolute path in (no second copy when the same
	// content is there already), selects it, and returns its entry.
	Import(ctx context.Context, path string) (Entry, error)
	// Remove deletes an image; when custom showed it, the backdrop falls back to forest.
	Remove(ctx context.Context, name string) error
	// Read returns an image's bytes and sniffed MIME type.
	Read(ctx context.Context, name string) ([]byte, string, error)
}

var _ Service = (*Store)(nil)

// Settings is what the store needs from the settings store. *settings.Store implements it.
type Settings interface {
	Snapshot() *settings.Snapshot
	Update(ctx context.Context, partial map[string]string) (*settings.Snapshot, error)
}

// Options configures a Store.
type Options struct {
	// Dir is the backdrops directory (paths.Backdrops). Created 0700 on the first import.
	Dir string
	// Settings records the selection. Required.
	Settings Settings
	Log      *slog.Logger
}

// Store is the directory-backed backdrop store. Methods are safe for concurrent use.
type Store struct {
	opts Options
	log  *slog.Logger
	// mu serializes Import and Remove, so a removal never races the copy or the
	// selection of the same name.
	mu sync.Mutex
}

// New returns a store over opts.Dir.
func New(opts Options) *Store {
	log := opts.Log
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Store{opts: opts, log: log}
}

// List returns the images directly in the directory (regular, not hidden, with an
// image extension), oldest first. A missing directory is an empty list.
func (s *Store) List(context.Context) ([]Entry, error) {
	des, err := os.ReadDir(s.opts.Dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("backdrop: list: %w", err)
	}
	var out []Entry
	for _, de := range des {
		name := de.Name()
		if !de.Type().IsRegular() || strings.HasPrefix(name, ".") || !slices.Contains(listed, strings.ToLower(filepath.Ext(name))) {
			continue
		}
		e, err := s.entry(name)
		if err != nil {
			continue // removed meanwhile
		}
		out = append(out, e)
	}
	slices.SortFunc(out, func(a, b Entry) int {
		return cmp.Or(a.Added.Compare(b.Added), cmp.Compare(a.Name, b.Name))
	})
	return out, nil
}

// Import copies an image in and selects it. The type is sniffed from the content (the
// file's extension is not consulted) and must be one of Types; the size is checked
// against MaxBytes before the copy and again while copying.
func (s *Store) Import(ctx context.Context, path string) (Entry, error) {
	if !filepath.IsAbs(path) {
		return Entry{}, fmt.Errorf("%w: image %q is not absolute", ErrInvalidArgument, path)
	}
	// Stat before open: opening a FIFO blocks.
	fi, err := os.Stat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return Entry{}, fmt.Errorf("%w: image %q does not exist", ErrNotFound, path)
	case err != nil:
		return Entry{}, fmt.Errorf("%w: image %q: %w", ErrInvalidArgument, path, err)
	case fi.IsDir():
		return Entry{}, fmt.Errorf("%w: %q is a directory", ErrInvalidArgument, path)
	case !fi.Mode().IsRegular():
		return Entry{}, fmt.Errorf("%w: %q is not a regular file", ErrInvalidArgument, path)
	case fi.Size() == 0:
		return Entry{}, fmt.Errorf("%w: %q is empty", ErrInvalidArgument, path)
	case fi.Size() > MaxBytes:
		return Entry{}, tooLarge()
	}
	f, err := os.Open(path)
	if err != nil {
		return Entry{}, fmt.Errorf("%w: image %q: %w", ErrInvalidArgument, path, err)
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, 512)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return Entry{}, fmt.Errorf("%w: image %q: %w", ErrInvalidArgument, path, err)
	}
	head = head[:n]
	mimeType := http.DetectContentType(head)
	ext := Types[mimeType]
	if ext == "" {
		return Entry{}, fmt.Errorf("%w: not a PNG, JPEG, WebP or GIF image (its content is %s)", ErrInvalidArgument, mimeType)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	name, err := s.store(io.MultiReader(bytes.NewReader(head), f), ext)
	if err != nil {
		return Entry{}, err
	}
	if _, err := s.opts.Settings.Update(ctx, map[string]string{
		settings.KeyBackdrop: settings.BackdropCustom, settings.KeyBackdropFile: name,
	}); err != nil {
		return Entry{}, fmt.Errorf("backdrop: select %s: %w", name, err)
	}
	e, err := s.entry(name)
	if err != nil {
		return Entry{}, fmt.Errorf("backdrop: import: %w", err)
	}
	s.log.Info("backdrop imported", "name", name, "from", path, "bytes", e.Size)
	return e, nil
}

// store copies r into the directory under its content name and returns the name. The
// copy goes to a hidden temporary file first (List skips it); when a file of that name
// exists already, the temporary one is dropped and the existing one kept.
func (s *Store) store(r io.Reader, ext string) (string, error) {
	if err := os.MkdirAll(s.opts.Dir, 0o700); err != nil {
		return "", fmt.Errorf("backdrop: import: %w", err)
	}
	tmp, err := os.CreateTemp(s.opts.Dir, ".import-*")
	if err != nil {
		return "", fmt.Errorf("backdrop: import: %w", err)
	}
	drop := func() { _ = tmp.Close(); _ = os.Remove(tmp.Name()) }
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, MaxBytes+1))
	if err != nil {
		drop()
		return "", fmt.Errorf("backdrop: import: %w", err)
	}
	if n > MaxBytes {
		// It grew past the cap after the stat.
		drop()
		return "", tooLarge()
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return "", fmt.Errorf("backdrop: import: %w", err)
	}
	name := hex.EncodeToString(h.Sum(nil))[:32] + ext
	target := filepath.Join(s.opts.Dir, name)
	if _, err := os.Lstat(target); err == nil {
		_ = os.Remove(tmp.Name())
		return name, nil
	}
	if err := os.Rename(tmp.Name(), target); err != nil {
		_ = os.Remove(tmp.Name())
		return "", fmt.Errorf("backdrop: import: %w", err)
	}
	return name, nil
}

// Remove deletes an image. When appearance.backdrop_file names it, that is cleared,
// and a custom backdrop falls back to forest (none stays none).
func (s *Store) Remove(ctx context.Context, name string) error {
	if err := checkName(name); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(filepath.Join(s.opts.Dir, name)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("%w: backdrop %q", ErrNotFound, name)
		}
		return fmt.Errorf("backdrop: remove %s: %w", name, err)
	}
	s.log.Info("backdrop removed", "name", name)
	vals := s.opts.Settings.Snapshot().Values
	if vals[settings.KeyBackdropFile] != name {
		return nil
	}
	partial := map[string]string{settings.KeyBackdropFile: ""}
	if vals[settings.KeyBackdrop] == settings.BackdropCustom {
		partial[settings.KeyBackdrop] = settings.BackdropForest
	}
	if _, err := s.opts.Settings.Update(ctx, partial); err != nil {
		return fmt.Errorf("backdrop: unselect %s: %w", name, err)
	}
	return nil
}

// Read returns an image's bytes and sniffed MIME type. The name must be a regular file
// directly in the directory (no separators, not hidden, not a symlink).
func (s *Store) Read(_ context.Context, name string) ([]byte, string, error) {
	if err := checkName(name); err != nil {
		return nil, "", err
	}
	p := filepath.Join(s.opts.Dir, name)
	fi, err := os.Lstat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return nil, "", fmt.Errorf("%w: backdrop %q", ErrNotFound, name)
	}
	if fi.Size() > MaxBytes {
		return nil, "", tooLarge()
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, "", fmt.Errorf("%w: backdrop %q", ErrNotFound, name)
	}
	mimeType := http.DetectContentType(data)
	if Types[mimeType] == "" {
		return nil, "", fmt.Errorf("%w: backdrop %q is %s, not an image", ErrInvalidArgument, name, mimeType)
	}
	return data, mimeType, nil
}

// checkName refuses anything but a plain, non-hidden file name.
func checkName(name string) error {
	if name == "" || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		return fmt.Errorf("%w: %q is not a file name in the backdrops folder", ErrInvalidArgument, name)
	}
	return nil
}

func tooLarge() error {
	return fmt.Errorf("%w: the limit for a backdrop image is %d MiB", ErrInvalidArgument, MaxBytes>>20)
}

// entry stats a file in the directory and reads its pixel size from the header.
func (s *Store) entry(name string) (Entry, error) {
	p := filepath.Join(s.opts.Dir, name)
	fi, err := os.Stat(p)
	if err != nil {
		return Entry{}, err
	}
	e := Entry{Name: name, Size: fi.Size(), Added: fi.ModTime()}
	e.Width, e.Height = dimensions(p)
	return e, nil
}

// dimensions reads an image's pixel size from its header; 0, 0 when it cannot.
func dimensions(path string) (int, int) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer func() { _ = f.Close() }()
	r := bufio.NewReader(f)
	head, _ := r.Peek(512)
	var decode func(io.Reader) (image.Config, error)
	switch http.DetectContentType(head) {
	case "image/png":
		decode = png.DecodeConfig
	case "image/jpeg":
		decode = jpeg.DecodeConfig
	case "image/gif":
		decode = gif.DecodeConfig
	case "image/webp":
		return webpSize(head)
	default:
		return 0, 0
	}
	c, err := decode(r)
	if err != nil {
		return 0, 0
	}
	return c.Width, c.Height
}

// webpSize reads the canvas size from a WebP's first chunk (VP8X, VP8L or VP8); the
// standard library has no WebP decoder.
func webpSize(b []byte) (int, int) {
	if len(b) < 30 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WEBP" {
		return 0, 0
	}
	d := b[20:]
	switch string(b[12:16]) {
	case "VP8X":
		w := int(d[4]) | int(d[5])<<8 | int(d[6])<<16
		h := int(d[7]) | int(d[8])<<8 | int(d[9])<<16
		return w + 1, h + 1
	case "VP8L":
		if d[0] != 0x2f {
			return 0, 0
		}
		bits := binary.LittleEndian.Uint32(d[1:5])
		return int(bits&0x3fff) + 1, int(bits>>14&0x3fff) + 1
	case "VP8 ":
		if d[3] != 0x9d || d[4] != 0x01 || d[5] != 0x2a {
			return 0, 0
		}
		return int(binary.LittleEndian.Uint16(d[6:8]) & 0x3fff), int(binary.LittleEndian.Uint16(d[8:10]) & 0x3fff)
	}
	return 0, 0
}
