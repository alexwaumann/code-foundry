package api

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/pricing"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

// usageToProto maps usage buckets to the wire, pricing each one (cost is computed at
// read time, never stored). cost is the sum over priced buckets; unpriced is true when
// any bucket has no known rate.
func usageToProto(buckets []session.UsageBucket) (out []*v1.UsageBucket, cost float64, unpriced bool) {
	for _, b := range buckets {
		usd, ok := pricing.Cost(pricing.Bucket{
			Model: b.Model, Tier: b.Tier, Speed: b.Speed,
			Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheWrite5m: b.CacheWrite5m, CacheWrite1h: b.CacheWrite1h,
		})
		out = append(out, &v1.UsageBucket{
			Model: b.Model, Tier: b.Tier, Speed: b.Speed, Day: b.Day,
			Requests: b.Requests, Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheWrite_5M: b.CacheWrite5m, CacheWrite_1H: b.CacheWrite1h,
			CostUsd: usd, Unpriced: !ok,
		})
		cost += usd
		unpriced = unpriced || !ok
	}
	return out, cost, unpriced
}

// retiredToProto maps the retired ledger.
func retiredToProto(buckets []session.UsageBucket) []*v1.UsageBucket {
	out, _, _ := usageToProto(buckets)
	return out
}
