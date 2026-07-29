"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeSwitcher } from "@/components/theme-switcher";

const links = [
  { href: "/", label: "Overview" },
  { href: "/saves", label: "Saves" },
  { href: "/import", label: "Import" },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-[var(--line)]/80 bg-[var(--surface)]/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="group flex items-baseline gap-2">
          <span className="font-[family-name:var(--font-fraunces)] text-xl tracking-tight text-[var(--ink)]">
            Saves Ledger
          </span>
          <span className="hidden text-xs uppercase tracking-[0.18em] text-[var(--muted)] sm:inline">
            Instagram archive
          </span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <nav
            className="flex items-center gap-1 rounded-full bg-[var(--chip)] p-1"
            aria-label="Primary"
          >
            {links.map((link) => {
              const active =
                link.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`rounded-full px-3.5 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    active
                      ? "bg-[var(--ink)] text-[var(--surface)]"
                      : "text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <ThemeSwitcher />
        </div>
      </div>
    </header>
  );
}
