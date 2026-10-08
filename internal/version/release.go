package version

import "os"

// ReleaseRepo is the "owner/name" GitHub repository whose releases this build updates
// from. Set at build time with
// -ldflags "-X github.com/awaumann/code-foundry/internal/version.ReleaseRepo=owner/name"
// (`make package` passes RELEASE_REPO). Empty in dev builds.
var ReleaseRepo = ""

// Environment overrides for the updater and the installer (scripts/install.sh reads the
// same names).
const (
	// EnvReleaseRepo overrides ReleaseRepo.
	EnvReleaseRepo = "CODE_FOUNDRY_RELEASE_REPO"
	// EnvReleaseDir points the updater and the installer at a local directory laid out
	// like the release repository instead of GitHub: a "latest" file holding the latest
	// tag, and one directory per tag holding that release's assets. For testing.
	EnvReleaseDir = "CODE_FOUNDRY_RELEASE_DIR"
)

// Repo returns the release repository: $CODE_FOUNDRY_RELEASE_REPO, else ReleaseRepo.
func Repo() string {
	if r := os.Getenv(EnvReleaseRepo); r != "" {
		return r
	}
	return ReleaseRepo
}

// ReleaseDir returns $CODE_FOUNDRY_RELEASE_DIR (empty when unset).
func ReleaseDir() string { return os.Getenv(EnvReleaseDir) }
