package fsx

import (
	"os"
	"path/filepath"
	"slices"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// OnDiskPath is real, a clean absolute path with its symlinks resolved, spelled as its
// volume stores it: each name as its directory lists it. APFS and HFS+ ignore case and
// Unicode normalisation by default, so one file answers to /Users/me/Case/Report.html,
// …/case/report.html, and an NFC spelling of a name Finder stored NFD; EvalSymlinks keeps
// whichever it was given. Anything keyed by a file's path keys it by this, so every
// spelling of the file is one key. A name its directory lists exactly is kept as it is, so
// a case-sensitive volume's Plan.html and plan.html stay two files; so is a name whose
// directory cannot be listed, or that matches no listed one. A part that is a hard link's
// other name is not looked for: that is another spelling only by inode, not by name.
func OnDiskPath(real string) string {
	if !filepath.IsAbs(real) {
		return real
	}
	real = filepath.Clean(real)
	out := "/"
	for name := range strings.SplitSeq(strings.TrimPrefix(real, "/"), "/") {
		if name == "" {
			continue
		}
		out = filepath.Join(out, onDiskName(out, name))
	}
	return out
}

// onDiskName is name, a file in dir, as dir lists it: name itself when listed, else the
// listed name that is the same file and equal but for case and normalisation.
func onDiskName(dir, name string) string {
	f, err := os.Open(dir)
	if err != nil {
		return name
	}
	names, _ := f.Readdirnames(-1)
	_ = f.Close()
	if slices.Contains(names, name) {
		return name
	}
	var given os.FileInfo
	for _, n := range names {
		if !SameSpelling(n, name) {
			continue
		}
		if given == nil {
			if given, err = os.Lstat(filepath.Join(dir, name)); err != nil {
				return name
			}
		}
		if fi, err := os.Lstat(filepath.Join(dir, n)); err == nil && os.SameFile(fi, given) {
			return n
		}
	}
	return name
}

// SameSpelling reports whether a and b are equal but for letter case and Unicode
// normalisation (NFC or NFD): two spellings a case- and normalisation-insensitive volume
// takes for one name. Whether they are one file there is os.SameFile's to say.
func SameSpelling(a, b string) bool {
	return a == b || strings.EqualFold(norm.NFC.String(a), norm.NFC.String(b))
}

// OtherSpelling reports whether p is another spelling of the file at real (its on-disk
// path, OnDiskPath): not real itself, equal to it but for case and normalisation
// (SameSpelling), and the same file. A key stored under p before keys were on-disk
// spellings is real's.
func OtherSpelling(p, real string) bool {
	if p == real || !SameSpelling(p, real) {
		return false
	}
	a, err := os.Stat(p)
	if err != nil {
		return false
	}
	b, err := os.Stat(real)
	return err == nil && os.SameFile(a, b)
}

// LikeSpellings is a SQLite LIKE pattern (ESCAPE '\') every SameSpelling of real
// matches, and few other paths: real's ASCII prefix up to the character before its first
// other byte (an NFD é is "e" and a mark, its NFC form one other character), then "%".
// LIKE ignores ASCII case, so an all-ASCII real's pattern matches it in any case.
func LikeSpellings(real string) string {
	i := strings.IndexFunc(real, func(r rune) bool { return r >= 0x80 })
	if i < 0 {
		return likeEscape(real)
	}
	if i > 0 {
		i--
	}
	return likeEscape(real[:i]) + "%"
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
