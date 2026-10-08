package daemon

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"

	_ "modernc.org/sqlite" // database/sql driver "sqlite"

	"github.com/awaumann/code-foundry/internal/api"
	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/store/gh"
)

// startGh opens the GitHub store, starts its poller, and returns its route and a stop
// function that waits for the poller to exit.
//
// MERGE NOTE (Phase 1b): until internal/db lands, this opens its own handle on
// paths.DB() (the same file 1b will use; gh owns only gh_* tables). At merge, pass the
// shared *sql.DB in place of openGhDB, and keep gh.Migrate here or run it next to the
// shared migrations. RepoService should call Track(github_slug) on the returned store
// for every registered repo with a GitHub remote, and Untrack on unregister.
func startGh(ctx context.Context, log *slog.Logger, p paths.Paths, b *bus.Bus) (*gh.Store, api.Route, func(), error) {
	db, err := openGhDB(p.DB())
	if err != nil {
		return nil, api.Route{}, nil, err
	}
	if err := gh.Migrate(ctx, db); err != nil {
		_ = db.Close()
		return nil, api.Route{}, nil, err
	}
	store, err := gh.New(ctx, gh.Options{DB: db, Bus: b, Log: log.With("store", "gh")})
	if err != nil {
		_ = db.Close()
		return nil, api.Route{}, nil, err
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := store.Run(runCtx); err != nil {
			log.Error("gh poller stopped", "err", err)
		}
	}()
	stop := func() {
		cancel()
		<-done
		_ = db.Close()
	}
	return store, api.NewGh(store, b, ctx.Done()).Route(), stop, nil
}

func openGhDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(wal)")
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return db, nil
}
