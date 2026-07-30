"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeSwitcher } from "@/components/theme-switcher";

const links = [
  { href: "/", label: "Overview" },
  { href: "/saves", label: "Saves" },
  { href: "/likes", label: "Likes" },
  { href: "/indexes", label: "Indexes" },
  { href: "/schemas", label: "Schemas" },
  { href: "/import", label: "Import" },
  { href: "/settings", label: "Settings" },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-[var(--line)]/80 bg-[var(--surface)]/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
        <Link href="/" className="group flex items-baseline gap-2">
          <span className="font-[family-name:var(--font-fraunces)] text-xl tracking-tight text-[var(--ink)]">
            Saves Ledger
          </span>
          <span className="hidden text-xs uppercase tracking-[0.18em] text-[var(--muted)] sm:inline">
            Instagram archive
          </span>
        </Link>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:gap-3">
          <nav
            className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-transparent bg-[var(--chip)] p-1 sm:gap-1"
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
                  aria-current={active ? "page" : undefined}
                  className={`shrink-0 rounded-full px-2.5 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chip)] sm:px-3.5 ${
                    active
                      ? "control-active"
                      : "text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--ink)]"
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
