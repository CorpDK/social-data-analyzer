import { AdvancedStorage } from "@/components/advanced-storage";
import { DangerZone } from "@/components/danger-zone";
import { DbMaintenance } from "@/components/db-maintenance";
import { LibraryStatusCard } from "@/components/library-status-card";
import { SettingsForm } from "@/components/settings-form";
import { getLibraryStatus, getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const libraryStatus = await getLibraryStatus();
  let engine = null;
  let advancedEnabled = Boolean(
    process.env.INSTAGRAM_SAVES_DATABASE_URL?.trim(),
  );
  const lockedByEnvironment = advancedEnabled;
  if (libraryStatus.state === "up_to_date") {
    const storage = await getStorage();
    engine = await storage.maintenance.engineInfo();
    advancedEnabled =
      advancedEnabled ||
      (await storage.settings.getAppSetting("postgres_advanced_enabled")) ===
        "1";
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

      <LibraryStatusCard
        initialStatus={libraryStatus}
        showTechnicalDetails={advancedEnabled}
      />
      {libraryStatus.state === "up_to_date" ? (
        <>
          <SettingsForm />
          {engine ? <DbMaintenance engine={engine} /> : null}
          <AdvancedStorage
            initialEnabled={advancedEnabled}
            lockedByEnvironment={lockedByEnvironment}
          />
          <DangerZone />
        </>
      ) : null}
    </div>
  );
}
