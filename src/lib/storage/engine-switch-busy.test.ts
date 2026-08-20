import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startImportJobFromSpool } from "../import/jobs";
import { startReindexJob } from "../search/jobs";

const globalForSwitch = globalThis as unknown as {
  instagramSavesEngineSwitch?: {
    state: "running" | "idle";
    [key: string]: unknown;
  };
};

afterEach(() => {
  globalForSwitch.instagramSavesEngineSwitch = undefined;
});

describe("engine-switch busy guards", () => {
  it("blocks imports and removes a spool created during the race window", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-switch-busy-"));
    const spoolPath = path.join(dir, "upload.zip");
    fs.writeFileSync(spoolPath, "zip");
    globalForSwitch.instagramSavesEngineSwitch = { state: "running" };

    const result = await startImportJobFromSpool({
      filename: "instagram.zip",
      kind: "zip",
      spoolPath,
      contentHash: "hash",
      byteLength: 3,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(fs.existsSync(spoolPath)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("blocks reindex enqueue while migration runs", async () => {
    globalForSwitch.instagramSavesEngineSwitch = { state: "running" };
    await expect(startReindexJob("saves-local")).resolves.toMatchObject({
      ok: false,
      status: 409,
    });
  });
});
