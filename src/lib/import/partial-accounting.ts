/**
 * Count rows already committed for a draft import. Batch writes commit per
 * chunk, so a failed/cancelled import may leave durable rows even when the
 * job ends as failed.
 */
import { getSqlite } from "../db";

export type PersistedImportCounts = {
  /** Saves newly inserted by this import. */
  itemsAdded: number;
  /** Saves whose last_seen points at this import but first_seen does not. */
  itemsUpdated: number;
  /** Likes newly inserted by this import. */
  likesAdded: number;
  /** Likes refreshed by this import (last_seen only). */
  likesUpdated: number;
};

export function countPersistedImportRows(
  importId: number,
): PersistedImportCounts {
  const sqlite = getSqlite();

  const itemsAdded = (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM saved_items WHERE first_seen_import_id = ?`,
      )
      .get(importId) as { c: number }
  ).c;

  const itemsTouched = (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM saved_items WHERE last_seen_import_id = ?`,
      )
      .get(importId) as { c: number }
  ).c;

  const likesAdded = (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM liked_items WHERE first_seen_import_id = ?`,
      )
      .get(importId) as { c: number }
  ).c;

  const likesTouched = (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM liked_items WHERE last_seen_import_id = ?`,
      )
      .get(importId) as { c: number }
  ).c;

  return {
    itemsAdded,
    itemsUpdated: Math.max(0, itemsTouched - itemsAdded),
    likesAdded,
    likesUpdated: Math.max(0, likesTouched - likesAdded),
  };
}

/** Operator-facing note when durable writes outlive a failed/cancelled job. */
export function formatPartialImportMessage(
  baseMessage: string,
  counts: PersistedImportCounts,
): string {
  const touched =
    counts.itemsAdded +
    counts.itemsUpdated +
    counts.likesAdded +
    counts.likesUpdated;
  if (touched === 0) return baseMessage;

  const parts: string[] = [];
  if (counts.itemsAdded || counts.itemsUpdated) {
    parts.push(
      `${counts.itemsAdded} save${counts.itemsAdded === 1 ? "" : "s"} added` +
        (counts.itemsUpdated
          ? `, ${counts.itemsUpdated} updated`
          : ""),
    );
  }
  if (counts.likesAdded || counts.likesUpdated) {
    parts.push(
      `${counts.likesAdded} like${counts.likesAdded === 1 ? "" : "s"} added` +
        (counts.likesUpdated
          ? `, ${counts.likesUpdated} updated`
          : ""),
    );
  }

  return (
    `${baseMessage} Partial rows already committed (${parts.join("; ")}). ` +
    `Re-import the same export to reconcile, or reset the library when idle ` +
    `(Settings → Danger zone) after cancelling any active jobs.`
  );
}
