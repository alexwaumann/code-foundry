package registry

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// MaxManifestBytes bounds the plugin.json ReadManifest reads.
const MaxManifestBytes = 1 << 20

// ReadManifest reads plugin.json out of a release tarball without unpacking the rest:
// the update check of a plugin installed from a GitHub release reads its newest
// release's minHostVersion this way (a release has no index entry to say it). The
// names are cleaned as Extract cleans them; the decompressed bytes are bounded the same.
func ReadManifest(tarball string) ([]byte, error) {
	f, err := os.Open(tarball)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("read manifest: not a gzip file: %w", err)
	}
	defer func() { _ = gz.Close() }()
	tr := tar.NewReader(&capReader{r: gz, max: maxDecompressed})
	for n := 0; n < MaxEntries; n++ {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read manifest: %w", err)
		}
		name, err := entryName(h.Name)
		if err != nil || name != pluginsdk.ManifestFile || h.Typeflag != tar.TypeReg {
			continue
		}
		if h.Size > MaxManifestBytes {
			return nil, fmt.Errorf("read manifest: %s is larger than %d bytes", pluginsdk.ManifestFile, MaxManifestBytes)
		}
		return io.ReadAll(io.LimitReader(tr, MaxManifestBytes))
	}
	return nil, fmt.Errorf("read manifest: the tarball has no %s", pluginsdk.ManifestFile)
}
