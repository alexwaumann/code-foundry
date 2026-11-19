package fsxtest

import (
	"os"
	"path/filepath"
	"testing"
)

// Accented names in both Unicode forms: Finder stores a name NFD, Claude types it NFC.
const (
	ResumeNFD = "Re\u0301sume\u0301"
	ResumeNFC = "R\u00e9sum\u00e9"
)

// Insensitive reports whether dir's volume ignores letter case and Unicode normalisation
// (APFS and HFS+ by default), where one file answers to several spellings.
func Insensitive(t testing.TB, dir string) bool {
	t.Helper()
	probe := filepath.Join(dir, "Probe-"+ResumeNFD)
	if err := os.WriteFile(probe, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(probe) }()
	for _, other := range []string{"probe-" + ResumeNFD, "Probe-" + ResumeNFC} {
		if _, err := os.Stat(filepath.Join(dir, other)); err != nil {
			return false
		}
	}
	return true
}

// NeedInsensitive skips the test unless dir's volume is Insensitive.
func NeedInsensitive(t testing.TB, dir string) {
	t.Helper()
	if !Insensitive(t, dir) {
		t.Skipf("%s keeps case or Unicode forms apart", dir)
	}
}
