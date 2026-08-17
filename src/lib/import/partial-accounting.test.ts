import { describe, expect, it } from "vitest";
import { formatPartialImportMessage } from "./partial-accounting";

describe("formatPartialImportMessage", () => {
  it("leaves the base message when nothing persisted", () => {
    expect(
      formatPartialImportMessage("Import failed", {
        itemsAdded: 0,
        itemsUpdated: 0,
        likesAdded: 0,
        likesUpdated: 0,
      }),
    ).toBe("Import failed");
  });

  it("documents partial durable rows with recovery hint", () => {
    const message = formatPartialImportMessage("Import cancelled", {
      itemsAdded: 12,
      itemsUpdated: 3,
      likesAdded: 1,
      likesUpdated: 0,
    });
    expect(message).toContain("Import cancelled");
    expect(message).toContain("12 saves added, 3 updated");
    expect(message).toContain("1 like added");
    expect(message).toMatch(/Partial rows already committed/);
    expect(message).toMatch(/Re-import|reset the library/i);
  });
});
