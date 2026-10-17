import { useContext, type ReactNode } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tagLabel } from "@/lib/prompt";
import { useProjectsStore } from "@/stores/projects";
import { useSkillDescription } from "@/stores/skills";
import { AttachmentChip } from "./AttachmentChip";
import { TagMultiProjectContext, tagOf } from "./tagContext";
import { TAG_ACCENT, tagClass } from "./tagStyle";

/** A project's name for a tag ("" for none, the id when the project is gone). */
function useProjectName(projectId: string): string {
  return useProjectsStore((s) => (projectId ? (s.byId[projectId]?.name ?? projectId) : ""));
}

/**
 * A text-only tag (a skill, a file) with a hover tooltip: one line saying what it is,
 * an optional muted second line. The app root's TooltipProvider sets the delays.
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
      <TooltipContent side="top" className="max-w-80 px-2.5 py-1.5 text-body-sm" data-testid="prompt-tag-tooltip">
        <p>{tip}</p>
        {detail && <p className="mt-0.5 text-muted-foreground">{detail}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

function SkillTag({ name, projectId, selected }: { name: string; projectId: string; selected: boolean }) {
  const project = useProjectName(projectId);
  const description = useSkillDescription(projectId, name);
  const scope = projectId ? `Project skill · ${project}` : "User skill";
  return (
    <TextTag
      kind="skill"
      label={`/${name}`}
      selected={selected}
      ariaLabel={`Skill /${name}, ${scope}`}
      tip={scope}
      detail={description}
      data={{ "data-skill": name, "data-project": projectId || undefined }}
    />
  );
}

/**
 * A file or directory: the tooltip is its path (a directory's ends with "/"), prefixed
 * with the project's name when the draft has more than one project
 * (`api/internal/api/thread.go`).
 */
function FileTag({ projectId, path, selected }: { projectId: string; path: string; selected: boolean }) {
  const project = useProjectName(projectId);
  const multi = useContext(TagMultiProjectContext);
  const label = tagLabel({ tagKind: "file", projectId, path });
  return (
    <TextTag
      kind="file"
      label={label}
      selected={selected}
      ariaLabel={`${path.endsWith("/") ? "Folder" : "File"} ${path} in ${project}`}
      tip={<span className="font-mono">{multi ? `${project}/${path}` : path}</span>}
      detail=""
      data={{ "data-path": path, "data-project": projectId }}
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
      return <SkillTag name={tag.name} projectId={tag.projectId} selected={selected} />;
    case "file":
      return <FileTag projectId={tag.projectId} path={tag.path} selected={selected} />;
  }
}
