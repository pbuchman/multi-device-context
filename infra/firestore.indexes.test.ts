import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type IndexDefinition = {
  order: "ASCENDING" | "DESCENDING";
  queryScope: "COLLECTION" | "COLLECTION_GROUP";
};

type FieldOverride = {
  collectionGroup: string;
  fieldPath: string;
  indexes: IndexDefinition[];
};

describe("Firestore deleting indexes", () => {
  it("keeps live client collection queries and bounded cleanup collection-group queries indexed", () => {
    const config = JSON.parse(
      readFileSync(new URL("./firestore.indexes.json", import.meta.url), "utf8"),
    ) as { fieldOverrides: FieldOverride[] };
    const expected: IndexDefinition[] = [
      { order: "ASCENDING", queryScope: "COLLECTION" },
      { order: "DESCENDING", queryScope: "COLLECTION" },
      { order: "ASCENDING", queryScope: "COLLECTION_GROUP" },
    ];

    for (const collectionGroup of ["contexts", "items"]) {
      const override = config.fieldOverrides.find(
        (candidate) =>
          candidate.collectionGroup === collectionGroup && candidate.fieldPath === "deleting",
      );
      expect(override?.indexes).toEqual(expected);
    }
  });
});
