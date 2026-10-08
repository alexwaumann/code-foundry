// Package api holds the daemon's Connect service handlers. Handlers are thin: they read
// store snapshots, subscribe to the bus, and forward intents. One file per service.
package api

import "net/http"

// Route is a Connect service mounted on the daemon's mux.
type Route struct {
	Path    string
	Handler http.Handler
}
