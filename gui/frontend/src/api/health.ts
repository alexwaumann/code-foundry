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

export async function ping(conn: DaemonConnection = daemon): Promise<HealthView> {
  try {
    const client = await conn.client(HealthService);
    return toHealthView(await client.ping({}));
  } catch (err) {
    conn.invalidate();
    throw err;
  }
}
