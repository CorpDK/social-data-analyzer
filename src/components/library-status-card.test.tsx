import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LibraryStatus } from "@/lib/storage";
import { LibraryStatusCard } from "./library-status-card";

function status(state: LibraryStatus["state"]): LibraryStatus {
  return {
    engine: "sqlite",
    displayName: "SQLite",
    location: "/tmp/instagram-saves.db",
    locationFolder: "/tmp",
    state,
    appliedMigrations: 1,
    pendingMigrations: 0,
    technicalDetail:
      "Drizzle journal SCHEMA_VERSION user_version ME-3 __drizzle_migrations",
  };
}

describe("LibraryStatusCard", () => {
  it.each([
    ["up_to_date", "Up to date", "Your library is ready"],
    ["updating", "Updating", "Updating your library…"],
    [
      "generation_break",
      "Library too old",
      "This version of the app can't open your library",
    ],
    [
      "apply_failed",
      "Update failed",
      "We couldn't finish updating your library",
    ],
  ] as const)("renders plain-language %s copy", (state, label, heading) => {
    render(<LibraryStatusCard initialStatus={status(state)} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  });

  it("keeps implementation jargon out of default recovery copy", () => {
    const { container } = render(
      <LibraryStatusCard initialStatus={status("apply_failed")} />,
    );

    expect(container.textContent).not.toMatch(
      /Drizzle|journal|SCHEMA_VERSION|user_version|ME-3|__drizzle_migrations/i,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText(/copy the library file/i)).toBeInTheDocument();
  });

  it("does not offer retry for a library that is too old", () => {
    render(<LibraryStatusCard initialStatus={status("generation_break")} />);

    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });
});
