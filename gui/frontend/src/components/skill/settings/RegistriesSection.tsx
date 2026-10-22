import { TriangleAlert } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { SectionCard } from "@/components/settings/SectionCard";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { useSkillMarketplaceStore, useSkillRegistriesError } from "@/stores/skill";
import { registryLine } from "./model";

/** One marketplace: name, owner/repo, counts and when it was read; a shallow clone, a failure and what the read skipped, in words. */
function RegistryRow({ name, className }: { name: string; className?: string | undefined }) {
  const r = useSkillMarketplaceStore((s) => s.registries?.registries.find((x) => x.name === name));
  const now = useNow(60_000);
  if (!r) return null;
  const where = r.repo || r.url || r.dir;
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 px-4 py-3", className)} data-testid="skill-registry" data-name={r.name} data-error={r.error ? "true" : undefined}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-label">{r.name}</span>
        {where && <span className="min-w-0 truncate font-mono text-caption-sm">{where}</span>}
        <span className="ml-auto shrink-0 text-caption-sm tabular-nums" data-testid="skill-registry-line">
          {registryLine(r, now)}
        </span>
      </div>
      {r.owner && <p className="truncate text-caption-sm">by {r.owner}</p>}
      {r.shallow && (
        <p className="text-caption-sm" data-testid="skill-registry-shallow">
          A shallow clone: every skill shows the clone&apos;s last commit date until Claude Code fetches its history.
        </p>
      )}
      {r.error && (
        <p className="flex min-w-0 items-start gap-1.5 text-caption-sm text-cf-warning" role="alert" data-testid="skill-registry-error">
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">Could not read or update it: {r.error}</span>
        </p>
      )}
      {r.issues.map((i) => (
        <p key={i} className="text-caption-sm break-words text-cf-warning" data-testid="skill-registry-issue">
          {i}
        </p>
      ))}
    </div>
  );
}

/**
 * Settings → Skills → Registries: the marketplaces Claude Code has (`claude plugin
 * marketplace list`), as Code Foundry last read their checkouts. There is no field to add
 * one: Claude Code owns the list, so the empty state says how.
 */
export function RegistriesSection() {
  const names = useSkillMarketplaceStore(useShallow((s) => s.registries?.registries.map((r) => r.name) ?? []));
  const loaded = useSkillMarketplaceStore((s) => s.registries !== null);
  const listError = useSkillMarketplaceStore((s) => s.registries?.error ?? "");
  const expected = useSkillMarketplaceStore((s) => s.registries?.expectedMarketplace || "ai-marketplace");
  const error = useSkillRegistriesError();
  return (
    <SectionCard id="registries" heading="Registries" description="The marketplaces Claude Code has. Refresh in Browse updates them, as the hourly check does.">
      {error && (
        <p className="border-b border-cf-border px-4 py-3 text-caption break-words text-cf-error" role="alert" data-testid="skill-registries-error">
          Cannot read the marketplaces: {error}
        </p>
      )}
      {listError && (
        <p className="border-b border-cf-border px-4 py-3 text-caption break-words text-cf-warning" role="alert" data-testid="skill-registries-list-error">
          claude plugin marketplace list failed, so these are the last ones read: {listError}
        </p>
      )}
      {!loaded && !error && <p className="px-4 py-3 text-caption">Loading…</p>}
      {loaded && names.length === 0 && (
        <p className="px-4 py-3 text-caption" data-testid="skill-registries-none">
          No marketplace is configured. Add your organisation&apos;s with <code className="text-code">claude plugin marketplace add &lt;owner/repo&gt;</code> (for example {expected})
          and Refresh.
        </p>
      )}
      {names.map((n, i) => (
        <RegistryRow key={n} name={n} className={i > 0 ? "border-t border-cf-border" : undefined} />
      ))}
    </SectionCard>
  );
}
