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
    postgresSchema: null,
    postgresTenancy: null,
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
    errorCode: null,
    rowsCopied: 0,
  },
  postgresPreflight: null,
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

  it("preflights a dedicated database, redacts its URL, and shows admin copy", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sqliteStatus), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            redactedUrl:
              "postgres://operator:%E2%80%A2%E2%80%A2%E2%80%A2@localhost/library",
            preflight: {
              state: "permission_denied",
              serverReachable: true,
              serverVersion: "17.5",
              roleName: "operator",
              vector: {
                installed: false,
                available: true,
                installable: false,
              },
              schema: {
                name: "instagram_saves",
                exists: true,
                usable: true,
                creatable: false,
              },
              engineMigration: "absent",
              code: "PERMISSION_DENIED",
              message:
                "This database account cannot enable search support.",
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<StorageEngineSwitcher />);
    const input = await screen.findByLabelText("PostgreSQL connection URL");
    await userEvent.type(
      input,
      "postgres://operator:very-secret@localhost/library",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Check connection" }),
    );

    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      postgresSchema: "instagram_saves",
      postgresTenancy: "database",
    });
    expect(
      await screen.findByText(
        "This database account cannot enable search support.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("CREATE EXTENSION IF NOT EXISTS vector;"),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("very-secret");
    expect(
      screen.getByRole("button", { name: "Migrate library to PostgreSQL" }),
    ).toBeDisabled();
  });
});
