"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import {
  parseBrowseFilterOptions,
  parseBrowseListResponse,
  parseSearchProviderInfo,
  type BrowseFilterOptions,
  type BrowseListResponse,
} from "@/lib/browse-dto";
import type {
  EmbeddingProvider,
  SearchProviderInfoDto,
} from "@/lib/search/status-dto";

type LikeRow = {
  id: number;
  href: string;
  shortcode: string | null;
  mediaType: string;
  authorUsername: string | null;
  likedAt: string | null;
  source: string;
  alsoSaved?: boolean;
};

type ProviderInfo = SearchProviderInfoDto;
type LikesResponse = BrowseListResponse<LikeRow>;
type FilterOptions = BrowseFilterOptions;

const PROVIDER_STORAGE_KEY = "instagram-likes-search-provider";

const PROVIDER_LABELS: Record<EmbeddingProvider, string> = {
  local: "Local (basic)",
  ollama: "Ollama",
  openai: "OpenAI",
  voyage: "Voyage",
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function isProvider(value: string | null): value is EmbeddingProvider {
  return (
    value === "local" ||
    value === "ollama" ||
    value === "openai" ||
    value === "voyage"
  );
}

function readStoredProvider(): EmbeddingProvider | null {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
  return isProvider(stored) ? stored : null;
}

function resolveProvider(
  providerParam: string | null,
  providers: ProviderInfo | null,
): EmbeddingProvider {
  if (
    isProvider(providerParam) &&
    (!providers || providers.available.includes(providerParam))
  ) {
    return providerParam;
  }
  const stored = readStoredProvider();
  if (stored && (!providers || providers.available.includes(stored))) {
    return stored;
  }
  return providers?.default ?? "local";
}

export function LikesBrowser({
  keywordTech = "FTS5",
  vectorTech = "sqlite-vec",
}: {
  keywordTech?: string;
  vectorTech?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const [data, setData] = useState<LikesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<ProviderInfo | null>(null);
  const [filters, setFilters] = useState<FilterOptions>({ authors: [] });
  const [error, setError] = useState<string | null>(null);

  const q = searchParams.get("q") ?? "";
  const type = searchParams.get("type") ?? "all";
  const author = searchParams.get("author") ?? "";
  const page = Number(searchParams.get("page") ?? "1");
  const providerParam = searchParams.get("provider");
  const searchKey = searchParams.toString();

  const activeProvider = resolveProvider(providerParam, providers);

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (!value || value === "all") next.delete(key);
        else next.set(key, value);
      }
      if (!("page" in patch)) next.delete("page");
      if ("provider" in patch) {
        const providerValue =
          patch.provider ?? providers?.default ?? "local";
        if (isProvider(providerValue)) {
          window.localStorage.setItem(PROVIDER_STORAGE_KEY, providerValue);
        }
      }
      const nextKey = next.toString();
      if (nextKey === searchParams.toString()) return;
      startTransition(() => {
        router.push(nextKey ? `/likes?${nextKey}` : "/likes");
      });
    },
    [router, searchParams, providers],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadProviders() {
      try {
        const res = await fetch("/api/search/providers?library=likes");
        if (!res.ok) return;
        const json = parseSearchProviderInfo(await res.json());
        if (!cancelled && json) setProviders(json);
      } catch {
        // optional
      }
    }

    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadFilters() {
      try {
        const res = await fetch("/api/likes?filters=1");
        if (!res.ok) return;
        const json = parseBrowseFilterOptions(await res.json());
        if (!cancelled && json) setFilters(json);
      } catch {
        // optional
      }
    }

    void loadFilters();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!providers) return;

    const desired = resolveProvider(providerParam, providers);
    const next = new URLSearchParams(searchKey);
    if (desired === providers.default) next.delete("provider");
    else next.set("provider", desired);

    const nextKey = next.toString();
    if (nextKey === searchKey) {
      window.localStorage.setItem(PROVIDER_STORAGE_KEY, desired);
      return;
    }

    window.localStorage.setItem(PROVIDER_STORAGE_KEY, desired);
    startTransition(() => {
      router.replace(nextKey ? `/likes?${nextKey}` : "/likes");
    });
  }, [providers, providerParam, router, searchKey]);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setError(null);
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (type) params.set("type", type);
        if (author) params.set("author", author);
        if (activeProvider) params.set("provider", activeProvider);
        params.set("page", String(page || 1));
        params.set("pageSize", "25");

        const res = await fetch(`/api/likes?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Failed to load likes");
        const json = parseBrowseListResponse<LikeRow>(await res.json());
        if (!json) throw new Error("Invalid likes response");
        if (!controller.signal.aborted) setData(json);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [q, type, author, page, activeProvider]);

  const providerOptions = providers?.available ?? ["local"];
  const showProviderControl = providerOptions.length > 1;
  const isRefreshing = pending || loading;

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Browse
        </p>
        <h1 className="font-[family-name:var(--font-fraunces)] text-4xl tracking-tight">
          Liked media
        </h1>
        <p className="text-[var(--muted)]">
          Keyword ({keywordTech}) and semantic ({vectorTech}) search over creators,
          shortcodes, and like sources. The Saved column marks media also in
          your saves library.
        </p>
      </section>

      <form
        className="grid gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          updateParams({
            q: String(form.get("q") || "") || null,
            type: String(form.get("type") || "all"),
            author: String(form.get("author") || "") || null,
          });
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--muted)]">Search</span>
          <input
            name="q"
            defaultValue={q}
            placeholder="creator, shortcode…"
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
            <option value="story">Stories</option>
            <option value="comment">Comments</option>
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
        <div className="sm:col-span-2 lg:col-span-3">
          <button
            type="submit"
            className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm text-[var(--surface)]"
          >
            Apply filters
          </button>
        </div>
      </form>

      {showProviderControl ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
          <div>
            <p className="text-sm font-medium text-[var(--ink)]">
              Semantic search provider
            </p>
            <p className="text-xs text-[var(--muted)]">
              Keyword search stays on {keywordTech}. Only the likes vector path changes.
            </p>
          </div>
          <div
            className="flex flex-wrap items-center gap-1 rounded-full bg-[var(--chip)] p-1"
            role="group"
            aria-label="Semantic search provider"
          >
            {providerOptions.map((option) => {
              const selected = activeProvider === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    window.localStorage.setItem(PROVIDER_STORAGE_KEY, option);
                    updateParams({
                      provider:
                        option === providers?.default ? null : option,
                    });
                  }}
                  className={`rounded-full px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    selected
                      ? "bg-[var(--ink)] text-[var(--surface)]"
                      : "text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {PROVIDER_LABELS[option]}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
      ) : null}

      <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
        <div className="flex flex-col gap-1 border-b border-[var(--line)] px-4 py-3 text-sm text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between">
          <span>
            {data
              ? `${data.total.toLocaleString()}${data.totalCapped ? "+" : ""} item${data.total === 1 && !data.totalCapped ? "" : "s"}`
              : "Loading…"}
            {data?.totalCapped && data.searchCap
              ? ` · top ${data.searchCap.toLocaleString()} matches`
              : ""}
            {data?.searchMode &&
            data.searchMode !== "none" &&
            q.trim() !== ""
              ? ` · ${data.searchMode} search`
              : ""}
            {data?.searchProvider &&
            data.searchMode &&
            !["none", "like", "fts"].includes(data.searchMode)
              ? ` · ${data.searchProvider}`
              : ""}
            {data?.providerFallback ? " · local fallback" : ""}
            {data && isRefreshing ? " · updating" : ""}
          </span>
          {data && data.totalPages > 1 ? (
            <span>
              Page {data.page} / {data.totalPages}
            </span>
          ) : null}
        </div>

        {data?.providerFallbackReason ? (
          <p className="border-b border-[var(--line)] px-4 py-2 text-xs text-[var(--muted)]">
            {data.providerFallbackReason}
          </p>
        ) : null}

        <div
          className={`overflow-x-auto transition-opacity ${
            data && isRefreshing ? "opacity-60" : "opacity-100"
          }`}
        >
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Creator</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Liked</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Saved</th>
                <th className="px-4 py-3 font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((item) => (
                <tr key={item.id} className="border-t border-[var(--line)]/80">
                  <td className="px-4 py-3 font-medium">
                    {item.authorUsername ? (
                      <Link
                        href={`/likes?author=${encodeURIComponent(item.authorUsername)}`}
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
                    {formatDate(item.likedAt)}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {item.source.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-3">
                    {item.alsoSaved ? (
                      <Link
                        href={
                          item.shortcode
                            ? `/saves?q=${encodeURIComponent(item.shortcode)}`
                            : `/saves?q=${encodeURIComponent(item.href)}`
                        }
                        className="inline-flex rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:underline"
                      >
                        Saved
                      </Link>
                    ) : (
                      <span className="text-[var(--muted)]">—</span>
                    )}
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
                    colSpan={6}
                    className="px-4 py-10 text-center text-[var(--muted)]"
                  >
                    No likes match these filters. Re-import an export that
                    includes likes activity.
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
