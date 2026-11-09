package plugin

import (
	"fmt"
	"time"
)

// coerceField is coerceValue for one field: a date's value is also "" or an ISO date
// within its bounds, so a plugin reads only days its calendar could offer.
func coerceField(f fieldInfo, v any) (any, error) {
	cv, err := coerceValue(f.control, v)
	if err != nil || f.control != "date" {
		return cv, err
	}
	s, _ := cv.(string)
	if s == "" {
		return s, nil
	}
	if _, err := time.Parse(time.DateOnly, s); err != nil {
		return nil, fmt.Errorf("%.40q is not an ISO date (YYYY-MM-DD)", s)
	}
	// ISO dates compare as strings.
	if f.min != "" && s < f.min {
		return nil, fmt.Errorf("%s is before %s", s, f.min)
	}
	if f.max != "" && s > f.max {
		return nil, fmt.Errorf("%s is after %s", s, f.max)
	}
	return s, nil
}
