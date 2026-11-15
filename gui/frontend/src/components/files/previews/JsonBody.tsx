import { FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileEmptyState } from "../states";
import { errorExcerpt, jsonOf, type JsonError } from "./data/json";
import { JsonTree } from "./data/JsonTree";
import { SOURCE, type PreviewBodyProps } from "./types";

/** The JSON kind's body: the document as a tree, or where it stops being JSON. */
export function JsonBody({ file, path, name, onMode }: PreviewBodyProps) {
  const parsed = jsonOf(file, path);
  if (!parsed.ok) return <InvalidJson text={file.text ?? ""} error={parsed.error} onSource={() => { onMode(SOURCE.id); }} />;
  return <JsonTree key={path} root={parsed.value} fill label={`${name} as a tree`} testId="file-json-tree" />;
}

function InvalidJson({ text, error, onSource }: { text: string; error: JsonError; onSource: () => void }) {
  const { line, caret } = errorExcerpt(text, error);
  return (
    <FileEmptyState
      icon={FileWarning}
      heading="Not valid JSON"
      detail={
        <>
          {error.message} · line {error.line}, column {error.column}
        </>
      }
      testId="file-json-invalid"
    >
      <div className="flex w-full flex-col items-center gap-3">
        {line.trim() !== "" && (
          <pre className="max-w-full overflow-x-auto rounded-md bg-cf-surface-sunken px-3 py-2 text-left text-body-sm text-code select-text" data-testid="file-json-excerpt">
            {line}
            {"\n"}
            <span className="text-cf-error-text">{`${" ".repeat(Math.max(0, caret))}^`}</span>
          </pre>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onSource}
          data-testid="file-json-source"
        >
          Show source
        </Button>
      </div>
    </FileEmptyState>
  );
}
