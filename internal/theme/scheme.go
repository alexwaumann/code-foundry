package theme

import (
	"fmt"
	"math"
	"slices"
	"strconv"
)

// The OKLab lightness a surface needs for its scheme (SCHEME_LIGHTNESS in
// src/themes/slots.ts): past these the text cannot reach 7:1 with room left for the
// statuses, and between the two (a mid grey) neither scheme works.
const (
	SchemeDarkMaxL  = 0.45
	SchemeLightMinL = 0.70
)

// IsSlot reports whether name is one of the GUI's slots (SlotNames).
func IsSlot(name string) bool {
	_, ok := slices.BinarySearch(slotNames, name)
	return ok
}

// SchemeProblem is why a surface (#rrggbb) cannot carry a scheme, or "" when it can. The
// words and the numbers are the GUI's schemeProblem, so the daemon refuses a file with
// the message the editor and `bun run themes:check` give. This is a colour conversion,
// not a derivation: the daemon still resolves no slot.
func SchemeProblem(scheme, surface string) string {
	l, ok := oklabLightness(surface)
	if !ok {
		return ""
	}
	at := fmt.Sprintf("base.surface %s has OKLab lightness %.2f", surface, l)
	switch {
	case scheme == SchemeDark && l > SchemeDarkMaxL && l >= SchemeLightMinL:
		return fmt.Sprintf(`scheme is "dark" but %s, a light surface (dark needs at most %g): set "scheme": "light", or give a dark surface`, at, SchemeDarkMaxL)
	case scheme == SchemeDark && l > SchemeDarkMaxL:
		return fmt.Sprintf(`%s, too light for a dark scheme (at most %g) and too dark for a light one (at least %g): darken it for "dark" or lighten it for "light"`, at, SchemeDarkMaxL, SchemeLightMinL)
	case scheme == SchemeLight && l < SchemeLightMinL && l <= SchemeDarkMaxL:
		return fmt.Sprintf(`scheme is "light" but %s, a dark surface (light needs at least %g): set "scheme": "dark", or give a light surface`, at, SchemeLightMinL)
	case scheme == SchemeLight && l < SchemeLightMinL:
		return fmt.Sprintf(`%s, too dark for a light scheme (at least %g) and too light for a dark one (at most %g): lighten it for "light" or darken it for "dark"`, at, SchemeLightMinL, SchemeDarkMaxL)
	}
	return ""
}

// oklabLightness is the OKLab L (0..1) of a #rrggbb colour, as src/themes/color.ts
// computes it; ok is false for anything else.
func oklabLightness(hex string) (float64, bool) {
	if !opaquePattern.MatchString(hex) {
		return 0, false
	}
	var c [3]float64
	for i := range c {
		v, err := strconv.ParseUint(hex[1+2*i:3+2*i], 16, 8)
		if err != nil {
			return 0, false
		}
		s := float64(v) / 255
		if s <= 0.04045 {
			c[i] = s / 12.92
		} else {
			c[i] = math.Pow((s+0.055)/1.055, 2.4)
		}
	}
	r, g, b := c[0], c[1], c[2]
	l := math.Cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b)
	m := math.Cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b)
	s := math.Cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b)
	return 0.2104542553*l + 0.793617785*m - 0.0040720468*s, true
}
