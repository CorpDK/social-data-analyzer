import { describe, expect, it } from "vitest";
import {
  inferSchemaFromValue,
  scrubSchemaSamples,
  type JsonSchemaNode,
} from "./json-schema-infer";

describe("schema structural samples", () => {
  it("does not persist string samples", () => {
    const schema = inferSchemaFromValue({
      username: "secret_user",
      href: "https://www.instagram.com/p/AbCdEf/",
      count: 3,
      ok: true,
      empty: null,
    });
    expect(schema.keys?.username?.type).toBe("string");
    expect(schema.keys?.username?.sample).toBeUndefined();
    expect(schema.keys?.href?.sample).toBeUndefined();
    expect(schema.keys?.count?.sample).toBe(3);
    expect(schema.keys?.ok?.sample).toBe(true);
    expect(schema.keys?.empty?.sample).toBeNull();
  });

  it("scrubs legacy string samples from stored trees", () => {
    const legacy = {
      type: "object",
      keys: {
        caption: { type: "string", sample: "private caption text" },
        n: { type: "number", sample: 7 },
      },
    } as unknown as JsonSchemaNode;
    const scrubbed = scrubSchemaSamples(legacy);
    expect(scrubbed.keys?.caption?.sample).toBeUndefined();
    expect(scrubbed.keys?.n?.sample).toBe(7);
  });
});
