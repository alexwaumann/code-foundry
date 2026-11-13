package command

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// view.open.gallery (view.panel.gallery): a set of images in a tab beside a thread, as a grid that opens one image
// over a filmstrip (docs/notes/gallery-surface.md). The verb is the only way in: no palette
// entry, no button. The tab is keyed by its title, so opening a title again updates that tab.
//
// The images travel as one JSON value, the way a caption stays with its image: a repeatable
// flag's values are joined by newlines, so two of them would lose the pairing at the first
// image without a caption, and a newline in a caption would start another image.

// A Gallery tab's params: title, images (a JSON list of galleryImage), project and base (the
// thread's project and checkout, which relative paths read against).

const (
	// maxGalleryImages is the most images in a gallery. Tiles are virtualized, so it is not
	// the grid's limit but the tab's: the list lives in the tab's params, which the panel
	// keeps in the window's local storage.
	maxGalleryImages = 200
	// maxGalleryPath is the longest path, in bytes: macOS's PATH_MAX. A failed image keeps its
	// path in the tab's params, so this, with the count, bounds what a tab can store.
	maxGalleryPath = 1024
	// maxGalleryCaption is the longest caption, in characters: a line under a tile.
	maxGalleryCaption = 200
	// maxGalleryTitle is the longest title, in characters: a tab's name.
	maxGalleryTitle = 80
	// maxGalleryWarnings is how many images that will not show are named one by one.
	maxGalleryWarnings = 5
)

// galleryEntry is one image as a caller gives it in --images.
type galleryEntry struct {
	Path    string `json:"path"`
	Caption string `json:"caption"`
}

// galleryImage is one image as the Gallery tab takes it (surfaces/galleryTarget.ts).
type galleryImage struct {
	Path    string `json:"path"`
	Caption string `json:"caption,omitempty"`
	// Stamp is the file's modification time in unix milliseconds, 0 for one that will not
	// show. It is what makes an image rewritten at the same path load again on a re-open.
	Stamp int64 `json:"stamp,omitempty"`
}

// panelGalleryCommand is view.open.gallery.
func (d ViewDeps) panelGalleryCommand() Command {
	return Command{
		Name:      "view.open.gallery",
		Page:      PageState,
		NoPalette: true,
		Title:     "Open Images Tab",
		Description: "Open a set of images in a Gallery tab " + openLead +
			"a grid of captioned images, each opening large over a filmstrip. Opening the same --title again updates that tab. " +
			"An image that cannot be shown warns and stays as a failed tile; refused when none can.",
		Category:     "View",
		NoKeybinding: true,
		When:         hasThread,
		Args: []ArgSpec{
			{Name: "title", Type: String, Required: true,
				Description: fmt.Sprintf("The tab's title, at most %d characters; the same title updates the same tab", maxGalleryTitle)},
			{Name: "images", Type: String, Required: true, FileOrStdin: true,
				Description: fmt.Sprintf(`The images in order, a JSON array: [{"path":"/tmp/a.png","caption":"Before"},{"path":"b.png"}] (-: stdin, @file: a file). `+
					"Each path is absolute, ~/…, or relative to the thread's checkout, under the home directory or in a temp folder (/tmp, $TMPDIR). "+
					"At most %d images; a caption is optional, at most %d characters", maxGalleryImages, maxGalleryCaption)},
			openThreadArg, openFocusArg, openPaneArg,
		},
		Run: d.runPanelGallery,
	}
}

func (d ViewDeps) runPanelGallery(ctx context.Context, uctx Context, a Args) (Result, error) {
	id := a.String("thread")
	if id == "" {
		return Result{}, InvalidArg("thread", "needs a thread whose tab to open (--thread, or run it inside a thread)")
	}
	var warnings []string
	res, err := d.showItem(ctx, uctx, a, id, tabGallery, func(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
		params, failed, err := d.galleryCheck(ctx, t, a)
		warnings = failed
		return params, err
	})
	if err != nil {
		return Result{}, err
	}
	res.Warnings = warnings
	return res, nil
}

// galleryCheck is view.open.gallery's check: the arguments are good and at least one image
// can show. The rest are warnings, not a refusal: their tiles say what went wrong, and a
// thread can fix one path without losing the others.
func (d ViewDeps) galleryCheck(ctx context.Context, t *v1.Thread, a Args) (map[string]string, []string, error) {
	title := plainNote(a.String("title"))
	if title == "" {
		return nil, nil, InvalidArg("title", "needs a title: the tab's name")
	}
	if n := utf8.RuneCountInString(title); n > maxGalleryTitle {
		return nil, nil, InvalidArg("title", "%d characters, at most %d: it names a tab", n, maxGalleryTitle)
	}
	entries, err := parseGalleryImages(a.String("images"))
	if err != nil {
		return nil, nil, err
	}
	base := t.GetWorktreePath()
	images := make([]galleryImage, 0, len(entries))
	var failed []string
	for _, e := range entries {
		img, why, err := d.galleryRead(ctx, base, e)
		if err != nil {
			return nil, nil, err
		}
		if why != "" {
			failed = append(failed, fmt.Sprintf("%s: %s", e.Path, why))
		}
		images = append(images, img)
	}
	if len(failed) == len(images) {
		return nil, nil, InvalidArg("images", "none of the %d images can be shown: %s", len(images), strings.Join(galleryWarnings(failed), "; "))
	}
	list, err := json.Marshal(images)
	if err != nil {
		return nil, nil, fmt.Errorf("gallery images: %w", err)
	}
	return map[string]string{"title": title, "images": string(list), "project": t.GetProjectId(), "base": base}, galleryWarnings(failed), nil
}

// galleryRead looks at one image where the tab will read it, so the file viewer's roots are
// the gallery's: it gets the image as the tab takes it, and why it will not show ("" when it
// will). Only a cancelled call is an error.
func (d ViewDeps) galleryRead(ctx context.Context, base string, e galleryEntry) (galleryImage, string, error) {
	img := galleryImage{Path: e.Path, Caption: e.Caption}
	res, err := d.Files.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{BaseDir: base, Path: e.Path, MaxBytes: 1}))
	if ctx.Err() != nil {
		return img, "", ctx.Err()
	}
	if err != nil {
		var ce *connect.Error
		if errors.As(err, &ce) {
			return img, strings.TrimPrefix(ce.Message(), "invalid argument: "), nil
		}
		return img, err.Error(), nil
	}
	f := res.Msg
	if p := f.GetResolvedPath(); p != "" {
		img.Path = p
	}
	switch {
	case f.GetNotFound():
		return img, "no such file", nil
	case f.GetIsDir():
		return img, "a directory, not an image", nil
	case !strings.HasPrefix(f.GetMimeType(), "image/"):
		return img, "not an image (" + f.GetMimeType() + ")", nil
	case f.GetSize() > galleryReadLimit(f.GetMimeType()):
		return img, "larger than the " + strconv.FormatInt(galleryReadLimit(f.GetMimeType())>>20, 10) + " MiB the tab reads", nil
	}
	img.Stamp = f.GetModifiedAt()
	return img, "", nil
}

// galleryReadLimit is the most of an image the tab can read: ReadFile counts an SVG as text.
func galleryReadLimit(mime string) int64 {
	if fsx.TextMIME(mime) {
		return fsx.MaxReadBytes
	}
	return fsx.MaxBinaryReadBytes
}

// galleryWarnings names the first few images that will not show and counts the rest.
func galleryWarnings(failed []string) []string {
	if len(failed) <= maxGalleryWarnings {
		return failed
	}
	return append(failed[:maxGalleryWarnings:maxGalleryWarnings], fmt.Sprintf("and %d more images that cannot be shown", len(failed)-maxGalleryWarnings))
}

// parseGalleryImages reads --images: a non-empty JSON array of entries, each with a path, its
// caption cleaned as model text. An unknown field is refused, since a "file" or a "label" would
// otherwise lose the image or its caption without a word.
func parseGalleryImages(raw string) ([]galleryEntry, error) {
	const shape = `want a JSON array like [{"path":"/tmp/a.png","caption":"Before"}]`
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.DisallowUnknownFields()
	var entries []galleryEntry
	if err := dec.Decode(&entries); err != nil {
		return nil, InvalidArg("images", "%s: %v", shape, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, InvalidArg("images", "%s: there is more after the array", shape)
	}
	if len(entries) == 0 {
		return nil, InvalidArg("images", "%s: it is empty", shape)
	}
	if len(entries) > maxGalleryImages {
		return nil, InvalidArg("images", "%d images, at most %d: show the ones that matter, or split them over two titles", len(entries), maxGalleryImages)
	}
	for i := range entries {
		e := &entries[i]
		e.Path = strings.TrimSpace(e.Path)
		if e.Path == "" {
			return nil, InvalidArg("images", "image %d has no path: %s", i+1, shape)
		}
		if len(e.Path) > maxGalleryPath {
			return nil, InvalidArg("images", "image %d's path has %d bytes, at most %d", i+1, len(e.Path), maxGalleryPath)
		}
		e.Caption = plainNote(e.Caption)
		if n := utf8.RuneCountInString(e.Caption); n > maxGalleryCaption {
			return nil, InvalidArg("images", "image %d's caption has %d characters, at most %d: a line under a tile", i+1, n, maxGalleryCaption)
		}
	}
	return entries, nil
}
