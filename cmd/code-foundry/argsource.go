package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

// maxArgSource bounds what readArgSource reads; the daemon refuses large values anyway
// (thread.report's data is at most 16 KiB).
const maxArgSource = 1 << 20

// readArgSource is a FileOrStdin arg's value (ArgSpec.file_or_stdin): the contents of
// <path> for @<path> (relative to the CLI's cwd), stdin for -, else the value as given.
func (cl *cli) readArgSource(name, v string) (string, error) {
	var r io.Reader
	switch {
	case v == "-":
		if cl.stdin == nil {
			return "", fmt.Errorf("--%s -: no stdin to read", name)
		}
		r = cl.stdin
	case strings.HasPrefix(v, "@"):
		p, err := cl.absPath(strings.TrimPrefix(v, "@"))
		if err != nil {
			return "", err
		}
		f, err := os.Open(p)
		if err != nil {
			return "", fmt.Errorf("--%s: %w", name, err)
		}
		defer func() { _ = f.Close() }()
		r = f
	default:
		return v, nil
	}
	b, err := io.ReadAll(io.LimitReader(r, maxArgSource+1))
	if err != nil {
		return "", fmt.Errorf("--%s: %w", name, err)
	}
	if len(b) > maxArgSource {
		return "", fmt.Errorf("--%s: more than %d bytes", name, maxArgSource)
	}
	return string(b), nil
}
