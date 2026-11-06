import { HealthService, type PingResponse } from "@/gen/codefoundry/v1/health_pb";
import { daemon, type DaemonConnection } from "./endpoint";

/** View model for HealthService.Ping. Generated types stay inside src/api. */
export interface HealthView {
  pid: number;
  version: string;
  uptimeSeconds: number;
}

export function toHealthView(res: PingResponse): HealthView {
  const uptime = res.uptime;
  return {
    pid: res.pid,
    version: res.version,
    uptimeSeconds: uptime ? Number(uptime.seconds) + uptime.nanos / 1e9 : 0,
  };
}

/** Past this a daemon that accepts connections and never answers reads as down: a stopped process still accepts them. */
export const PING_TIMEOUT_MS = 5_000;

export async function ping(conn: DaemonConnection = daemon): Promise<HealthView> {
  try {
    const client = await conn.client(HealthService);
    return toHealthView(await client.ping({}, { timeoutMs: PING_TIMEOUT_MS }));
  } catch (err) {
    conn.invalidate();
    throw err;
  }
}

/** Where the daemon places the first-run welcome page (HealthService.Version; "" from a daemon that does not say). */
export async function welcomePage(conn: DaemonConnection = daemon): Promise<string> {
  const client = await conn.client(HealthService);
  return (await client.version({})).welcomePage;
}
