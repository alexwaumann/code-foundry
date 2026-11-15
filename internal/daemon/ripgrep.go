package daemon

import (
	"context"
	"log/slog"

	"github.com/alexwaumann/code-foundry/internal/ripgrep"
)

// checkRipgrep finds and runs the ripgrep that text search will use
// (docs/notes/file-search-3-ripgrep.md) and logs the outcome once at startup: there is
// no helper-health surface to report to, and a search reports ripgrep.ErrMissing or
// ErrBroken itself. It runs off the startup path; ctx bounds it.
func checkRipgrep(ctx context.Context, log *slog.Logger) {
	go func() {
		bin, err := ripgrep.Find()
		if err != nil {
			log.Warn("text search engine", "err", err)
			return
		}
		v, err := bin.Check(ctx)
		switch {
		case err != nil:
			log.Warn("text search engine", "path", bin.Path, "err", err)
		case bin.Source == ripgrep.SourceBundled && v != ripgrep.Version:
			log.Warn("text search engine", "path", bin.Path, "version", v, "want", ripgrep.Version)
		default:
			log.Debug("text search engine", "path", bin.Path, "source", bin.Source, "version", v)
		}
	}()
}
