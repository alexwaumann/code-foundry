package backdrop

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
)

func solid(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{R: uint8(x), G: 120, B: uint8(y), A: 255})
		}
	}
	return img
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, solid(w, h)); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, solid(w, h), nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func gifBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := gif.Encode(&b, solid(w, h), nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// webpBytes is a lossless WebP's header (RIFF, VP8L chunk, size bits) and padding: enough
// to sniff and to read the size from; nothing here decodes pixels.
func webpBytes(w, h int) []byte {
	body := make([]byte, 64)
	body[0] = 0x2f
	binary.LittleEndian.PutUint32(body[1:5], uint32(w-1)|uint32(h-1)<<14)
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(4+8+len(body)))
	b.WriteString("WEBPVP8L")
	_ = binary.Write(&b, binary.LittleEndian, uint32(len(body)))
	b.Write(body)
	return b.Bytes()
}

type fixture struct {
	store    *Store
	settings *settingstest.Fake
	dir, src string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	root := t.TempDir()
	set, err := settingstest.New(context.Background(), root, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = set.Close() })
	dir := filepath.Join(root, "backdrops")
	src := filepath.Join(root, "src")
	if err := os.Mkdir(src, 0o700); err != nil {
		t.Fatal(err)
	}
	return fixture{store: New(Options{Dir: dir, Settings: set}), settings: set, dir: dir, src: src}
}

func (f fixture) write(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(f.src, name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func (f fixture) value(key string) string { return f.settings.Snapshot().Values[key] }

var contentName = regexp.MustCompile(`^[0-9a-f]{32}\.(png|jpg|webp|gif)$`)

func TestImport(t *testing.T) {
	tests := []struct {
		name     string
		file     string
		data     func(t *testing.T) []byte
		ext      string
		w, h     int
		err      error
		errText  string
		noSource bool
	}{
		{name: "png", file: "a.png", data: func(t *testing.T) []byte { return pngBytes(t, 40, 30) }, ext: ".png", w: 40, h: 30},
		{name: "jpeg with a .jpeg name", file: "b.jpeg", data: func(t *testing.T) []byte { return jpegBytes(t, 64, 36) }, ext: ".jpg", w: 64, h: 36},
		{name: "webp", file: "c.webp", data: func(*testing.T) []byte { return webpBytes(1600, 900) }, ext: ".webp", w: 1600, h: 900},
		{name: "gif", file: "d.gif", data: func(t *testing.T) []byte { return gifBytes(t, 12, 8) }, ext: ".gif", w: 12, h: 8},
		{name: "a png named .txt is a png", file: "e.txt", data: func(t *testing.T) []byte { return pngBytes(t, 4, 4) }, ext: ".png", w: 4, h: 4},
		{name: "text named .png", file: "f.png", data: func(*testing.T) []byte { return []byte("not an image at all") },
			err: ErrInvalidArgument, errText: "invalid argument: not a PNG, JPEG, WebP or GIF image (its content is text/plain; charset=utf-8)"},
		{name: "pdf", file: "g.pdf", data: func(*testing.T) []byte { return []byte("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n") },
			err: ErrInvalidArgument, errText: "invalid argument: not a PNG, JPEG, WebP or GIF image (its content is application/pdf)"},
		{name: "empty", file: "h.png", data: func(*testing.T) []byte { return nil }, err: ErrInvalidArgument},
		{name: "missing", file: "gone.png", noSource: true, err: ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			path := filepath.Join(f.src, tt.file)
			if !tt.noSource {
				path = f.write(t, tt.file, tt.data(t))
			}
			e, err := f.store.Import(context.Background(), path)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || (tt.errText != "" && err.Error() != tt.errText) {
					t.Fatalf("err = %v, want %v %q", err, tt.err, tt.errText)
				}
				if des, _ := os.ReadDir(f.dir); len(des) != 0 {
					t.Fatalf("a refused import left %d files", len(des))
				}
				if got := f.value(settings.KeyBackdrop); got != settings.BackdropForest {
					t.Fatalf("backdrop = %q after a refusal", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !contentName.MatchString(e.Name) || filepath.Ext(e.Name) != tt.ext {
				t.Fatalf("name = %q, want <32 hex>%s", e.Name, tt.ext)
			}
			src, _ := os.ReadFile(path)
			copied, err := os.ReadFile(filepath.Join(f.dir, e.Name))
			if err != nil || !bytes.Equal(src, copied) || e.Size != int64(len(src)) {
				t.Fatalf("copy differs from the source (err %v, size %d)", err, e.Size)
			}
			if e.Width != tt.w || e.Height != tt.h {
				t.Fatalf("size = %dx%d, want %dx%d", e.Width, e.Height, tt.w, tt.h)
			}
			if time.Since(e.Added) > time.Minute {
				t.Fatalf("added = %v", e.Added)
			}
			if f.value(settings.KeyBackdrop) != settings.BackdropCustom || f.value(settings.KeyBackdropFile) != e.Name {
				t.Fatalf("selection = %q %q", f.value(settings.KeyBackdrop), f.value(settings.KeyBackdropFile))
			}
		})
	}
}

func TestImportRefusesPaths(t *testing.T) {
	f := newFixture(t)
	big := filepath.Join(f.src, "big.png")
	if err := os.WriteFile(big, pngBytes(t, 2, 2), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(big, MaxBytes+1); err != nil {
		t.Fatal(err)
	}
	atCap := f.write(t, "cap.png", pngBytes(t, 2, 2))
	if err := os.Truncate(atCap, MaxBytes); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, path, want string
	}{
		{"relative", "pics/a.png", `invalid argument: image "pics/a.png" is not absolute`},
		{"directory", f.src, `invalid argument: "` + f.src + `" is a directory`},
		{"over the cap", big, "invalid argument: the limit for a backdrop image is 24 MiB"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := f.store.Import(context.Background(), tt.path)
			if !errors.Is(err, ErrInvalidArgument) || err.Error() != tt.want {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
		})
	}
	t.Run("exactly at the cap", func(t *testing.T) {
		if _, err := f.store.Import(context.Background(), atCap); err != nil {
			t.Fatal(err)
		}
	})
}

func TestImportDuplicate(t *testing.T) {
	f := newFixture(t)
	data := pngBytes(t, 8, 8)
	first, err := f.store.Import(context.Background(), f.write(t, "one.png", data))
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.store.Import(context.Background(), f.write(t, "other.gif", gifBytes(t, 3, 3)))
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.store.Import(context.Background(), f.write(t, "copy of one.png", data))
	if err != nil {
		t.Fatal(err)
	}
	if again.Name != first.Name || !again.Added.Equal(first.Added) {
		t.Fatalf("re-import = %+v, want %+v", again, first)
	}
	des, _ := os.ReadDir(f.dir)
	if len(des) != 2 {
		t.Fatalf("%d files after a duplicate import, want 2", len(des))
	}
	// Re-adding selects it again.
	if got := f.value(settings.KeyBackdropFile); got != first.Name || other.Name == first.Name {
		t.Fatalf("selected %q, want %q", got, first.Name)
	}
}

func TestRemove(t *testing.T) {
	tests := []struct {
		name string
		// choice is appearance.backdrop before the removal; selectB selects b instead of a.
		choice   string
		selectB  bool
		remove   string // "a" or "b"
		wantFile string // "a", "b" or ""
		want     string
	}{
		{name: "the selected one falls back to forest", choice: settings.BackdropCustom, remove: "a", wantFile: "", want: settings.BackdropForest},
		{name: "another keeps the selection", choice: settings.BackdropCustom, remove: "b", wantFile: "a", want: settings.BackdropCustom},
		{name: "the remembered one with none stays none", choice: settings.BackdropNone, remove: "a", wantFile: "", want: settings.BackdropNone},
		{name: "the remembered one with forest stays forest", choice: settings.BackdropForest, selectB: true, remove: "b", wantFile: "", want: settings.BackdropForest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.Background()
			b, err := f.store.Import(ctx, f.write(t, "b.png", pngBytes(t, 5, 5)))
			if err != nil {
				t.Fatal(err)
			}
			a, err := f.store.Import(ctx, f.write(t, "a.png", pngBytes(t, 6, 6)))
			if err != nil {
				t.Fatal(err)
			}
			names := map[string]string{"a": a.Name, "b": b.Name, "": ""}
			sel := a.Name
			if tt.selectB {
				sel = b.Name
			}
			if _, err := f.settings.Update(ctx, map[string]string{settings.KeyBackdrop: tt.choice, settings.KeyBackdropFile: sel}); err != nil {
				t.Fatal(err)
			}
			if err := f.store.Remove(ctx, names[tt.remove]); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(f.dir, names[tt.remove])); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("file still there: %v", err)
			}
			if got := f.value(settings.KeyBackdrop); got != tt.want {
				t.Fatalf("backdrop = %q, want %q", got, tt.want)
			}
			if got := f.value(settings.KeyBackdropFile); got != names[tt.wantFile] {
				t.Fatalf("backdrop_file = %q, want %q", got, names[tt.wantFile])
			}
		})
	}
}

func TestRemoveRefuses(t *testing.T) {
	f := newFixture(t)
	outside := f.write(t, "keep.png", pngBytes(t, 2, 2))
	tests := []struct {
		name string
		err  error
	}{
		{"0123456789abcdef0123456789abcdef.png", ErrNotFound},
		{"../src/keep.png", ErrInvalidArgument},
		{outside, ErrInvalidArgument},
		{".import-123", ErrInvalidArgument},
		{"", ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := f.store.Remove(context.Background(), tt.name); !errors.Is(err, tt.err) {
				t.Fatalf("err = %v, want %v", err, tt.err)
			}
		})
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("the file outside was touched: %v", err)
	}
}

func TestRead(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	img := pngBytes(t, 7, 7)
	e, err := f.store.Import(ctx, f.write(t, "a.png", img))
	if err != nil {
		t.Fatal(err)
	}
	outside := f.write(t, "secret.png", pngBytes(t, 3, 3))
	if err := os.Symlink(outside, filepath.Join(f.dir, "link.png")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.dir, "notes.png"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(f.dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		mime string
		err  error
	}{
		{name: e.Name, mime: "image/png"},
		{name: "../src/secret.png", err: ErrInvalidArgument},
		{name: outside, err: ErrInvalidArgument},
		{name: "sub/x.png", err: ErrInvalidArgument},
		{name: ".hidden.png", err: ErrInvalidArgument},
		{name: "link.png", err: ErrNotFound},
		{name: "sub", err: ErrNotFound},
		{name: "missing.png", err: ErrNotFound},
		{name: "notes.png", err: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, mimeType, err := f.store.Read(ctx, tt.name)
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Fatalf("err = %v, want %v", err, tt.err)
				}
				return
			}
			if err != nil || mimeType != tt.mime || !bytes.Equal(data, img) {
				t.Fatalf("read = %d bytes %q %v", len(data), mimeType, err)
			}
		})
	}
}

func TestList(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if got, err := f.store.List(ctx); err != nil || len(got) != 0 {
		t.Fatalf("list before any import = %v, %v", got, err)
	}
	first, err := f.store.Import(ctx, f.write(t, "1.png", pngBytes(t, 10, 5)))
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.store.Import(ctx, f.write(t, "2.jpg", jpegBytes(t, 16, 9)))
	if err != nil {
		t.Fatal(err)
	}
	// The first is older; strays are skipped: a temporary copy, a non-image, a folder.
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(f.dir, first.Name), old, old); err != nil {
		t.Fatal(err)
	}
	for _, stray := range []string{".import-42", "readme.txt"} {
		if err := os.WriteFile(filepath.Join(f.dir, stray), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(f.dir, "dir.png"), 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := f.store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != first.Name || got[1].Name != second.Name {
		t.Fatalf("list = %+v", got)
	}
	if got[1].Width != 16 || got[1].Height != 9 {
		t.Fatalf("jpeg size = %dx%d", got[1].Width, got[1].Height)
	}
}

func TestWebpSize(t *testing.T) {
	vp8x := append([]byte("RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00"), 0, 0, 0, 0, 0x7f, 0x07, 0, 0x37, 0x04, 0, 0, 0, 0, 0, 0, 0)
	vp8 := append([]byte("RIFF\x00\x00\x00\x00WEBPVP8 \x00\x00\x00\x00"), 0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01, 0, 0, 0, 0, 0)
	tests := []struct {
		name string
		in   []byte
		w, h int
	}{
		{"vp8l", webpBytes(300, 200), 300, 200},
		{"vp8x", vp8x, 1920, 1080},
		{"vp8", vp8, 640, 480},
		{"short", []byte("RIFF"), 0, 0},
		{"not webp", pngBytes(t, 2, 2), 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if w, h := webpSize(tt.in); w != tt.w || h != tt.h {
				t.Fatalf("webpSize = %dx%d, want %dx%d", w, h, tt.w, tt.h)
			}
		})
	}
}

// With its image removed, custom is refused until one is added again, and the import
// selects it.
func TestCustomNeedsAnImage(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	a, err := f.store.Import(ctx, f.write(t, "a.png", pngBytes(t, 4, 4)))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.Remove(ctx, a.Name); err != nil {
		t.Fatal(err)
	}
	for _, partial := range []map[string]string{
		{settings.KeyBackdrop: settings.BackdropCustom},
		{settings.KeyBackdrop: settings.BackdropCustom, settings.KeyBackdropFile: a.Name},
	} {
		var ve *settings.ValidationError
		if _, err := f.settings.Update(ctx, partial); !errors.As(err, &ve) {
			t.Fatalf("Update(%v) = %v, want a ValidationError", partial, err)
		}
	}
	if f.value(settings.KeyBackdrop) != settings.BackdropForest {
		t.Fatalf("backdrop = %q, want forest", f.value(settings.KeyBackdrop))
	}
	if _, err := f.store.Import(ctx, f.write(t, "a.png", pngBytes(t, 4, 4))); err != nil {
		t.Fatal(err)
	}
	if f.value(settings.KeyBackdrop) != settings.BackdropCustom || f.value(settings.KeyBackdropFile) != a.Name {
		t.Fatalf("after re-adding: %q %q", f.value(settings.KeyBackdrop), f.value(settings.KeyBackdropFile))
	}
}
