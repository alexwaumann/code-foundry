// Package scripts embeds the installer, so the in-app updater and `code-foundry update`
// run the copy that shipped with the binary instead of fetching one from the repository
// (which need not be public).
package scripts

import _ "embed"

// InstallSh is scripts/install.sh.
//
//go:embed install.sh
var InstallSh []byte
