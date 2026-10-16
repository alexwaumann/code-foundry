// Command fakeclaude is the session store tests' stand-in for `claude -p`
// (internal/claudestream/fakeclaude). The tests build it themselves; it ships nowhere.
package main

import (
	"fmt"
	"os"

	"github.com/alexwaumann/code-foundry/internal/claudestream/fakeclaude"
)

func main() {
	fixture := os.Getenv(fakeclaude.Env)
	if fixture == "" {
		fmt.Fprintf(os.Stderr, "fakeclaude: %s is not set\n", fakeclaude.Env)
		os.Exit(2)
	}
	os.Exit(fakeclaude.Run(fixture))
}
