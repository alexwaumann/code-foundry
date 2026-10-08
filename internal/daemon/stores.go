package daemon

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"

	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/db"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/store/repo"
)

// stores is the daemon's shared infrastructure (bus, database) and its stores. Each
// store gets one field here and one line in openStores and close.
type stores struct {
	bus  *bus.Bus
	db   *sql.DB
	repo *repo.Git
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
	return s, nil
}

// close stops the stores in reverse order of start, then closes the database.
func (s *stores) close() error {
	var errs []error
	if s.repo != nil {
		errs = append(errs, s.repo.Close())
	}
	if s.db != nil {
		errs = append(errs, s.db.Close())
	}
	return errors.Join(errs...)
}
