import type { ReactNode } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tagLabel } from "@/lib/prompt";
import { useReposStore } from "@/stores/repos";
import { useSkillDescription } from "@/stores/skills";
import { AttachmentChip } from "./AttachmentChip";
import { tagOf } from "./tagContext";
import { TAG_ACCENT, tagClass } from "./tagStyle";

/** A project's name for a tag ("" for none, the id when the project is gone). */
function useProjectName(repoId: string): string {
  return useReposStore((s) => (repoId ? (s.byId[repoId]?.name ?? repoId) : ""));
}

/**
 * A text-only tag (a skill, a file) with a hover tooltip: one line saying what it is,
 * an optional muted second line. The editor's TooltipProvider groups the delays.
 */
function TextTag({
  kind,
  label,
  selected,
  ariaLabel,
  tip,
  detail,
  data,
}: {
  kind: "skill" | "file";
  label: string;
  selected: boolean;
  ariaLabel: string;
  tip: ReactNode;
  detail: string;
  data: Record<string, string | undefined>;
}) {
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger asChild>
        <NodeViewWrapper as="span" data-testid="prompt-tag" data-tag-kind={kind} {...data} role="img" aria-label={ariaLabel} className={tagClass(selected, TAG_ACCENT[kind])}>
          <span className="truncate">{label}</span>
        </NodeViewWrapper>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-80 px-2.5 py-1.5 text-xs" data-testid="prompt-tag-tooltip">
        <p>{tip}</p>
        {detail && <p className="mt-0.5 text-muted-foreground">{detail}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

function SkillTag({ name, repoId, selected }: { name: string; repoId: string; selected: boolean }) {
  const project = useProjectName(repoId);
  const description = useSkillDescription(repoId, name);
  const scope = repoId ? `Project skill · ${project}` : "User skill";
  return (
    <TextTag
      kind="skill"
      label={`/${name}`}
      selected={selected}
      ariaLabel={`Skill /${name}, ${scope}`}
      tip={scope}
      detail={description}
      data={{ "data-skill": name, "data-repo": repoId || undefined }}
    />
  );
}

function FileTag({ repoId, path, selected }: { repoId: string; path: string; selected: boolean }) {
  const project = useProjectName(repoId);
  const label = tagLabel({ tagKind: "file", repoId, path });
  return (
    <TextTag
      kind="file"
      label={label}
      selected={selected}
      ariaLabel={`${path.endsWith("/") ? "Folder" : "File"} ${path} in ${project}`}
      tip={<span className="font-mono">{path}</span>}
      detail={project}
      data={{ "data-path": path, "data-repo": repoId }}
    />
  );
}

/** The node view of a prompt tag (tagNode.ts): an image chip, a skill or a file. */
export function TagView({ node, selected, editor }: NodeViewProps) {
  const tag = tagOf(node.attrs);
  switch (tag.tagKind) {
    case "image":
      return <AttachmentChip id={tag.id} label={tag.name} selected={selected} editor={editor} />;
    case "skill":
      return <SkillTag name={tag.name} repoId={tag.repoId} selected={selected} />;
    case "file":
      return <FileTag repoId={tag.repoId} path={tag.path} selected={selected} />;
  }
}
