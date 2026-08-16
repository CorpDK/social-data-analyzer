import {
  ImportCancelledError,
  type ImportProgress,
  type ImportRunOptions,
} from "./types";

export async function emitProgress(
  onProgress: ImportRunOptions["onProgress"],
  progress: ImportProgress,
) {
  await onProgress?.(progress);
}

export function throwIfCancelled(shouldCancel?: () => boolean) {
  if (shouldCancel?.()) throw new ImportCancelledError();
}

export async function yieldToEventLoop() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
