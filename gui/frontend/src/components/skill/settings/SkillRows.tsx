import { ArrowUpCircle, Check, Download, RotateCw, SquareTerminal } from "lucide-react";
import type { InstalledSkillView } from "@/api/skill";
import { CatalogRow, RowButton, RowSwitch, RowWorking } from "@/components/settings/catalog/CatalogRow";
import { Tip } from "@/components/ui/tooltip";
import { openLooseFile } from "@/stores/filePanel";
import {
  browseAction,
  canRunSetup,
  installSkill,
  NO_SETUP_OWNER,
  runSkillSetup,
  updateSkill,
  useSkillBusy,
  useSkillFailure,
  useSkillMarketplaceStore,
  type SkillAction,
} from "@/stores/skill";
import { setSkillEnabled } from "@/stores/skillConfirm";
import { useUiStore } from "@/stores/ui";
import { useUpdateRunStore } from "@/stores/updateRun";
import { closeSettings } from "@/stores/views";
import { hasSwitch, installedWords, kindWords, rowMain, SKILL_FILE, skillMenu, sourceWords, tierLabel, type ConfirmAction, type RowMain } from "./model";
import { FailureLine, Pill, SkillNames, SourceLine } from "./parts";

/** NO_SETUP_OWNER as a sentence: the Run setup button's tooltip, the menu item's hint. */
const NO_OWNER = `${NO_SETUP_OWNER.charAt(0).toUpperCase()}${NO_SETUP_OWNER.slice(1)}`;
const NO_OWNER_TIP = `${NO_OWNER}: setup runs in a terminal of its own.`;

/** Whether skill.setup has an owner for its terminal now (re-checked when the selection changes). */
function useSetupOwner(): boolean {
  useUiStore((s) => s.selection);
  return canRunSetup();
}

/** The file in a tab for what is selected, and Settings out of the way so it shows. */
function viewSkillFile(r: InstalledSkillView): void {
  if (openLooseFile(r.dir, SKILL_FILE)) closeSettings();
}

/** What an installed row shows before its switch (model.ts rowMain). */
function MainCell({ row, main, busy, owner }: { row: InstalledSkillView; main: RowMain; busy: SkillAction | null; owner: boolean }) {
  switch (main?.kind) {
    case undefined:
      return row.state === "local" ? <Pill pill={{ label: "Local", tone: "" }} outline testId="skill-local" /> : null;
    case "working":
      return <RowWorking words={main.words} />;
    case "updated":
      return (
        <span className="flex shrink-0 items-center gap-1 text-caption-sm" data-testid="skill-updated">
          <Check className="size-3" aria-hidden />
          Updated to {main.version}
        </span>
      );
    case "updating":
      return (
        <RowButton icon={ArrowUpCircle} busy onClick={() => undefined} testId="skill-update">
          Updating…
        </RowButton>
      );
    case "update":
      return (
        <RowButton
          icon={main.retry ? RotateCw : ArrowUpCircle}
          disabled={busy !== null}
          onClick={() => {
            void updateSkill(row);
          }}
          testId="skill-update"
        >
          {main.retry ? "Retry update" : `Update to ${main.version}`}
        </RowButton>
      );
    case "reinstall":
      return (
        <>
          <Pill pill={{ label: "Missing", tone: "error" }} testId="skill-state" />
          <RowButton
            icon={ArrowUpCircle}
            plain
            busy={busy === "update"}
            disabled={busy !== null}
            onClick={() => {
              void updateSkill(row);
            }}
            testId="skill-update"
          >
            Reinstall
          </RowButton>
        </>
      );
    case "setup": {
      const button = (
        <RowButton
          icon={SquareTerminal}
          busy={busy === "setup"}
          disabled={!owner || busy !== null}
          onClick={() => {
            void runSkillSetup(row, { reveal: true });
          }}
          testId="skill-setup"
        >
          Run setup
        </RowButton>
      );
      return owner ? (
        button
      ) : (
        <Tip label={NO_OWNER_TIP}>
          <span className="inline-flex shrink-0" data-testid="skill-setup-wrap">
            {button}
          </span>
        </Tip>
      );
    }
  }
}

/** One installed plugin or skill (CatalogRow): its main action, switch and menu; everything else in its details. */
export function InstalledRow({
  itemKey,
  first,
  open,
  onToggle,
  onConfirm,
}: {
  itemKey: string;
  first: boolean;
  open: boolean;
  onToggle: () => void;
  onConfirm: (a: ConfirmAction, row: InstalledSkillView) => void;
}) {
  const r = useSkillMarketplaceStore((s) => s.installed?.installed.find((x) => x.key === itemKey));
  const busy = useSkillBusy(itemKey);
  const failure = useSkillFailure(itemKey);
  const updatedTo = useUpdateRunStore((s) => s.skills.updated[itemKey]);
  const owner = useSetupOwner();
  if (!r) return null;
  const flipping = busy === "enable" || busy === "disable";
  return (
    <CatalogRow
      rowKey={r.key}
      name={r.name}
      description={r.description}
      first={first}
      open={open}
      onToggle={onToggle}
      attrs={{ "data-testid": "skill-installed-row", "data-key": r.key, "data-name": r.name, "data-kind": r.kind, "data-state": r.state }}
      pills={r.kind === "plugin" && <Pill pill={{ label: kindWords(r.kind, r.skills.length), tone: "" }} outline testId="skill-kind" />}
      action={<MainCell row={r} main={rowMain(r, busy, failure, updatedTo)} busy={busy} owner={owner} />}
      toggle={
        hasSwitch(r) && (
          <RowSwitch
            checked={busy === "enable" ? true : busy === "disable" ? false : r.enabled}
            busy={flipping}
            disabled={busy !== null}
            label={`${r.name} enabled`}
            onChange={(on) => {
              void setSkillEnabled(r, on);
            }}
            testId="skill-switch"
          />
        )
      }
      menu={{
        label: `More for ${r.name}`,
        testId: "skill-row-menu",
        items: skillMenu(r, {
          owner,
          noOwner: NO_OWNER,
          busy: busy !== null,
          onView: () => {
            viewSkillFile(r);
          },
          onSetup: () => {
            void runSkillSetup(r, { reveal: true });
          },
          onConfirm: (a) => {
            onConfirm(a, r);
          },
        }),
      }}
      below={failure && <FailureLine itemKey={r.key} />}
      details={
        <>
          {r.description && <p className="text-caption break-words">{r.description}</p>}
          <SourceLine source={sourceWords(r)} by={r.by} kind={r.kind} version={r.version} lastUpdatedMs={r.kind === "plugin" ? null : r.lastUpdatedMs} available={r.state === "missing" ? undefined : r.update?.version} />
          {r.state === "missing" && <p className="text-caption-sm text-cf-error-text">Its directory is gone. Reinstall puts it back; Uninstall forgets it.</p>}
          <SkillNames skills={r.skills} />
        </>
      }
    />
  );
}

/** One marketplace hit (CatalogRow): Install, Update to X or Installed; the rest in its details. */
export function MarketRow({ itemKey, first, open, onToggle }: { itemKey: string; first: boolean; open: boolean; onToggle: () => void }) {
  const e = useSkillMarketplaceStore((s) => s.search?.entries.find((x) => x.key === itemKey));
  const busy = useSkillBusy(itemKey);
  const failure = useSkillFailure(itemKey);
  if (!e) return null;
  const action = browseAction(e);
  const facts = [...e.keywords, ...(e.setupScript ? ["needs setup after installing"] : [])];
  return (
    <CatalogRow
      rowKey={e.key}
      name={e.name}
      description={e.description}
      first={first}
      open={open}
      onToggle={onToggle}
      attrs={{ "data-testid": "skill-entry", "data-key": e.key, "data-name": e.name, "data-kind": e.kind, "data-tier": e.tier, "data-state": e.state }}
      pills={
        <>
          <Pill pill={{ label: kindWords(e.kind, e.skills.length), tone: "" }} outline testId="skill-kind" />
          <Pill pill={{ label: tierLabel(e.tier), tone: "muted" }} testId="skill-tier" />
        </>
      }
      action={
        action === "install" ? (
          <RowButton
            icon={Download}
            busy={busy === "install"}
            disabled={busy !== null}
            onClick={() => {
              void installSkill(e);
            }}
            testId="skill-install"
          >
            Install
          </RowButton>
        ) : action === "update" ? (
          <RowButton
            icon={failure?.action === "update" ? RotateCw : ArrowUpCircle}
            busy={busy === "update"}
            disabled={busy !== null}
            onClick={() => {
              void updateSkill(e);
            }}
            testId="skill-browse-update"
          >
            {busy === "update" ? "Updating…" : failure?.action === "update" ? "Retry update" : `Update to ${e.updateVersion}`}
          </RowButton>
        ) : (
          <span className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-caption-sm" data-testid="skill-installed-mark">
            <Check className="size-3" aria-hidden />
            {installedWords(e)}
          </span>
        )
      }
      below={failure && <FailureLine itemKey={e.key} />}
      details={
        <>
          {e.description && <p className="text-caption break-words">{e.description}</p>}
          <SourceLine source={e.registry ? `from ${e.registry}` : ""} by={e.by} kind={e.kind} version={e.version} lastUpdatedMs={e.lastUpdatedMs} />
          {facts.length > 0 && (
            <p className="text-caption-sm break-words" data-testid="skill-keywords">
              {facts.join(" · ")}
            </p>
          )}
          <SkillNames skills={e.skills} />
        </>
      }
    />
  );
}
