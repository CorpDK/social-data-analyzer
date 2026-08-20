import { describe, expect, it } from "vitest";
import { normalizeEmbedding } from "../../search/embeddings";
import {
  cosineDistanceToL2Distance,
  l2DistanceToCosineDistance,
} from "./search";

function l2(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index]! - right[index]!;
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
  }
  return 1 - dot;
}

describe("Postgres distance parity", () => {
  it("maps normalized SQLite L2 distance to pgvector cosine distance", () => {
    const left = normalizeEmbedding(Float32Array.from([1, 2, 3, 4]));
    const right = normalizeEmbedding(Float32Array.from([4, 1, 2, 3]));
    const sqliteDistance = l2(left, right);
    const postgresDistance = cosine(left, right);

    expect(l2DistanceToCosineDistance(sqliteDistance)).toBeCloseTo(
      postgresDistance,
      6,
    );
    expect(cosineDistanceToL2Distance(postgresDistance)).toBeCloseTo(
      sqliteDistance,
      6,
    );
  });

  it("maps the default SQLite absolute cutoff to cosine", () => {
    expect(l2DistanceToCosineDistance(1.22)).toBeCloseTo(0.7442, 6);
  });
});
