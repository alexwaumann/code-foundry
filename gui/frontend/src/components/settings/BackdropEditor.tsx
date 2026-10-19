import { useEffect, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { pickFiles } from "@/api/app";
import { listDirectories } from "@/api/filesystem";
import { importBackdrop, listBackdrops, removeBackdrop, type BackdropView } from "@/api/settings";
import { errorMessage } from "@/api/stream";
import { useHosted } from "@/components/compose/useHostFiles";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CUSTOM_BACKDROP, forgetBackdrop, useBackdropUrl } from "@/stores/backdrops";
import { KEYS, saveSettings, useSettingValue } from "@/stores/settings";
import type { EditorProps } from "./editor";
import { EnumEditor } from "./editors";

/** The open panel starts in ~/Pictures when there is one, else (an empty start) in home. */
async function picturesDir(): Promise<string> {
  try {
    const { entries } = await listDirectories("~/Pictures");
    return entries.find((e) => e.name === "Pictures")?.path ?? "";
  } catch {
    return "";
  }
}

/** A refusal as the line under the gallery: the picked file's name, then the daemon's reason without its code. */
function refusal(path: string, err: unknown): string {
  const name = path.split("/").pop() ?? path;
  return `${name}: ${errorMessage(err).replace(/^(invalid argument|not found): /, "")}`;
}

/**
 * appearance.backdrop: the Forest / None / Custom select, then the images the user added
 * (appearance.backdrop_file picks one) as thumbnails, and "Add image…". Clicking a
 * thumbnail shows it (custom + that file); its × deletes the copy at once (the original
 * is untouched, and adding it again is one click). Adding opens the host's file panel and
 * imports the first file picked, which the daemon selects. In a browser there is no
 * panel (a file input gives no path), so the button is disabled.
 */
export function BackdropEditor(props: EditorProps) {
  const { value, setError } = props;
  const file = useSettingValue(KEYS.backdropFile) ?? "";
  const hosted = useHosted();
  const [images, setImages] = useState<BackdropView[] | null>(null);
  const [adding, setAdding] = useState(false);
  // Bumped after an import or a removal: the list is fetched again.
  const [listed, setListed] = useState(0);
  const refresh = () => {
    setListed((n) => n + 1);
  };
  useEffect(() => {
    let live = true;
    listBackdrops().then(
      (list) => {
        if (live) setImages(list);
      },
      (err: unknown) => {
        if (live) setError(errorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [listed, setError]);

  const select = (name: string) => {
    setError(null);
    if (value === CUSTOM_BACKDROP && file === name) return;
    void saveSettings({ [KEYS.backdrop]: CUSTOM_BACKDROP, [KEYS.backdropFile]: name }).then((res) => {
      if (!res.ok) setError(res.error);
    });
  };

  // Custom with no image chosen (or the chosen one gone) shows the newest one.
  const choose = (raw: string) => {
    const newest = images?.at(-1);
    if (raw === CUSTOM_BACKDROP && newest && !images?.some((b) => b.name === file)) select(newest.name);
    else props.commit(raw);
  };

  const remove = async (name: string) => {
    setError(null);
    try {
      await removeBackdrop(name);
    } catch (err) {
      setError(refusal(name, err));
    }
    forgetBackdrop(name);
    refresh();
  };

  const add = async () => {
    setError(null);
    const path = (await pickFiles(await picturesDir()))?.[0];
    if (!path) return;
    setAdding(true);
    try {
      await importBackdrop(path);
    } catch (err) {
      setError(refusal(path, err));
    } finally {
      setAdding(false);
    }
    refresh();
  };

  const addButton = (
    <Button
      variant="outline"
      size="sm"
      className="w-full"
      disabled={!hosted || adding}
      onClick={() => {
        void add();
      }}
      data-testid="backdrop-add"
    >
      <ImagePlus /> {adding ? "Adding…" : "Add image…"}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="backdrop-editor">
      <EnumEditor {...props} commit={choose} />
      {images && images.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Backdrop images" data-testid="backdrop-gallery">
          {images.map((b, i) => (
            <BackdropThumb
              key={b.name}
              image={b}
              index={i}
              selected={value === CUSTOM_BACKDROP && b.name === file}
              onSelect={() => {
                select(b.name);
              }}
              onRemove={() => {
                void remove(b.name);
              }}
            />
          ))}
        </div>
      )}
      {hosted ? (
        addButton
      ) : (
        <Tip label="Available in the app">
          {/* A disabled button gets no pointer events: the span takes the hover. */}
          <span className="block" tabIndex={0}>
            {addButton}
          </span>
        </Tip>
      )}
    </div>
  );
}

function BackdropThumb({ image, index, selected, onSelect, onRemove }: { image: BackdropView; index: number; selected: boolean; onSelect: () => void; onRemove: () => void }) {
  const { url } = useBackdropUrl(image.name);
  const size = image.width > 0 && image.height > 0 ? ` (${String(image.width)}×${String(image.height)})` : "";
  return (
    <div className="group relative" data-testid="backdrop-thumb" data-name={image.name} data-selected={selected || undefined}>
      <button
        type="button"
        aria-label={`Show image ${String(index + 1)}${size}`}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "block aspect-video w-full overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          selected ? "border-primary ring-2 ring-primary" : "border-border hover:border-foreground/40",
        )}
      >
        {url && <img src={url} alt="" draggable={false} className="size-full object-cover" />}
      </button>
      <Tip label="Remove">
        <button
          type="button"
          aria-label={`Remove image ${String(index + 1)}`}
          onClick={onRemove}
          className="absolute top-1 right-1 rounded-full bg-background/85 p-0.5 text-muted-foreground opacity-0 shadow-sm group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
        >
          <X className="size-3" />
        </button>
      </Tip>
    </div>
  );
}
