import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The toggle of folded text: `label` and a chevron down while folded, "Show less" and a chevron up once open. */
export function FoldToggle({ folded, label, testId, className, onClick }: { folded: boolean; label: string; testId: string; className?: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <Button variant="outline" size="xs" className={cn("bg-cf-surface", className)} aria-expanded={!folded} data-testid={testId} onClick={onClick}>
      {folded ? label : "Show less"}
      {folded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
    </Button>
  );
}
