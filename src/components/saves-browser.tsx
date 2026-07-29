"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

type SaveRow = {
  id: number;
  href: string;
  shortcode: string | null;
  mediaType: string;
  authorUsername: string | null;
  savedAt: string | null;
  collections: string[];
};

type SavesResponse = {
  items: SaveRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type FilterOptions = {
  authors: string[];
  collections: string[];
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function SavesBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [data, setData] = useState<SavesResponse | null>(null);
  const [filters, setFilters] = useState<FilterOptions>({
    authors: [],
    collections: [],
  });
  const [error, setError] = useState<string | null>(null);

  const q = searchParams.get("q") ?? "";
  const type = searchParams.get("type") ?? "all";
  const author = searchParams.get("author") ?? "";
  const collection = searchParams.get("collection") ?? "";
  const page = Number(searchParams.get("page") ?? "1");

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (!value || value === "all") next.delete(key);
        else next.set(key, value);
      }
      if (!("page" in patch)) next.delete("page");
      startTransition(() => {
        router.push(`/saves?${next.toString()}`);
      });
    },
    [router, searchParams],
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setError(null);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (type) params.set("type", type);
        if (author) params.set("author", author);
        if (collection) params.set("collection", collection);
        params.set("page", String(page || 1));
        params.set("pageSize", "25");

        const [savesRes, importsRes] = await Promise.all([
          fetch(`/api/saves?${params.toString()}`),
          fetch("/api/imports"),
        ]);

        if (!savesRes.ok) throw new Error("Failed to load saves");
        const savesJson = (await savesRes.json()) as SavesResponse;
        const importsJson = (await importsRes.json()) as {
          filters?: FilterOptions;
        };

        if (!cancelled) {
          setData(savesJson);
          setFilters(importsJson.filters ?? { authors: [], collections: [] });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [q, type, author, collection, page]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Browse
        </p>
        <h1 className="font-[family-name:var(--font-fraunces)] text-4xl tracking-tight">
          Saved media
        </h1>
        <p className="text-[var(--muted)]">
          Filter by type, creator, or collection. Open any item on Instagram.
        </p>
      </section>

      <form
        className="grid gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          updateParams({
            q: String(form.get("q") || "") || null,
            type: String(form.get("type") || "all"),
            author: String(form.get("author") || "") || null,
            collection: String(form.get("collection") || "") || null,
          });
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Search</span>
          <input
            name="q"
            defaultValue={q}
            placeholder="username, shortcode…"
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2 outline-none ring-[var(--accent)] focus:ring-2"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Type</span>
          <select
            name="type"
            defaultValue={type}
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2 outline-none ring-[var(--accent)] focus:ring-2"
          >
            <option value="all">All</option>
            <option value="post">Posts</option>
            <option value="reel">Reels</option>
            <option value="igtv">IGTV</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Creator</span>
          <select
            name="author"
            defaultValue={author}
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2 outline-none ring-[var(--accent)] focus:ring-2"
          >
            <option value="">All creators</option>
            {filters.authors.map((name) => (
              <option key={name} value={name}>
                @{name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Collection</span>
          <select
            name="collection"
            defaultValue={collection}
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--bg)] px-3 py-2 outline-none ring-[var(--accent)] focus:ring-2"
          >
            <option value="">All collections</option>
            {filters.collections.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="sm:col-span-2 lg:col-span-4">
          <button
            type="submit"
            className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm text-[var(--surface)]"
          >
            Apply filters
          </button>
        </div>
      </form>

      {error ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
      ) : null}

      <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3 text-sm text-[var(--muted)]">
          <span>
            {data ? `${data.total} item${data.total === 1 ? "" : "s"}` : "Loading…"}
            {pending ? " · updating" : ""}
          </span>
          {data && data.totalPages > 1 ? (
            <span>
              Page {data.page} / {data.totalPages}
            </span>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Creator</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Saved</th>
                <th className="px-4 py-3 font-medium">Collections</th>
                <th className="px-4 py-3 font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((item) => (
                <tr key={item.id} className="border-t border-[var(--line)]/80">
                  <td className="px-4 py-3 font-medium">
                    {item.authorUsername ? (
                      <Link
                        href={`/saves?author=${encodeURIComponent(item.authorUsername)}`}
                        className="hover:text-[var(--accent)]"
                      >
                        @{item.authorUsername}
                      </Link>
                    ) : (
                      <span className="text-[var(--muted)]">unknown</span>
                    )}
                  </td>
                  <td className="px-4 py-3 capitalize text-[var(--muted)]">
                    {item.mediaType}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {formatDate(item.savedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {item.collections.length === 0 ? (
                        <span className="text-[var(--muted)]">—</span>
                      ) : (
                        item.collections.map((name) => (
                          <Link
                            key={name}
                            href={`/saves?collection=${encodeURIComponent(name)}`}
                            className="rounded-full bg-[var(--chip)] px-2 py-0.5 text-xs hover:bg-[var(--accent-soft)]"
                          >
                            {name}
                          </Link>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--accent)] hover:underline"
                    >
                      Open
                    </a>
                  </td>
                </tr>
              ))}
              {data && data.items.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-10 text-center text-[var(--muted)]"
                  >
                    No saves match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {data && data.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-[var(--line)] px-4 py-3">
            <button
              type="button"
              disabled={data.page <= 1}
              className="rounded-full border border-[var(--line)] px-3 py-1.5 text-sm disabled:opacity-40"
              onClick={() => updateParams({ page: String(data.page - 1) })}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={data.page >= data.totalPages}
              className="rounded-full border border-[var(--line)] px-3 py-1.5 text-sm disabled:opacity-40"
              onClick={() => updateParams({ page: String(data.page + 1) })}
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
