import type { PluginDirsView } from "@/api/plugin";
import { tildify } from "@/lib/path";

/** The plugins folder in words: the daemon's real one ("~" for the home), else "the plugins folder" until it is known. */
export function pluginsDirWords(dirs: PluginDirsView | null): string {
  return dirs?.pluginsDir ? tildify(dirs.pluginsDir) : "the plugins folder";
}

/** A plugin's data folder (<dataDir>/<name>, "~" for the home); null until the daemon said where. */
export function pluginDataDirWords(dirs: PluginDirsView | null, name: string): string | null {
  return dirs?.dataDir ? `${tildify(dirs.dataDir.replace(/\/+$/, ""))}/${name}` : null;
}
