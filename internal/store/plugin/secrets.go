package plugin

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

// SecretStore keeps plugin secrets. Values are never logged; keys may be.
type SecretStore interface {
	// Get returns the value of plugin's key and whether it is set.
	Get(ctx context.Context, plugin, key string) (string, bool, error)
	// Set stores a value (non-empty).
	Set(ctx context.Context, plugin, key, value string) error
	// Delete removes a value; removing one that is not set is not an error.
	Delete(ctx context.Context, plugin, key string) error
}

// KeychainService is the Keychain service every plugin secret is stored under; the
// account is "<plugin>/<key>".
const KeychainService = "code-foundry-plugin"

// secretKeyPattern is the shape of a secret's key.
var secretKeyPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// MaxSecretBytes bounds one secret value.
const MaxSecretBytes = 16 << 10

// Keychain is the SecretStore backed by the user's login Keychain through the security
// CLI. A value is never in argv (it would show in ps): Set feeds the add command to
// `security -i` on stdin with the value hex-encoded (-X), and Get reads it from `-g`
// output on stderr.
type Keychain struct {
	// Security is the security binary (default /usr/bin/security).
	Security string
	// Service defaults to KeychainService.
	Service string
}

var _ SecretStore = Keychain{}

func (k Keychain) bin() string {
	if k.Security != "" {
		return k.Security
	}
	return "/usr/bin/security"
}

func (k Keychain) service() string {
	if k.Service != "" {
		return k.Service
	}
	return KeychainService
}

// errItemNotFound is security's exit status for a missing item.
const errItemNotFound = 44

func (k Keychain) run(ctx context.Context, stdin string, args ...string) (stdout, stderr string, code int, err error) {
	cmd := exec.CommandContext(ctx, k.bin(), args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err = cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.String(), errb.String(), ee.ExitCode(), nil
	}
	return out.String(), errb.String(), 0, err
}

// Get implements SecretStore.
func (k Keychain) Get(ctx context.Context, plugin, key string) (string, bool, error) {
	_, stderr, code, err := k.run(ctx, "", "find-generic-password", "-s", k.service(), "-a", plugin+"/"+key, "-g")
	switch {
	case err != nil:
		return "", false, fmt.Errorf("keychain: %w", err)
	case code == errItemNotFound:
		return "", false, nil
	case code != 0:
		return "", false, fmt.Errorf("keychain: find %s/%s: exit status %d", plugin, key, code)
	}
	v, ok := parsePasswordLine(stderr)
	if !ok {
		return "", false, fmt.Errorf("keychain: find %s/%s: unexpected output", plugin, key)
	}
	return v, true, nil
}

// parsePasswordLine reads the value from security's `-g` output: `password: "text"` for
// printable values, `password: 0x<HEX>  "escaped"` otherwise.
func parsePasswordLine(out string) (string, bool) {
	for line := range strings.SplitSeq(out, "\n") {
		rest, ok := strings.CutPrefix(line, "password: ")
		if !ok {
			continue
		}
		if h, ok := strings.CutPrefix(rest, "0x"); ok {
			h, _, _ = strings.Cut(h, " ")
			b, err := hex.DecodeString(h)
			if err != nil {
				return "", false
			}
			return string(b), true
		}
		if len(rest) >= 2 && rest[0] == '"' && rest[len(rest)-1] == '"' {
			return rest[1 : len(rest)-1], true
		}
		return "", false
	}
	return "", false
}

// Set implements SecretStore.
func (k Keychain) Set(ctx context.Context, plugin, key, value string) error {
	cmdline := fmt.Sprintf("add-generic-password -U -s %s -a %s/%s -X %s\n", k.service(), plugin, key, hex.EncodeToString([]byte(value)))
	_, stderr, code, err := k.run(ctx, cmdline, "-i")
	switch {
	case err != nil:
		return fmt.Errorf("keychain: %w", err)
	case code != 0 || strings.Contains(stderr, "SecKeychain"):
		return fmt.Errorf("keychain: store %s/%s: %s", plugin, key, firstLine(stderr, code))
	}
	return nil
}

// Delete implements SecretStore.
func (k Keychain) Delete(ctx context.Context, plugin, key string) error {
	_, stderr, code, err := k.run(ctx, "", "delete-generic-password", "-s", k.service(), "-a", plugin+"/"+key)
	switch {
	case err != nil:
		return fmt.Errorf("keychain: %w", err)
	case code == errItemNotFound:
		return nil
	case code != 0:
		return fmt.Errorf("keychain: delete %s/%s: %s", plugin, key, firstLine(stderr, code))
	}
	return nil
}

func firstLine(s string, code int) string {
	if l, _, _ := strings.Cut(strings.TrimSpace(s), "\n"); l != "" {
		return l
	}
	return fmt.Sprintf("exit status %d", code)
}
