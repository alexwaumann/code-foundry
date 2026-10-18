package registry

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Limits on a release tarball's content.
const (
	MaxUnpackedBytes = 512 << 20
	MaxEntries       = 10000
)

// ErrHashMismatch: a download's SHA-256 is not the one the index or checksums name.
var ErrHashMismatch = errors.New("sha256 mismatch")

// SHA256File returns the file's SHA-256 in lowercase hex.
func SHA256File(file string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Verify checks the file's SHA-256 against want (hex, any case).
func Verify(file, want string) error {
	got, err := SHA256File(file)
	if err != nil {
		return fmt.Errorf("verify: %w", err)
	}
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("%w: got %s, want %s", ErrHashMismatch, got, strings.ToLower(want))
	}
	return nil
}

// Extract unpacks a .tar.gz into dir (which must exist and be empty). The tarball holds
// the package directory's contents at its root (plugin.json, bin/…), optionally under
// "./". Only directories and regular files are allowed, nothing outside dir (no absolute
// names, no ".."), no links or devices; modes keep their executable bits and lose
// everything but 0755. Limits: MaxEntries entries, MaxUnpackedBytes in all.
func Extract(tarball, dir string) error {
	f, err := os.Open(tarball)
	if err != nil {
		return fmt.Errorf("extract: %w", err)
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("extract: not a gzip file: %w", err)
	}
	defer func() { _ = gz.Close() }()
	tr := tar.NewReader(gz)
	var total int64
	seen := map[string]bool{}
	for n := 0; ; n++ {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("extract: %w", err)
		}
		if n >= MaxEntries {
			return fmt.Errorf("extract: more than %d entries", MaxEntries)
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		name, err := entryName(h.Name)
		if err != nil {
			return fmt.Errorf("extract: %w", err)
		}
		if name == "" {
			continue // "./"
		}
		if seen[name] {
			return fmt.Errorf("extract: %s appears twice", name)
		}
		seen[name] = true
		dst := filepath.Join(dir, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return fmt.Errorf("extract: %w", err)
			}
		case tar.TypeReg:
			total += h.Size
			if h.Size < 0 || total > MaxUnpackedBytes {
				return fmt.Errorf("extract: more than %d bytes unpacked", MaxUnpackedBytes)
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return fmt.Errorf("extract: %w", err)
			}
			mode := os.FileMode(0o644)
			if h.FileInfo().Mode().Perm()&0o111 != 0 {
				mode = 0o755
			}
			if err := writeEntry(dst, tr, h.Size, mode); err != nil {
				return fmt.Errorf("extract %s: %w", name, err)
			}
		default:
			return fmt.Errorf("extract: %s is not a file or directory (type %q): links and devices are not allowed", name, h.Typeflag)
		}
	}
}

// entryName cleans a tar entry name and refuses one that leaves the root.
func entryName(raw string) (string, error) {
	if strings.Contains(raw, `\`) {
		return "", fmt.Errorf("%q: backslash in name", raw)
	}
	if strings.HasPrefix(raw, "/") {
		return "", fmt.Errorf("%q: absolute name", raw)
	}
	c := path.Clean(raw)
	if c == "." {
		return "", nil
	}
	if c == ".." || strings.HasPrefix(c, "../") {
		return "", fmt.Errorf("%q leaves the package directory", raw)
	}
	return c, nil
}

func writeEntry(dst string, r io.Reader, size int64, mode os.FileMode) error {
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(r, size))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n != size {
		err = io.ErrUnexpectedEOF
	}
	if err != nil {
		return err
	}
	// The umask may have narrowed the mode.
	return os.Chmod(dst, mode)
}
