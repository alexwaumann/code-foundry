// Package plugins holds the example plugins (examples/*, each its own main package,
// built by `make plugins`) and embeds the minimal one, which the code-foundry-plugin
// skill hands to agents as the template to copy (internal/skills). Keeping the template
// a real package means `make check` builds, vets and tests it.
package plugins

import "embed"

// Minimal is the minimal example's source, under MinimalRoot: everything a plugin
// repository starts with (no go.mod: the skill has the agent make one).
//
//go:embed examples/minimal/plugin.json examples/minimal/main.go examples/minimal/main_test.go
//go:embed examples/minimal/Makefile examples/minimal/.gitignore examples/minimal/scripts/registry-entry.go
//go:embed examples/minimal/.github/workflows/release.yml examples/minimal/.github/workflows/ci.yml
var Minimal embed.FS

// MinimalRoot is the minimal example's directory in Minimal.
const MinimalRoot = "examples/minimal"
