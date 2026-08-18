import { describe, expect, it } from "vitest";
import { formatPartialImportMessage } from "./partial-accounting";

describe("formatPartialImportMessage", () => {
  it("leaves the base message when nothing persisted or rolled back", () => {
    expect(
      formatPartialImportMessage("Import failed", {
        itemsAdded: 0,
        itemsUpdated: 0,
        likesAdded: 0,
        likesUpdated: 0,
      }),
    ).toBe("Import failed");
  });

  it("documents rollback of inserts with clean residual", () => {
    const message = formatPartialImportMessage(
      "Import cancelled",
      {
        itemsAdded: 0,
        itemsUpdated: 0,
        likesAdded: 0,
        likesUpdated: 0,
      },
      { rolledBackSaves: 12, rolledBackLikes: 1 },
    );
    expect(message).toContain("Import cancelled");
    expect(message).toMatch(/Rolled back 12 new saves and 1 new like/);
    expect(message).toMatch(/No durable new rows remain/);
  });

  it("documents residual last_seen updates with recovery hint", () => {
    const message = formatPartialImportMessage(
      "Import cancelled",
      {
        itemsAdded: 0,
        itemsUpdated: 3,
        likesAdded: 0,
        likesUpdated: 0,
      },
      { rolledBackSaves: 12, rolledBackLikes: 0 },
    );
    expect(message).toContain("Import cancelled");
    expect(message).toMatch(/Rolled back 12 new saves/);
    expect(message).toMatch(/3 updated/);
    expect(message).toMatch(/discard inserts|Re-import|reset the library/i);
  });
});
