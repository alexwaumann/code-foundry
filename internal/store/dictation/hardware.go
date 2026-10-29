package dictation

import (
	"strings"

	"golang.org/x/sys/unix"
)

// Hardware is this Mac, for the settings page: on an M1 each phrase takes seconds.
type Hardware struct {
	// Chip is machdep.cpu.brand_string ("Apple M4 Pro"); "" when sysctl does not say.
	Chip string
	// MemoryBytes is hw.memsize.
	MemoryBytes int64
	// M1Family is a chip of the M1 generation (M1, Pro, Max, Ultra).
	M1Family bool
}

// ReadHardware reads the facts with sysctl.
func ReadHardware() Hardware {
	chip, _ := unix.Sysctl("machdep.cpu.brand_string")
	mem, _ := unix.SysctlUint64("hw.memsize")
	return HardwareOf(chip, mem)
}

// HardwareOf derives the facts from the sysctl values.
func HardwareOf(chip string, memsize uint64) Hardware {
	chip = strings.TrimSpace(chip)
	return Hardware{Chip: chip, MemoryBytes: int64(memsize), M1Family: isM1(chip)}
}

// isM1 reports whether a brand string names an M1-generation chip: "Apple M1", "Apple
// M1 Pro", ...; not "Apple M10" should one ever exist.
func isM1(chip string) bool {
	for f := range strings.FieldsSeq(chip) {
		if f == "M1" {
			return true
		}
	}
	return false
}
