package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// FinderBundleID is Finder's bundle id. AppIcons always knows where Finder is; every
// other id must be a detected editor (EditorApps).
const FinderBundleID = "com.apple.finder"

// finderApp is Finder's bundle.
const finderApp = "/System/Library/CoreServices/Finder.app"

// AppIconSize is the edge in pixels of the square PNGs AppIcons returns.
const AppIconSize = 64

// maxAppIconBytes bounds one rasterised icon; a bigger file is not an icon at this size.
const maxAppIconBytes = 1 << 20

// appIconTimeout bounds reading one bundle's icon (plutil and sips).
const appIconTimeout = 10 * time.Second

// errNoIcon: the bundle names no icon file (an asset-catalog-only app).
var errNoIcon = errors.New("the bundle names no icon file")

// pngMagic starts every PNG file.
var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// iconEnv is what icon reading runs; tests fake it so they never shell out.
type iconEnv struct {
	// finder is Finder's bundle.
	finder string
	// plistString reads a string key of a property list file.
	plistString func(ctx context.Context, plist, key string) (string, error)
	// rasterise renders an .icns file as a PNG at most size pixels wide and high.
	rasterise func(ctx context.Context, icns string, size int) ([]byte, error)
}

func systemIconEnv() iconEnv {
	return iconEnv{finder: finderApp, plistString: plutilString, rasterise: sipsPNG}
}

// plutilString reads key of plist with /usr/bin/plutil (XML and binary plists alike).
func plutilString(ctx context.Context, plist, key string) (string, error) {
	out, err := exec.CommandContext(ctx, "/usr/bin/plutil", "-extract", key, "raw", "-o", "-", plist).Output()
	if err != nil {
		return "", fmt.Errorf("read %s of %s: %w", key, plist, err)
	}
	return strings.TrimSpace(string(out)), nil
}

// sipsPNG rasterises icns with /usr/bin/sips into a temporary file and returns its bytes.
func sipsPNG(ctx context.Context, icns string, size int) ([]byte, error) {
	dir, err := os.MkdirTemp("", "cf-appicon-")
	if err != nil {
		return nil, fmt.Errorf("make a temporary directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	out := filepath.Join(dir, "icon.png")
	cmd := exec.CommandContext(ctx, "/usr/bin/sips", "-s", "format", "png", "--resampleHeightWidthMax", strconv.Itoa(size), icns, "--out", out)
	if msg, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("sips %s: %w: %s", icns, err, strings.TrimSpace(string(msg)))
	}
	b, err := os.ReadFile(out)
	if err != nil {
		return nil, fmt.Errorf("read the rasterised icon: %w", err)
	}
	return b, nil
}

// readAppIcon reads app's icon as a PNG: the Info.plist's CFBundleIconFile (".icns"
// added when it has no extension) under Contents/Resources, rasterised at AppIconSize.
func readAppIcon(ctx context.Context, env iconEnv, app string) ([]byte, error) {
	name, err := env.plistString(ctx, filepath.Join(app, "Contents", "Info.plist"), "CFBundleIconFile")
	if err != nil {
		return nil, fmt.Errorf("read the icon name: %w", err)
	}
	if name == "" {
		return nil, errNoIcon
	}
	// A bare name stays inside Contents/Resources.
	if name != filepath.Base(name) || name == "." || name == ".." {
		return nil, fmt.Errorf("icon name %q is not a file name: %w", name, errNoIcon)
	}
	if !strings.EqualFold(filepath.Ext(name), ".icns") {
		name += ".icns"
	}
	icns := filepath.Join(app, "Contents", "Resources", name)
	if fi, err := os.Stat(icns); err != nil {
		return nil, fmt.Errorf("icon file: %w", err)
	} else if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("icon file %s is not a regular file: %w", icns, errNoIcon)
	}
	png, err := env.rasterise(ctx, icns, AppIconSize)
	if err != nil {
		return nil, fmt.Errorf("rasterise the icon: %w", err)
	}
	if !bytes.HasPrefix(png, pngMagic) || len(png) > maxAppIconBytes {
		return nil, fmt.Errorf("rasterised %s is not a PNG of at most %d bytes: %w", icns, maxAppIconBytes, errNoIcon)
	}
	return png, nil
}

// appIcons caches icons by bundle id; a nil value records an app without one. Cleared
// when editor detection runs again.
type appIcons struct {
	mu   sync.Mutex
	byID map[string][]byte
}

func (c *appIcons) clear() {
	c.mu.Lock()
	c.byID = nil
	c.mu.Unlock()
}

// AppIcons implements Store: the icons of Finder and the detected editors, read from
// their bundles on first ask and cached until detection runs again. An unknown id, or
// an app whose icon cannot be read, is absent from the result.
func (m *Manager) AppIcons(ctx context.Context, bundleIDs []string) map[string][]byte {
	env := systemIconEnv()
	if m.opts.iconEnv != nil {
		env = *m.opts.iconEnv
	}
	// Resolve the bundles first: EditorApps takes its own lock, never under the icons'.
	paths := make(map[string]string, len(bundleIDs))
	var apps []EditorApp
	detected := false
	for _, id := range bundleIDs {
		if _, ok := paths[id]; ok || id == "" {
			continue
		}
		if id == FinderBundleID {
			paths[id] = env.finder
			continue
		}
		if !detected {
			apps, detected = m.EditorApps(ctx, false), true
		}
		for _, a := range apps {
			if a.BundleID == id {
				paths[id] = a.Path
				break
			}
		}
	}

	out := make(map[string][]byte, len(paths))
	// One lock for the reads too: a second batch asking for the same app waits for the
	// first's result instead of rasterising it again.
	m.icons.mu.Lock()
	defer m.icons.mu.Unlock()
	if m.icons.byID == nil {
		m.icons.byID = map[string][]byte{}
	}
	for id, path := range paths {
		png, ok := m.icons.byID[id]
		if !ok {
			// The read outlives the request: a cancelled one must not cache "no icon".
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), appIconTimeout)
			var err error
			png, err = readAppIcon(rctx, env, path)
			cancel()
			if err != nil {
				m.log.Debug("no app icon", "bundle_id", id, "app", path, "err", err)
				png = nil
			}
			m.icons.byID[id] = png
		}
		if png != nil {
			out[id] = png
		}
	}
	return out
}
