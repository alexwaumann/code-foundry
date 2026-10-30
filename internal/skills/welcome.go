package skills

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// WelcomeFile is the first-run tutorial page's name in the pages root (paths.Paths.Pages):
// PlaceWelcome writes it there, beside the threads' directories, so a first run's prompt
// can name one fixed path (docs/notes/welcome-page.md).
const WelcomeFile = "welcome.html"

// welcomeSource is the page in the embedded pages skill, the one source of both the copy
// threads read beside welcome.md and the file PlaceWelcome writes.
const welcomeSource = staticRoot + "/" + Pages + "/reference/" + WelcomeFile

// WelcomePath is where PlaceWelcome puts the page under pagesRoot.
func WelcomePath(pagesRoot string) string { return filepath.Join(pagesRoot, WelcomeFile) }

// PlaceWelcome writes the build's welcome page to pagesRoot/WelcomeFile, creating
// pagesRoot when missing, and reports whether it wrote: a file that already holds the
// same bytes is left alone (so a page open in a panel does not reload at every start),
// anything else there (an older build's page, a user's edit) is replaced through a
// temporary file, so a reader sees the old page or the new one.
func PlaceWelcome(pagesRoot string) (bool, error) {
	if pagesRoot == "" {
		return false, errors.New("skills: no pages directory for the welcome page")
	}
	b, err := static.ReadFile(welcomeSource)
	if err != nil {
		return false, fmt.Errorf("skills: read embedded %s: %w", welcomeSource, err)
	}
	dst := WelcomePath(pagesRoot)
	if old, err := os.ReadFile(dst); err == nil && bytes.Equal(old, b) {
		return false, nil
	}
	if err := os.MkdirAll(pagesRoot, 0o700); err != nil {
		return false, fmt.Errorf("skills: create %s: %w", pagesRoot, err)
	}
	if err := writeAtomic(dst, b); err != nil {
		return false, err
	}
	return true, nil
}
