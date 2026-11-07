import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { CompareSource } from "@/api/compare";
import { listRefs } from "@/api/project";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { sameSource, sourceParam } from "@/surfaces/diffTarget";
import { useTabRead } from "@/components/files/useTabRead";
import { refChoices } from "./sources";

/** One choice of a picker. */
function Choice({ source, label, note, value, onPick }: { source: CompareSource; label: string; note?: string; value: CompareSource; onPick: (s: CompareSource) => void }) {
  return (
    <CommandItem
      value={sourceParam(source)}
      data-testid={`diff-source-${sourceParam(source)}`}
      onSelect={() => {
        onPick(source);
      }}
    >
      <span className="min-w-0 truncate">{label}</span>
      {note && <span className="ml-auto shrink-0 text-caption-sm">{note}</span>}
      {sameSource(source, value) && <Check className={cn("size-3.5 shrink-0", !note && "ml-auto")} aria-hidden data-testid="diff-source-current" />}
    </CommandItem>
  );
}

function Refs({ projectId, query, value, onPick }: { projectId: string; query: string; value: CompareSource; onPick: (s: CompareSource) => void }) {
  const read = useTabRead(projectId, (signal) => listRefs(projectId, undefined, signal));
  const refs = useMemo(() => refChoices(read.data?.refs ?? [], query), [read.data, query]);
  return (
    <CommandGroup heading="Refs">
      {refs.map((ref) => (
        <Choice key={ref} source={{ kind: "ref", ref }} label={ref} value={value} onPick={onPick} />
      ))}
    </CommandGroup>
  );
}

/**
 * One side of the compare bar: the working tree, the index, the base's merge base or any
 * ref, typed or picked. The list is short by construction (refChoices), so it is not
 * virtualized and cmdk's own filter is off.
 */
export function SourcePicker({ projectId, value, label, baseLabel, onChange, testId }: { projectId: string; value: CompareSource; label: string; baseLabel: string; onChange: (s: CompareSource) => void; testId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pick = (s: CompareSource) => {
    setOpen(false);
    setQuery("");
    onChange(s);
  };
  const typed = query.trim();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="min-w-0 shrink justify-between gap-1.5 font-normal" data-testid={testId}>
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Branch, tag or commit" value={query} onValueChange={setQuery} data-testid={`${testId}-input`} />
          <CommandList>
            <CommandEmpty>No refs match</CommandEmpty>
            {!typed && (
              <CommandGroup>
                <Choice source={{ kind: "working" }} label="Working tree" value={value} onPick={pick} />
                <Choice source={{ kind: "staged" }} label="Staged" value={value} onPick={pick} />
                <Choice source={{ kind: "merge-base" }} label={baseLabel} note="merge base" value={value} onPick={pick} />
                <Choice source={{ kind: "ref", ref: "HEAD" }} label="HEAD" value={value} onPick={pick} />
              </CommandGroup>
            )}
            {typed && <Choice source={{ kind: "ref", ref: typed }} label={typed} note="use this" value={value} onPick={pick} />}
            {open && <Refs projectId={projectId} query={typed} value={value} onPick={pick} />}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
