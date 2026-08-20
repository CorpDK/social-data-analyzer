import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/use-job-sse", () => ({
  useJobSse: vi.fn(),
}));

import { StorageEngineSwitcher } from "./storage-engine-switcher";

const sqliteStatus = {
  current: {
    engine: "sqlite",
    displayName: "SQLite",
    sqlitePath: "/tmp/library.db",
    postgresUrl: null,
    source: "environment",
  },
  postgresMigration: "absent",
  startupError: null,
  job: {
    state: "idle",
    action: null,
    sourceEngine: "sqlite",
    targetEngine: null,
    phase: "idle",
    percent: 0,
    message: "No engine switch is running.",
    error: null,
    rowsCopied: 0,
  },
  freshConfirmation: "SWITCH EMPTY",
};

describe("StorageEngineSwitcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("presents migration as the primary default and fresh as optional", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(sqliteStatus), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    render(<StorageEngineSwitcher />);

    expect(
      await screen.findByRole("button", {
        name: "Migrate library to PostgreSQL",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Type SWITCH EMPTY/)).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Switch empty / start fresh" }),
    );

    expect(
      screen.getByText(/activate an unused, empty PostgreSQL target/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm empty switch" }),
    ).toBeDisabled();
  });

  it("shows migration progress and failure status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...sqliteStatus,
            job: {
              ...sqliteStatus.job,
              state: "failed",
              action: "migrate",
              targetEngine: "postgres",
              phase: "failed",
              percent: 42,
              message: "Storage engine switch failed.",
              error: "Target integrity failed.",
            },
          }),
          { status: 200 },
        ),
      ),
    );

    render(<StorageEngineSwitcher />);

    await waitFor(() => {
      expect(screen.getByText("42%")).toBeInTheDocument();
    });
    expect(screen.getByText("Target integrity failed.")).toBeInTheDocument();
  });
});
