"use client";

import { useMemo, useState } from "react";
import type { JsonSchemaNode, SchemaFileEntry } from "@/lib/schema-catalog";

type ImportOptionClient = {
  id: number;
  filename: string;
  importedAt: string;
  status: string;
  schemaFileCount: number;
  hasSchemas: boolean;
};

type Props = {
  initialMode: "all" | "import";
  initialImportId: number | null;
  imports: ImportOptionClient[];
  files: SchemaFileEntry[];
  emptyReason: string | null;
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function typeLabel(type: JsonSchemaNode["type"] | string) {
  return Array.isArray(type) ? type.join(" | ") : String(type);
}

function folderOf(path: string) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function basename(path: string) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function SchemaTreeNode({
  name,
  node,
  depth = 0,
}: {
  name: string;
  node: JsonSchemaNode;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren =
    Boolean(node.keys && Object.keys(node.keys).length > 0) ||
    Boolean(node.items);

  const meta: string[] = [];
  if (node.optional) meta.push("optional");
  if (node.truncated) meta.push("depth-capped");
  if (node.homogeneous === false) meta.push("mixed");
  if (node.arrayLength) {
    const { min, max, sample } = node.arrayLength;
    meta.push(
      min === max
        ? `len ${min} (sample ${sample})`
        : `len ${min}–${max} (sample ${sample})`,
    );
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => hasChildren && setOpen((v) => !v)}
        className={`flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left text-sm transition ${
          hasChildren
            ? "hover:bg-[var(--chip)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            : "cursor-default"
        }`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        aria-expanded={hasChildren ? open : undefined}
      >
        <span className="mt-0.5 w-3 shrink-0 font-mono text-xs text-[var(--muted)]">
          {hasChildren ? (open ? "▾" : "▸") : "·"}
        </span>
        <span className="min-w-0 flex-1 break-all font-mono text-[13px] text-[var(--ink)]">
          {name}
        </span>
        <span className="shrink-0 rounded bg-[var(--chip)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--muted)]">
          {typeLabel(node.type)}
        </span>
      </button>
      {(meta.length > 0 || node.sample !== undefined) && (
        <div
          className="pb-1 font-mono text-[11px] text-[var(--muted)]"
          style={{ paddingLeft: `${depth * 12 + 28}px` }}
        >
          {meta.length > 0 ? <span>{meta.join(" · ")}</span> : null}
          {node.sample !== undefined ? (
            <span className="ml-2 text-[var(--ink)]/70">
              e.g. {JSON.stringify(node.sample)}
            </span>
          ) : null}
        </div>
      )}
      {open && node.keys
        ? Object.entries(node.keys)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => (
              <SchemaTreeNode
                key={key}
                name={key}
                node={child}
                depth={depth + 1}
              />
            ))
        : null}
      {open && node.items ? (
        <SchemaTreeNode name="[]" node={node.items} depth={depth + 1} />
      ) : null}
    </div>
  );
}

export function SchemaExplorer({
  initialMode,
  initialImportId,
  imports,
  files: initialFiles,
  emptyReason: initialEmptyReason,
}: Props) {
  const [mode, setMode] = useState<"all" | "import">(initialMode);
  const [importId, setImportId] = useState<number | null>(initialImportId);
  const [files, setFiles] = useState(initialFiles);
  const [emptyReason, setEmptyReason] = useState(initialEmptyReason);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    initialFiles[0]?.filePath ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function loadCatalog(next: { mode: "all" | "import"; importId: number | null }) {
    setLoading(true);
    setError(null);
    try {
      const param =
        next.mode === "all" || next.importId == null
          ? "all"
          : String(next.importId);
      const res = await fetch(`/api/schemas?importId=${encodeURIComponent(param)}`);
      if (!res.ok) throw new Error(`Failed to load schemas (${res.status})`);
      const json = (await res.json()) as {
        mode: "all" | "import";
        importId: number | null;
        files: SchemaFileEntry[];
        emptyReason: string | null;
      };
      setMode(json.mode);
      setImportId(json.importId);
      setFiles(json.files);
      setEmptyReason(json.emptyReason);
      setSelectedPath((prev) => {
        if (prev && json.files.some((f) => f.filePath === prev)) return prev;
        return json.files[0]?.filePath ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schemas");
    } finally {
      setLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.filePath.toLowerCase().includes(q));
  }, [files, filter]);

  const grouped = useMemo(() => {
    const map = new Map<string, SchemaFileEntry[]>();
    for (const file of filtered) {
      const folder = folderOf(file.filePath) || "(root)";
      const list = map.get(folder) ?? [];
      list.push(file);
      map.set(folder, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const selected = files.find((f) => f.filePath === selectedPath) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1.5 text-sm">
          <span className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
            View
          </span>
          <select
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            value={mode === "all" ? "all" : String(importId ?? "")}
            disabled={loading}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "all") {
                void loadCatalog({ mode: "all", importId: null });
              } else {
                void loadCatalog({ mode: "import", importId: Number(value) });
              }
            }}
          >
            <option value="all">All imports (aggregated)</option>
            {imports.map((imp) => (
              <option
                key={imp.id}
                value={imp.id}
                disabled={!imp.hasSchemas}
              >
                #{imp.id} · {imp.filename}
                {imp.hasSchemas
                  ? ` (${imp.schemaFileCount} files)`
                  : " — re-import to capture schemas"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-[180px] flex-1 flex-col gap-1.5 text-sm">
          <span className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
            Filter paths
          </span>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="e.g. messages, saved…"
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          />
        </label>
      </div>

      {error ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
      ) : null}

      {emptyReason ? (
        <div className="rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface)]/60 px-5 py-8 text-sm text-[var(--muted)]">
          <p className="font-[family-name:var(--font-fraunces)] text-xl text-[var(--ink)]">
            No schemas yet
          </p>
          <p className="mt-2 max-w-xl">{emptyReason}</p>
        </div>
      ) : (
        <div className="grid min-h-[420px] gap-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] lg:grid-cols-[minmax(240px,320px)_1fr]">
          <aside className="max-h-[70vh] overflow-y-auto border-b border-[var(--line)] lg:border-b-0 lg:border-r">
            <div className="sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
              JSON files{loading ? " · loading…" : ` · ${filtered.length}`}
            </div>
            <ul className="py-1">
              {grouped.map(([folder, group]) => (
                <li key={folder} className="mb-1">
                  <p className="px-3 pb-1 pt-2 font-mono text-[11px] text-[var(--muted)]">
                    {folder}/
                  </p>
                  <ul>
                    {group.map((file) => {
                      const active = file.filePath === selectedPath;
                      return (
                        <li key={file.filePath}>
                          <button
                            type="button"
                            onClick={() => setSelectedPath(file.filePath)}
                            className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] ${
                              active
                                ? "bg-[var(--accent-soft)] text-[var(--ink)]"
                                : "text-[var(--ink)] hover:bg-[var(--chip)]"
                            }`}
                          >
                            <span className="break-all font-mono text-[13px]">
                              {basename(file.filePath)}
                            </span>
                            <span className="text-[11px] text-[var(--muted)]">
                              {typeLabel(file.topLevelType)} ·{" "}
                              {formatBytes(file.byteSize)}
                              {file.imports && file.imports.length > 1
                                ? ` · ${file.imports.length} imports`
                                : ""}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          </aside>

          <section className="max-h-[70vh] overflow-y-auto px-4 py-4 sm:px-5">
            {selected ? (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <p className="font-mono text-xs text-[var(--muted)]">
                    {selected.filePath}
                  </p>
                  <h2 className="font-[family-name:var(--font-fraunces)] text-2xl tracking-tight">
                    {basename(selected.filePath)}
                  </h2>
                  <p className="text-sm text-[var(--muted)]">
                    Top-level{" "}
                    <span className="text-[var(--ink)]">
                      {typeLabel(selected.topLevelType)}
                    </span>
                    {" · "}
                    {formatBytes(selected.byteSize)}
                    {selected.truncatedRead ? " · sample read (large file)" : ""}
                  </p>
                  {mode === "all" && selected.imports?.length ? (
                    <p className="text-sm text-[var(--muted)]">
                      In imports:{" "}
                      {selected.imports
                        .map((imp) => `#${imp.id} ${imp.filename}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                  {selected.parseError ? (
                    <p className="text-sm text-[var(--warn)]">
                      Parse note: {selected.parseError}
                    </p>
                  ) : null}
                </div>

                {selected.schema ? (
                  <div className="rounded-xl border border-[var(--line)]/80 bg-[var(--bg)]/40 py-2">
                    <SchemaTreeNode name="$" node={selected.schema} />
                  </div>
                ) : (
                  <p className="text-sm text-[var(--muted)]">
                    No structural schema could be inferred for this file.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                Select a JSON file to inspect its schema.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
