import { useEffect } from "react";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import { PageHead } from "@/components/settings/PageHead";
import { loadMemory } from "@/stores/memory";
import { RememberedSection } from "./RememberedSection";

/**
 * Settings › Memory (docs/notes/memory-page.md): the app memory, the standing preferences
 * threads were told to remember. Read and forget only; the events stream keeps it live and
 * the page reads it once more on open (a hand edit since the last read shows).
 */
export function MemoryPage({ page }: { schema: SettingsSchemaView; page: SettingPageView }) {
  useEffect(() => {
    void loadMemory();
  }, []);
  return (
    <>
      <PageHead page={page} />
      <RememberedSection />
    </>
  );
}
