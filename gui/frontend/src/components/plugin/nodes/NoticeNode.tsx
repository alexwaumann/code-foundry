import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { ButtonBar, InlineView, PluginIcon } from "../parts";
import type { NodeProps } from "../registry";
import { toneBorder, toneText } from "../tones";

/** A state to know about: the MCP card box with a tone border, the title in the tone's colour, the raw detail in mono. */
export function NoticeNode({ node, data }: NodeProps<"notice">) {
  const tone = data.tone ?? "";
  const Icon = tone === "error" ? CircleAlert : tone === "attention" ? TriangleAlert : Info;
  const iconClass = cn("mt-0.5 size-3.5 shrink-0", tone ? toneText[tone] : "text-muted-foreground");
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg border px-3 pt-2.5 pb-2", toneBorder[tone])}
      role={tone === "error" ? "alert" : "status"}
      data-testid="plugin-notice"
      data-tone={tone || undefined}
      data-host={node.key === "cf-invalid-view" || undefined}
    >
      <div className="flex min-w-0 items-start gap-2">
        {data.icon ? <PluginIcon name={data.icon} className={iconClass} /> : <Icon className={iconClass} aria-hidden />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {data.title && <p className={cn("text-body-sm font-semibold", toneText[tone])}>{data.title}</p>}
          {data.body !== undefined && (
            <p className="text-body-sm break-words">
              <InlineView value={data.body} />
            </p>
          )}
          {data.detail && <p className={cn("font-mono text-caption-sm break-words whitespace-pre-wrap", tone ? toneText[tone] : "text-muted-foreground")}>{data.detail}</p>}
        </div>
      </div>
      <ButtonBar buttons={data.actions} className="pl-5.5" />
    </div>
  );
}
