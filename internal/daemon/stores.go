package daemon

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"

	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/db"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/store/gh"
	"github.com/awaumann/code-foundry/internal/store/repo"
	"github.com/awaumann/code-foundry/internal/store/session"
	"github.com/awaumann/code-foundry/internal/store/terminal"
)

// stores is the daemon's shared infrastructure (bus, database) and its stores. Each
// store gets one field here and one line in openStores and close.
type stores struct {
	bus  *bus.Bus
	db   *sql.DB
	repo *repo.Git
	gh   *gh.Store
	// stopGh cancels the gh poller and the repo→gh tracking glue, and waits for both.
	stopGh func()
	// terminal owns PTYs; closed first so every child gets hung up before the db goes.
	terminal *terminal.Manager
	// session layers Claude sessions on terminal and db; shut down before terminal so
	// live sessions are recorded as disconnected while their processes still run.
	session *session.Manager
}

// openStores opens the database, applies migrations, and starts every store. On
// error, whatever was started is closed again.
func openStores(ctx context.Context, log *slog.Logger, p paths.Paths) (_ *stores, err error) {
	s := &stores{bus: bus.New()}
	defer func() {
		if err != nil {
			s.close()
		}
	}()
	if s.db, err = db.Open(ctx, p.DB()); err != nil {
		return nil, err
	}
	if s.repo, err = repo.Start(ctx, repo.Options{DB: s.db, Bus: s.bus, Log: log}); err != nil {
		return nil, err
	}
	// CODE_FOUNDRY_GH_SEARCH_AS is a development aid (see gh.Options.SearchAs).
	if s.gh, err = gh.New(ctx, gh.Options{DB: s.db, Bus: s.bus, Log: log.With("store", "gh"), SearchAs: os.Getenv("CODE_FOUNDRY_GH_SEARCH_AS")}); err != nil {
		return nil, err
	}
	s.stopGh = startGh(ctx, log, s.gh, s.repo, s.bus)
	s.terminal = terminal.New(terminal.Options{Bus: s.bus, Logger: log.With("store", "terminal")})
	if s.session, err = session.New(ctx, session.Options{
		DB: s.db, Terminals: s.terminal, Repos: s.repo, Bus: s.bus, Log: log.With("store", "session"),
		NewDetector: newDetector,
	}); err != nil {
		return nil, err
	}
	return s, nil
}

// close stops the stores in reverse order of start, then closes the database.
func (s *stores) close() error {
	var errs []error
	if s.session != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		errs = append(errs, s.session.Shutdown(closeCtx))
		cancel()
	}
	if s.terminal != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		errs = append(errs, s.terminal.Close(closeCtx))
		cancel()
	}
	if s.stopGh != nil {
		s.stopGh()
	}
	if s.repo != nil {
		errs = append(errs, s.repo.Close())
	}
	if s.db != nil {
		errs = append(errs, s.db.Close())
	}
	return errors.Join(errs...)
}
