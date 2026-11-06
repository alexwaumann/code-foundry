package main

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
)

// singleInstanceID names the one GUI of a home for Wails's SingleInstance, which keeps a
// lock file and a distributed notification under this name. Homes stay independent, as
// tests and scratch homes rely on: a hash, as a home is a path and this is a file name.
func singleInstanceID(home string) string {
	sum := sha256.Sum256([]byte(canonicalHome(home)))
	return "dev.alexwaumann.codefoundry.gui." + hex.EncodeToString(sum[:8])
}

// canonicalHome is one spelling for a home: two spellings of a home are one home. A path
// that does not resolve yet stays as given.
func canonicalHome(home string) string {
	if abs, err := filepath.Abs(home); err == nil {
		home = abs
	}
	if real, err := filepath.EvalSymlinks(home); err == nil {
		home = real
	}
	return home
}
