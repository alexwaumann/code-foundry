// Package docs embeds the user documentation the daemon ships: the getting started
// guide, which the GUI's help overlay also bundles (gui/frontend/src/components/help/guide.ts
// imports docs/GETTING-STARTED.md?raw) and the code-foundry-help skill carries as
// reference/getting-started.md (internal/skills). One file, two readers.
package docs

import _ "embed"

// GettingStarted is docs/GETTING-STARTED.md.
//
//go:embed GETTING-STARTED.md
var GettingStarted []byte
