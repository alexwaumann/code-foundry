// Package docs embeds the user documentation the daemon ships: the getting started
// guide, which the GUI's help overlay also bundles (gui/frontend/src/components/help/guide.ts
// imports docs/GETTING-STARTED.md?raw) and the code-foundry-help skill carries as
// reference/getting-started.md (internal/skills), one file with two readers; and the theme
// notes (reference/themes.md), whose live-slot list the GUI's tests hold to the code.
package docs

import _ "embed"

// GettingStarted is docs/GETTING-STARTED.md.
//
//go:embed GETTING-STARTED.md
var GettingStarted []byte

// Themes is docs/THEMES.md, the theme file format and the live slots, which the
// code-foundry-help skill carries as reference/themes.md.
//
//go:embed THEMES.md
var Themes []byte
