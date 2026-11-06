package main

import (
	"crypto/sha256"
	"fmt"
	"log/slog"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// isolateWebStorage gives a run on any home but the default one web storage of its own,
// so a scratch run's localStorage, IndexedDB and cookies never reach the user's app. The
// default home changes nothing: WebKit's default store, as ever.
func isolateWebStorage(p paths.Paths, log *slog.Logger) error {
	id := webStorageID(p)
	if id == "" {
		return nil
	}
	if err := useWebStorage(id); err != nil {
		return err
	}
	log.Info("web storage of this home", "home", p.Home(), "id", id)
	return nil
}

// webStorageID names the data store of a home, the same on every run so a scratch home
// keeps its storage: a UUID (which is what WebKit takes) derived from the home, marked
// version 4 as WebKit only lists those. Empty for the default home, and any spelling of it.
func webStorageID(p paths.Paths) string {
	home := canonicalHome(p.Home())
	if def, err := paths.Default(); err == nil && canonicalHome(def.Home()) == home {
		return ""
	}
	sum := sha256.Sum256([]byte(home))
	sum[6] = sum[6]&0x0f | 0x40
	sum[8] = sum[8]&0x3f | 0x80
	return fmt.Sprintf("%X-%X-%X-%X-%X", sum[0:4], sum[4:6], sum[6:8], sum[8:10], sum[10:16])
}
