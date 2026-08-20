import {
  ENGINE_SWITCH_CHANNEL,
  getEngineSwitchStatus,
} from "@/lib/storage/engine-switch";
import { createJobSseResponse } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return createJobSseResponse({
    channel: ENGINE_SWITCH_CHANNEL,
    getSnapshot: getEngineSwitchStatus,
    fingerprint: (status) =>
      [
        status.state,
        status.phase,
        status.step,
        status.percent,
        status.rowsCopied,
        status.message,
        status.error,
      ].join("|"),
    isIdle: (status) => status.state !== "running",
    signal: request.signal,
  });
}
