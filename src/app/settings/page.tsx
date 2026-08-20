import { DangerZone } from "@/components/danger-zone";
import { DbMaintenance } from "@/components/db-maintenance";
import { SettingsForm } from "@/components/settings-form";
import { StorageEngineSwitcher } from "@/components/storage-engine-switcher";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let engine = null;
  let storageError: string | null = null;
  try {
    engine = await (await getStorage()).maintenance.engineInfo();
  } catch (error) {
    storageError =
      error instanceof Error ? error.message : "The selected storage engine is unavailable.";
  }
  return (
    <div className="space-y-5">
      <section className="space-y-1.5">
        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
          Search configuration
        </p>
        <h1 className="font-[family-name:var(--font-fraunces)] text-3xl tracking-tight sm:text-4xl">
          Settings
        </h1>
        <p className="max-w-3xl text-sm text-[var(--muted)]">
          Configure semantic search defaults, credentials, models, and connections.
          Secrets stay in your system keyring and are never returned after saving.
        </p>
      </section>

      <StorageEngineSwitcher />
      {storageError ? (
        <p className="rounded-xl border border-[var(--danger)]/40 bg-[var(--surface)] px-4 py-3 text-sm text-[var(--danger)]" role="alert">
          The selected storage engine is blocked: {storageError}
        </p>
      ) : (
        <>
          <SettingsForm />
          {engine ? <DbMaintenance engine={engine} /> : null}
          <DangerZone />
        </>
      )}
    </div>
  );
}
