/**
 * Count rows already committed for a draft import. Batch writes commit per
 * chunk; on fail/cancel we roll back *inserts* (`first_seen_import_id`) so the
 * catalog is not left with durable new rows from an aborted run. Residual
 * last_seen-only updates may remain until re-import.
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
        `SELECT count(*) AS c FROM saved WHERE first_seen_import_id = ?`,
      )
      .get(importId) as { c: number }
  ).c;

  const itemsTouched = (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM saved WHERE last_seen_import_id = ?`,
      )
      .get(importId) as { c: number }
  ).c;

  const likesAdded = (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM liked WHERE first_seen_import_id = ?`,
      )
      .get(importId) as { c: number }
  ).c;

  const likesTouched = (
    sqlite
      .prepare(
        `SELECT count(*) AS c FROM liked WHERE last_seen_import_id = ?`,
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

export type PartialImportMessageOptions = {
  /** Inserts removed during fail/cancel rollback. */
  rolledBackSaves?: number;
  rolledBackLikes?: number;
};

/** Operator-facing note after fail/cancel (post-rollback residual counts). */
export function formatPartialImportMessage(
  baseMessage: string,
  residual: PersistedImportCounts,
  options?: PartialImportMessageOptions,
): string {
  const rolledBackSaves = options?.rolledBackSaves ?? 0;
  const rolledBackLikes = options?.rolledBackLikes ?? 0;
  const residualTouched =
    residual.itemsAdded +
    residual.itemsUpdated +
    residual.likesAdded +
    residual.likesUpdated;

  const parts: string[] = [];
  if (rolledBackSaves || rolledBackLikes) {
    const rb: string[] = [];
    if (rolledBackSaves) {
      rb.push(
        `${rolledBackSaves} new save${rolledBackSaves === 1 ? "" : "s"}`,
      );
    }
    if (rolledBackLikes) {
      rb.push(
        `${rolledBackLikes} new like${rolledBackLikes === 1 ? "" : "s"}`,
      );
    }
    parts.push(`Rolled back ${rb.join(" and ")} introduced by this import.`);
  }

  if (residualTouched > 0) {
    const residualParts: string[] = [];
    if (residual.itemsAdded || residual.itemsUpdated) {
      residualParts.push(
        `${residual.itemsAdded} save${residual.itemsAdded === 1 ? "" : "s"} added` +
          (residual.itemsUpdated
            ? `, ${residual.itemsUpdated} updated`
            : ""),
      );
    }
    if (residual.likesAdded || residual.likesUpdated) {
      residualParts.push(
        `${residual.likesAdded} like${residual.likesAdded === 1 ? "" : "s"} added` +
          (residual.likesUpdated
            ? `, ${residual.likesUpdated} updated`
            : ""),
      );
    }
    parts.push(
      `Residual catalog touch (${residualParts.join("; ")}). ` +
        `Re-import the same export to reconcile, discard inserts from this import’s detail page, ` +
        `or reset the library when idle (Settings → Danger zone) after cancelling active jobs.`,
    );
  } else if (rolledBackSaves || rolledBackLikes) {
    parts.push("No durable new rows remain from this import.");
  }

  if (parts.length === 0) return baseMessage;
  return `${baseMessage} ${parts.join(" ")}`;
}
