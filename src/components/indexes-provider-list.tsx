"use client";

import Link from "next/link";
import type {
  EmbeddingJobDto,
  EmbeddingProvider,
  IndexHealth,
  LibraryIndexStatusDto,
  ProviderIndexStatusDto,
} from "@/lib/search/status-dto";

const PROVIDER_LABELS: Record<EmbeddingProvider, string> = {
  local: "Local (basic)",
  ollama: "Ollama",
  openai: "OpenAI",
  voyage: "Voyage",
};

function healthStyles(health: IndexHealth): string {
  switch (health) {
    case "ready":
      return "bg-[var(--accent-soft)] text-[var(--accent)]";
    case "partial":
      return "bg-[var(--chip)] text-[var(--warn)]";
    case "stale":
      return "bg-[var(--chip)] text-[var(--warn)]";
    case "empty":
      return "bg-[var(--chip)] text-[var(--muted)]";
    case "unavailable":
      return "bg-[var(--chip)] text-[var(--muted)]";
  }
}

function formatUpdatedAt(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString();
}

function providerAvailabilityLabel(provider: ProviderIndexStatusDto): string {
  if (provider.configured) return "Configured";
  if (provider.hasCredentials && !provider.enabled) {
    return "Credentials saved · Disabled";
  }
  if (provider.enabled && !provider.hasCredentials) {
    return "Enabled · Missing credentials";
  }
  return "Not configured";
}

type IndexesProviderListProps = {
  libraries: LibraryIndexStatusDto[];
  openTargets: Set<string>;
  activeJob: EmbeddingJobDto | null;
  pending: string | null;
  primaryButton: string;
  secondaryButton: string;
  onRequestReindex: (target: string) => void;
};

export function IndexesProviderList({
  libraries,
  openTargets,
  activeJob,
  pending,
  primaryButton,
  secondaryButton,
  onRequestReindex,
}: IndexesProviderListProps) {
  return (
    <div className="space-y-6">
      {libraries.map((library) => (
        <section key={library.library} className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-[family-name:var(--font-fraunces)] text-lg">
              {library.libraryLabel} indexes
            </h2>
            <div className="flex flex-wrap gap-3 text-xs text-[var(--muted)]">
              <span>
                Items:{" "}
                <span className="font-medium text-[var(--ink)]">
                  {library.totalItems}
                </span>
              </span>
              <span>
                FTS rows:{" "}
                <span className="font-medium text-[var(--ink)]">
                  {library.ftsCount}
                </span>
              </span>
              {library.estimatedVectorMb != null &&
              library.estimatedVectorMb >= 1 ? (
                <span>~{Math.round(library.estimatedVectorMb)} MB vectors</span>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            {library.providers.map((provider) => {
              const label = PROVIDER_LABELS[provider.provider];
              const target = provider.target ?? provider.provider;
              const providerBusy = openTargets.has(target);
              const canReindex =
                provider.configured &&
                !providerBusy &&
                pending === null &&
                !provider.reindexRefused;
              const model =
                provider.stored?.model ?? provider.expected?.model ?? "—";
              const dimensions =
                provider.stored?.dimensions ??
                provider.tableDimensions ??
                provider.expected?.dimensions ??
                "—";
              const endpoint =
                provider.stored?.endpoint ??
                provider.expected?.endpoint ??
                (provider.provider === "local" ? "(local hasher)" : "—");
              return (
                <section
                  key={target}
                  className="grid min-w-0 gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 md:grid-cols-[minmax(132px,1.15fr)_minmax(112px,0.9fr)_minmax(88px,1fr)_minmax(64px,0.45fr)_minmax(88px,0.9fr)_minmax(96px,0.85fr)_auto] md:items-center md:gap-x-3 md:gap-y-0 lg:gap-x-4"
                  aria-labelledby={`provider-${target}`}
                >
                  <div className="min-w-0 self-center">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        id={`provider-${target}`}
                        className="font-[family-name:var(--font-fraunces)] text-base leading-tight"
                      >
                        {label}
                      </h3>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide ${healthStyles(provider.health)}`}
                      >
                        {provider.health}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11px] leading-snug text-[var(--muted)]">
                      {providerAvailabilityLabel(provider)}
                      {provider.indexPresent
                        ? " · Index present"
                        : " · No vectors yet"}
                      {providerBusy
                        ? activeJob?.target === target
                          ? " · Reindexing"
                          : " · Queued"
                        : ""}
                    </p>
                    {provider.hint ? (
                      <p className="mt-0.5 truncate text-[11px] leading-snug text-[var(--muted)]">
                        {provider.hint}
                      </p>
                    ) : null}
                    {provider.reindexRefused && provider.reindexRefuseReason ? (
                      <p className="mt-0.5 text-[11px] leading-snug text-[var(--danger)]">
                        {provider.reindexRefuseReason}
                      </p>
                    ) : provider.reindexStrongWarning ? (
                      <p className="mt-0.5 text-[11px] leading-snug text-[var(--warn)]">
                        {provider.reindexStrongWarning}
                      </p>
                    ) : null}
                  </div>

                  <div className="min-w-0 self-center">
                    <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-[var(--muted)]">
                      <span>
                        Coverage{" "}
                        <span className="font-medium text-[var(--ink)]">
                          {provider.embeddedCount}/{provider.totalItems}
                        </span>
                      </span>
                      <span>{provider.coveragePercent}%</span>
                    </div>
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-[var(--chip)]"
                      role="progressbar"
                      aria-label={`${library.libraryLabel} ${label} index coverage`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={provider.coveragePercent}
                    >
                      <div
                        className={`h-full rounded-full transition-[width] duration-300 ${
                          provider.health === "ready"
                            ? "bg-[var(--accent)]"
                            : provider.health === "stale" ||
                                provider.health === "partial"
                              ? "bg-[var(--warn)]"
                              : "bg-[var(--line)]"
                        }`}
                        style={{
                          width: `${Math.min(100, provider.coveragePercent)}%`,
                        }}
                      />
                    </div>
                  </div>

                  <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4 md:contents">
                    <div className="min-w-0 self-center">
                      <dt className="text-[var(--muted)]">Model</dt>
                      <dd
                        className="truncate font-[family-name:var(--font-ibm)] text-xs leading-snug text-[var(--ink)]"
                        title={model}
                      >
                        {model}
                      </dd>
                    </div>
                    <div className="min-w-0 self-center">
                      <dt className="text-[var(--muted)]">Dimensions</dt>
                      <dd className="font-[family-name:var(--font-ibm)] text-xs leading-snug text-[var(--ink)]">
                        {dimensions}
                      </dd>
                    </div>
                    <div className="min-w-0 self-center">
                      <dt className="text-[var(--muted)]">Endpoint</dt>
                      <dd
                        className="truncate font-[family-name:var(--font-ibm)] text-xs leading-snug text-[var(--ink)]"
                        title={endpoint}
                      >
                        {endpoint}
                      </dd>
                    </div>
                    <div className="min-w-0 self-center">
                      <dt className="text-[var(--muted)]">Last updated</dt>
                      <dd className="truncate text-xs leading-snug text-[var(--ink)]">
                        {formatUpdatedAt(provider.stored?.updatedAt ?? null)}
                      </dd>
                    </div>
                  </dl>

                  <div className="flex items-center justify-start self-center md:justify-end md:min-w-20">
                    {provider.configured ? (
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={!canReindex && !provider.reindexRefused}
                        title={
                          provider.reindexRefused
                            ? (provider.reindexRefuseReason ?? undefined)
                            : undefined
                        }
                        onClick={() => onRequestReindex(target)}
                      >
                        {pending === target
                          ? "Starting…"
                          : providerBusy
                            ? activeJob?.target === target
                              ? "Running…"
                              : "Queued"
                            : provider.reindexRefused
                              ? "Blocked"
                              : provider.health === "ready"
                                ? "Rebuild"
                                : "Reindex"}
                      </button>
                    ) : (
                      <Link className={secondaryButton} href="/settings">
                        Enable
                      </Link>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
