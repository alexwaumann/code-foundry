// Package bridge serves /cf/bridge.js, the script an HTML page the model shows loads to
// call Code Foundry (docs/notes/bridge-1-daemon.md): `<script src="/cf/bridge.js">`
// gives the page window.cf, which runs registry verbs its thread may run, subscribes to
// daemon events and reads the theme. The page never talks to the API: every call is a
// postMessage to the GUI, which invokes the command with its own token. The script is
// plain ES2017 with no build step, embedded as written.
package bridge

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"net/http"
	"time"
)

// Path is the route the script is served on, on the pages listener beside /cf/theme.css.
const Path = "/cf/bridge.js"

// Version is the message protocol's version: every message the script posts carries
// cf: Version.
const Version = 1

// Error codes a cf.run rejection carries.
const (
	// CodeGesture: a verb that is not read-only was called outside a user gesture.
	CodeGesture = "gesture"
	// CodeDeclined: the user declined the command's confirmation.
	CodeDeclined = "declined"
	// CodeUnavailable: no Code Foundry host answers, or the verb is not available.
	CodeUnavailable = "unavailable"
	// CodeInvalid: a bad verb name or argument.
	CodeInvalid = "invalid"
	// CodeFailed: the command ran and failed.
	CodeFailed = "failed"
	// CodeTimeout: no result in time.
	CodeTimeout = "timeout"
)

// ErrorCodes is every code a cf.run rejection carries, in the order the capabilities
// text lists them.
var ErrorCodes = []string{CodeGesture, CodeDeclined, CodeUnavailable, CodeInvalid, CodeFailed, CodeTimeout}

// Sources are the event sources cf.on subscribes to, as the GUI's host exposes them
// (cf:ready's sources). The thread source is the page's own thread: its snapshot and
// pending requests, never its items.
var Sources = []string{"thread-list", "thread", "gh", "action", "plugin", "terminal", "project", "workspace", "settings", "update", "ui", "ember"}

//go:embed bridge.js
var script []byte

// etag names this build's script, so a page revalidates it cheaply and picks up a new
// one after an update.
var etag = func() string {
	sum := sha256.Sum256(script)
	return `"` + hex.EncodeToString(sum[:8]) + `"`
}()

// Script returns the script's source.
func Script() []byte { return bytes.Clone(script) }

// Handler serves GET (and HEAD) Path: the script, revalidated by its ETag on every load.
// It needs no credential (a <script src> sends none) and reveals nothing but itself.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		if r.URL.Path != Path {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			h.Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.Set("Content-Type", "text/javascript; charset=utf-8")
		h.Set("Cache-Control", "no-cache")
		h.Set("ETag", etag)
		h.Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, "bridge.js", time.Time{}, bytes.NewReader(script))
	})
}
