import { DangerZone } from "@/components/danger-zone";
import { DbMaintenance } from "@/components/db-maintenance";
import { SettingsForm } from "@/components/settings-form";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
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

      <SettingsForm />
      <DbMaintenance />
      <DangerZone />
    </div>
  );
}
