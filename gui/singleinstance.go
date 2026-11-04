package main

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
)

// singleInstanceID names the one GUI of a home for Wails's SingleInstance, which keeps a
// lock file and a distributed notification under this name. Homes stay independent, as
// tests and scratch homes rely on: a hash, as a home is a path and this is a file name.
// Two spellings of a home are one home; a path that does not resolve yet stays as given.
func singleInstanceID(home string) string {
	if abs, err := filepath.Abs(home); err == nil {
		home = abs
	}
	if real, err := filepath.EvalSymlinks(home); err == nil {
		home = real
	}
	sum := sha256.Sum256([]byte(home))
	return "dev.alexwaumann.codefoundry.gui." + hex.EncodeToString(sum[:8])
}
