import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage-engine-switcher", () => ({
  StorageEngineSwitcher: () => <div>PostgreSQL connection URL</div>,
}));

import { AdvancedStorage } from "./advanced-storage";

describe("AdvancedStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hides PostgreSQL controls from the default Settings view", () => {
    render(
      <AdvancedStorage initialEnabled={false} lockedByEnvironment={false} />,
    );

    expect(
      screen.queryByText("PostgreSQL connection URL"),
    ).not.toBeInTheDocument();
  });

  it("reveals PostgreSQL controls after explicit opt-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ enabled: true }), { status: 200 }),
      ),
    );
    render(
      <AdvancedStorage initialEnabled={false} lockedByEnvironment={false} />,
    );

    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /I run my own PostgreSQL server/i,
      }),
    );

    expect(await screen.findByText("PostgreSQL connection URL")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/advanced-storage",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );
  });
});
