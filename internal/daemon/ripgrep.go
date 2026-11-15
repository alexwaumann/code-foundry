package daemon

import (
	"log/slog"

	"github.com/alexwaumann/code-foundry/internal/ripgrep"
)

// checkRipgrep finds and runs the ripgrep that text search will use
// (docs/notes/file-search-3-ripgrep.md) and logs the outcome once at startup: there is
// no helper-health surface to report to, and a search reports ripgrep.ErrMissing or
// ErrBroken itself. It runs off the startup path. engine keeps the outcome, so the first
// search does not look again.
func checkRipgrep(log *slog.Logger, engine *ripgrep.Engine) {
	go func() {
		bin, v, err := engine.Get()
		switch {
		case err != nil && bin.Path == "":
			log.Warn("text search engine", "err", err)
		case err != nil:
			log.Warn("text search engine", "path", bin.Path, "err", err)
		case bin.Source == ripgrep.SourceBundled && v != ripgrep.Version:
			log.Warn("text search engine", "path", bin.Path, "version", v, "want", ripgrep.Version)
		default:
			log.Debug("text search engine", "path", bin.Path, "source", bin.Source, "version", v)
		}
	}()
}
