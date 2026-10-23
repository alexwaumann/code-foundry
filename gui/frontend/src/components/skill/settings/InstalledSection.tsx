import { useState } from "react";
import { ArrowUpCircle, Loader2, Power, PowerOff, SquareTerminal, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { InstalledSkillView } from "@/api/skill";
import { SectionCard } from "@/components/settings/SectionCard";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  canRunSetup,
  enableSkill,
  installedActions,
  NO_SETUP_OWNER,
  runSkillSetup,
  updateSkill,
  useInstalledSkillsError,
  useSkillBusy,
  useSkillMarketplaceStore,
  type SkillAction,
} from "@/stores/skill";
import { useUiStore } from "@/stores/ui";
import { installedPill, kindLabel, needsConfirm, sourceWords, type ConfirmAction } from "./model";
import { FailureLine, mainAction, Pill, PluginSkills, quietAction, VersionText } from "./parts";

/** NO_SETUP_OWNER as a sentence (the button's tooltip). */
const NO_OWNER_TIP = `${NO_SETUP_OWNER.charAt(0).toUpperCase()}${NO_SETUP_OWNER.slice(1)}: setup runs in its bottom panel.`;

/** Whether skill.setup has an owner for its terminal now (re-checked when the selection changes). */
function useSetupOwner(): boolean {
  useUiStore((s) => s.selection);
  return canRunSetup();
}

/** One action button of an installed row. */
function ActionButton({ row, action, busy, onConfirm }: { row: InstalledSkillView; action: SkillAction; busy: SkillAction | null; onConfirm: (a: ConfirmAction) => void }) {
  const owner = useSetupOwner();
  const spin = busy === action;
  const disabled = busy !== null;
  const icon = (Icon: typeof Power) => (spin ? <Loader2 className="animate-spin" aria-hidden /> : <Icon aria-hidden />);
  const click = () => {
    if (needsConfirm(action)) onConfirm(action);
    else if (action === "enable") void enableSkill(row);
    else if (action === "update") void updateSkill(row);
    else if (action === "setup") void runSkillSetup(row, { reveal: true });
  };
  switch (action) {
    case "enable":
      return (
        <Button variant="outline" size="xs" className="bg-transparent dark:bg-transparent" disabled={disabled} onClick={click} data-testid="skill-enable">
          {icon(Power)}
          Enable
        </Button>
      );
    case "disable":
      return (
        <Button variant="ghost" size="xs" className={quietAction} disabled={disabled} onClick={click} data-testid="skill-disable">
          {icon(PowerOff)}
          Disable
        </Button>
      );
    case "update":
      return (
        <Button variant="outline" size="xs" className={mainAction} disabled={disabled} onClick={click} data-testid="skill-update">
          {icon(ArrowUpCircle)}
          {row.update ? `Update to ${row.update.version}` : "Reinstall"}
        </Button>
      );
    case "setup": {
      const button = (
        <Button variant="outline" size="xs" className={mainAction} disabled={disabled || !owner} onClick={click} data-testid="skill-setup">
          {icon(SquareTerminal)}
          Run setup
        </Button>
      );
      return owner ? (
        button
      ) : (
        <Tip label={NO_OWNER_TIP}>
          <span className="inline-flex" data-testid="skill-setup-wrap">
            {button}
          </span>
        </Tip>
      );
    }
    case "uninstall":
    case "remove":
      return (
        <Button variant="ghost" size="xs" className={quietAction} disabled={disabled} onClick={click} data-testid={`skill-${action}`}>
          {icon(Trash2)}
          {action === "remove" ? "Remove" : "Uninstall"}
        </Button>
      );
    case "install":
      return null;
  }
}

/** One installed plugin or skill: identity, where from, version, state; its actions; a failure under it. */
function InstalledRow({ itemKey, className, onConfirm }: { itemKey: string; className?: string | undefined; onConfirm: (a: ConfirmAction, row: InstalledSkillView) => void }) {
  const r = useSkillMarketplaceStore((s) => s.installed?.installed.find((x) => x.key === itemKey));
  const busy = useSkillBusy(itemKey);
  const [open, setOpen] = useState(false);
  if (!r) return null;
  const source = sourceWords(r);
  const actions = installedActions(r);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 px-4 py-3", className)} data-testid="skill-installed-row" data-key={r.key} data-name={r.name} data-kind={r.kind} data-state={r.state}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-label">{r.name}</span>
          <Pill pill={{ label: kindLabel(r.kind), tone: "" }} outline testId="skill-kind" />
          <VersionText kind={r.kind} version={r.version} lastUpdatedMs={r.kind === "plugin" ? null : r.lastUpdatedMs} />
          <Pill pill={installedPill(r)} className="ml-auto" testId="skill-state" />
        </div>
        <p className="truncate text-caption-sm" data-testid="skill-source">
          {source}
          {r.by ? `${source ? " · " : ""}by ${r.by}` : ""}
        </p>
        {r.description && <p className="line-clamp-2 text-caption">{r.description}</p>}
        {r.state === "missing" && <p className="text-caption-sm text-cf-error-text">Its directory is gone. Reinstall puts it back; Uninstall forgets it.</p>}
        {r.update && r.state !== "missing" && (
          <p className="text-caption-sm text-cf-warning-text" data-testid="skill-update-available">
            {r.update.version} is available.
          </p>
        )}
        {r.kind === "plugin" && (
          <PluginSkills
            skills={r.skills}
            open={open}
            onToggle={() => {
              setOpen((o) => !o);
            }}
          />
        )}
        <FailureLine itemKey={r.key} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {actions.map((a) => (
          <ActionButton
            key={a}
            row={r}
            action={a}
            busy={busy}
            onConfirm={(c) => {
              onConfirm(c, r);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Settings → Skills → Installed: the plugins Claude Code has from a marketplace and the
 * skills in ~/.claude/skills (installed from one, or local), with Enable or Disable,
 * Update, Run setup and Uninstall (Remove for a local skill).
 */
export function InstalledSection({ onConfirm }: { onConfirm: (a: ConfirmAction, row: InstalledSkillView) => void }) {
  const keys = useSkillMarketplaceStore(useShallow((s) => s.installed?.installed.map((r) => r.key) ?? []));
  const loaded = useSkillMarketplaceStore((s) => s.installed !== null);
  const pluginsError = useSkillMarketplaceStore((s) => s.installed?.pluginsError ?? "");
  const error = useInstalledSkillsError();
  return (
    <SectionCard id="installed" heading="Installed" description="Claude Code plugins, and skills in ~/.claude/skills. Claude Code loads what is enabled in every new thread.">
      {error && (
        <p className="border-b border-cf-border px-4 py-3 text-caption break-words text-cf-error-text" role="alert" data-testid="skill-installed-error">
          Cannot read what is installed: {error}
        </p>
      )}
      {pluginsError && (
        <p className="border-b border-cf-border px-4 py-3 text-caption break-words text-cf-warning-text" role="alert" data-testid="skill-plugins-error">
          claude plugin list failed, so the plugins are the last list read: {pluginsError}
        </p>
      )}
      {!loaded && !error ? (
        <p className="px-4 py-3 text-caption">Loading…</p>
      ) : keys.length === 0 ? (
        loaded && (
          <p className="px-4 py-3 text-caption" data-testid="skills-installed-none">
            Nothing installed yet. Install a plugin or skill from Browse below.
          </p>
        )
      ) : (
        keys.map((k, i) => <InstalledRow key={k} itemKey={k} className={i > 0 ? "border-t border-cf-border" : undefined} onConfirm={onConfirm} />)
      )}
    </SectionCard>
  );
}
