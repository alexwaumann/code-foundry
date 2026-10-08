package update

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// BundleName is the app bundle's directory name.
const BundleName = "CodeFoundry.app"

// BundleOf returns the .app bundle that contains the executable at exe (its
// Contents/MacOS directory), or "" when exe is not inside a bundle.
func BundleOf(exe string) string {
	dir := filepath.Dir(filepath.Clean(exe))
	if filepath.Base(dir) != "MacOS" {
		return ""
	}
	contents := filepath.Dir(dir)
	if filepath.Base(contents) != "Contents" {
		return ""
	}
	bundle := filepath.Dir(contents)
	if !strings.HasSuffix(bundle, ".app") {
		return ""
	}
	return bundle
}

// RunningBundle returns the bundle containing the running executable (symlinks
// resolved: ~/.local/bin/code-foundry points into the bundle), or "".
func RunningBundle() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return BundleOf(exe)
}

var (
	plistCodeFoundryVersion = regexp.MustCompile(`<key>CodeFoundryVersion</key>\s*<string>([^<]*)</string>`)
	plistShortVersion       = regexp.MustCompile(`<key>CFBundleShortVersionString</key>\s*<string>([^<]*)</string>`)
)

// BundleVersion reads the version a bundle on disk was built as: Info.plist's
// CodeFoundryVersion (the full tag, written by `make package`), else
// "v" + CFBundleShortVersionString.
func BundleVersion(bundle string) (string, error) {
	b, err := os.ReadFile(filepath.Join(bundle, "Contents", "Info.plist"))
	if err != nil {
		return "", fmt.Errorf("read bundle version: %w", err)
	}
	if m := plistCodeFoundryVersion.FindSubmatch(b); m != nil {
		return strings.TrimSpace(string(m[1])), nil
	}
	if m := plistShortVersion.FindSubmatch(b); m != nil {
		return "v" + strings.TrimSpace(string(m[1])), nil
	}
	return "", fmt.Errorf("read bundle version: no version in %s", filepath.Join(bundle, "Contents", "Info.plist"))
}

// installedVersion is the default Options.InstalledVersion: the version of the bundle
// the running binary lives in, re-read from disk ("" when not running from a bundle).
func installedVersion() (string, error) {
	b := RunningBundle()
	if b == "" {
		return "", nil
	}
	return BundleVersion(b)
}
