import { useEffect } from "react";
import { HealthPanel } from "@/components/HealthPanel";
import { startHealthPolling } from "@/stores/health";

export function App() {
  useEffect(() => startHealthPolling(2000), []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background p-8 text-foreground">
      <h1 className="text-2xl font-semibold tracking-tight">Code Foundry</h1>
      <HealthPanel />
    </main>
  );
}
