package api

import (
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/pricing"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

// usageToProto maps usage buckets to the wire, pricing each one (cost is computed at
// read time, never stored). cost is the sum over priced buckets; unpriced is true when
// any bucket has no known rate.
func usageToProto(buckets []session.UsageBucket) (out []*v1.UsageBucket, cost float64, unpriced bool) {
	for _, b := range buckets {
		pb := pricing.Bucket{
			Model: b.Model, Tier: b.Tier, Speed: b.Speed,
			Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheWrite5m: b.CacheWrite5m, CacheWrite1h: b.CacheWrite1h,
		}
		c, ok := pricing.CostByKind(pb)
		usd := c.Total()
		out = append(out, &v1.UsageBucket{
			Model: b.Model, Tier: b.Tier, Speed: b.Speed, Day: b.Day,
			Requests: b.Requests, Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheWrite_5M: b.CacheWrite5m, CacheWrite_1H: b.CacheWrite1h,
			CostUsd: usd, Unpriced: !ok,
			InputCostUsd: c.Input, OutputCostUsd: c.Output, CacheReadCostUsd: c.CacheRead,
			CacheWrite_5MCostUsd: c.CacheWrite5m, CacheWrite_1HCostUsd: c.CacheWrite1h,
			CacheSavingsUsd: pricing.CacheSavings(pb),
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

// agentRunsToProto maps a thread's subagent runs, each priced like the session.
func agentRunsToProto(runs []session.AgentRun) []*v1.AgentRun {
	out := make([]*v1.AgentRun, 0, len(runs))
	for _, r := range runs {
		p := &v1.AgentRun{
			Id: r.ID, Description: r.Description, AgentType: r.AgentType, Model: r.Model, Effort: r.Effort,
			Background: r.Background, Status: v1.AgentRunStatus_AGENT_RUN_STATUS_CLOSED, SpawnDepth: int32(r.SpawnDepth),
		}
		if r.Open {
			p.Status = v1.AgentRunStatus_AGENT_RUN_STATUS_OPEN
		}
		if !r.StartedAt.IsZero() {
			p.StartedAt = timestamppb.New(r.StartedAt)
		}
		p.Usage, p.CostUsd, p.Unpriced = usageToProto(r.Usage)
		out = append(out, p)
	}
	return out
}

// contextRereadUSD prices re-reading a thread's context once its cache expired
// (pricing.RereadCost): at the rate of the model that answered its last turn, else of
// the row's model when that is a full id; the TTL is the one its expiry was computed
// with. 0 when nothing is recorded or the model is unpriced.
func contextRereadUSD(s session.Session) float64 {
	if s.ContextTokens <= 0 || s.LastResultAt.IsZero() || s.CacheExpiresAt.IsZero() {
		return 0
	}
	ttl := s.CacheExpiresAt.Sub(s.LastResultAt)
	for _, m := range []string{s.ContextModel, s.Model} {
		if usd, ok := pricing.RereadCost(m, s.ContextTokens, ttl); ok {
			return usd
		}
	}
	return 0
}
