package preview

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// openFlags opens without blocking: what is there may be a FIFO by the time it is opened.
const openFlags = os.O_RDONLY | syscall.O_NONBLOCK

// open opens the regular file rel names under e and says where it really is, or fails with
// ErrNotExist or a read error, each a 404. A temp grant goes by what it opened (openTemp). A
// home grant may check first and open after: nobody else can swap a file under home.
func open(floor Floor, e entry, rel string) (*os.File, string, error) {
	if floor.inTemp(e.dir) {
		return openTemp(floor, e, rel)
	}
	real, err := resolve(floor, e.dir, rel)
	if err != nil {
		return nil, "", err
	}
	f, err := os.OpenFile(real, openFlags, 0)
	if err != nil {
		return nil, "", err
	}
	return f, real, nil
}

// resolve maps a request path to the regular file it names under dir, or ErrNotExist. The file
// must be under home: only a grant in a temp folder serves what lies in one, so a link from
// home into temp, which anything can repoint, is no way to give temp's bytes a home page's URL.
func resolve(floor Floor, dir, rel string) (string, error) {
	clean := path.Clean("/" + rel)
	p := filepath.Join(dir, filepath.FromSlash(clean))
	if !fsx.Within(dir, p) {
		return "", fs.ErrNotExist
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	if !fsx.Within(floor.home, real) || floor.Guarded(real) {
		return "", fs.ErrNotExist
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if fi.IsDir() {
		return resolve(floor, dir, path.Join(clean, "index.html"))
	}
	if !fi.Mode().IsRegular() {
		return "", fs.ErrNotExist
	}
	return real, nil
}

// openTemp is open for a grant in a temp folder, where anything on the machine can swap a name
// for a link or a FIFO between a check and a read. So it opens first, and every check is on
// the file it holds:
//
//   - The tree is reached without following a link (fsx.OpenTree) and the file through a Root
//     on it, so no link planted or swapped in leads out of the tree. The Root does not follow
//     a link with an absolute target, even one that stays inside.
//   - A one-file grant serves the file at its name and nothing a link there leads to.
//   - The file must be regular once open.
//   - The Floor speaks of paths, so the file's real path must lead to the open file before the
//     Floor is asked. A config home below the tree stays guarded that way.
//
// Anything refused is ErrNotExist: it may be a stranger's doing, so it is not worth a log line.
func openTemp(floor Floor, e entry, rel string) (*os.File, string, error) {
	root, err := fsx.OpenTree(floor.roots().TempRoot(e.dir), e.dir)
	if err != nil {
		return nil, "", fs.ErrNotExist
	}
	defer func() { _ = root.Close() }()
	name := strings.TrimPrefix(path.Clean("/"+rel), "/")
	if name == "" {
		name = "."
	}
	f, fi, err := openIn(root, name)
	if err == nil && fi.IsDir() && e.file == "" {
		_ = f.Close()
		name = path.Join(name, "index.html")
		f, fi, err = openIn(root, name)
	}
	if err != nil {
		return nil, "", fs.ErrNotExist
	}
	real, ok := "", fi.Mode().IsRegular() && (e.file == "" || atName(root, name, fi))
	if ok {
		real, ok = realOf(floor, filepath.Join(e.dir, filepath.FromSlash(name)), fi)
	}
	if !ok {
		_ = f.Close()
		return nil, "", fs.ErrNotExist
	}
	return f, real, nil
}

// openIn opens name in root and stats what it opened.
func openIn(root *os.Root, name string) (*os.File, fs.FileInfo, error) {
	f, err := root.OpenFile(name, openFlags, 0)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	return f, fi, nil
}

// atName reports whether the file fi is at name itself, not behind a link there. A Root
// follows links, so this is asked after the open: a link swapped for a file since then is a
// different file.
func atName(root *os.Root, name string, fi fs.FileInfo) bool {
	at, err := root.Lstat(name)
	return err == nil && at.Mode().IsRegular() && os.SameFile(at, fi)
}

// realOf is where p leads, if that is the open file fi and the Floor does not guard it.
func realOf(floor Floor, p string, fi fs.FileInfo) (string, bool) {
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", false
	}
	at, err := os.Stat(real)
	if err != nil || !os.SameFile(at, fi) || floor.Guarded(real) {
		return "", false
	}
	return real, true
}
