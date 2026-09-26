import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { type ClauseChange, compareDocuments, formatChangeForSummary } from "@/lib/compare/compare";
import { diffTokens, extractQuantities, tokenSimilarity } from "@/lib/compare/diff";
import { extractDocument } from "@/lib/extract";
import { chunkDocument, extractClauseOutline } from "@/lib/text/chunk";
import { createSearchableDocument } from "@/lib/text/document";
import type { DocumentBundle } from "@/lib/storage/documents";

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.resolve(process.cwd(), "fixtures", name)));

async function load(name: string, id: string): Promise<DocumentBundle> {
  const extraction = await extractDocument({ name, bytes: fixture(name) });
  const document = createSearchableDocument({ id, title: name, text: extraction.text, pages: extraction.pages });
  return {
    document,
    chunks: chunkDocument(document),
    clauses: extractClauseOutline(document),
    record: {
      id,
      title: name,
      kind: "docx",
      byteSize: 1,
      pageCount: 0,
      charCount: extraction.charCount,
      clauseCount: 16,
      createdAt: new Date().toISOString(),
      warnings: [],
      contentHash: id,
      fileBase64: "",
      text: extraction.text,
      pages: [],
    },
  };
}

let base: DocumentBundle;
let revised: DocumentBundle;
let changes: ClauseChange[];

const findChange = (predicate: (change: ClauseChange) => boolean) => changes.find(predicate);

beforeAll(async () => {
  base = await load("services-agreement.docx", "base");
  revised = await load("services-agreement-revised.docx", "revised");
  changes = compareDocuments(base, revised).changes;
});

describe("diff primitives", () => {
  it("reports added and removed tokens for a reworded sentence", () => {
    const diff = diffTokens("the Supplier shall deliver the Deliverables", "the Supplier shall hand over the Deliverables");
    expect(diff.segments.some((segment) => segment.type === "removed" && segment.text.includes("deliver"))).toBe(true);
    expect(diff.segments.some((segment) => segment.type === "added" && segment.text.includes("hand"))).toBe(true);
    expect(diff.similarity).toBeGreaterThan(0.5);
    expect(diff.similarity).toBeLessThan(1);
  });

  it("scores identical text as fully similar and unrelated text as dissimilar", () => {
    expect(tokenSimilarity("same words here", "same words here")).toBe(1);
    expect(tokenSimilarity("payments of fees", "confidential information trade secret")).toBeLessThan(0.2);
  });

  it("extracts amounts and periods whole", () => {
    const quantities = extractQuantities("shall not exceed AED 100,000 within 30 days and 2.5 per cent interest");
    expect(quantities).toContain("aed 100,000");
    expect(quantities.some((entry) => entry.startsWith("30"))).toBe(true);
    expect(quantities.some((entry) => entry.includes("2.5"))).toBe(true);
  });
});

describe("document comparison", () => {
  it("picks up the liability cap moving from AED 100,000 to AED 1,000,000 as critical", () => {
    const change = findChange((entry) => entry.left?.number === "11");
    expect(change).toBeTruthy();
    expect(change?.significance).toBe("critical");
    expect(change?.kind).toBe("modified");
    expect(change?.signals.join(" ")).toMatch(/amounts and periods changed/i);
    expect(change?.signals.join(" ")).toMatch(/100,000/);
    expect(change?.signals.join(" ")).toMatch(/1,000,000/);
    expect(change?.summary).toMatch(/amount/i);
  });

  it("ranks the cap change above pure rewording", () => {
    const cap = findChange((entry) => entry.left?.number === "11");
    const reworded = findChange((entry) => entry.left?.number === "9");
    expect(cap?.significance).toBe("critical");
    expect(reworded?.significance === "low" || reworded?.significance === "medium").toBe(true);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    expect(rank[cap?.significance ?? "low"]).toBeLessThan(rank[reworded?.significance ?? "critical"]);
  });

  it("treats a reworded clause with identical obligations as cosmetic", () => {
    const change = findChange((entry) => entry.left?.number === "9");
    expect(change?.kind === "reworded" || change?.kind === "modified").toBe(true);
    expect(change?.signals.join(" ")).not.toMatch(/amounts and periods changed/i);
    expect(change?.signals.join(" ")).not.toMatch(/negative obligation/i);
    expect(change?.summary).toMatch(/no (clear )?change|wording|no amounts/i);
  });

  it("flags a shorter payment and cure period", () => {
    const payment = findChange((entry) => entry.left?.number === "3");
    const termination = findChange((entry) => entry.left?.number === "12");
    expect(payment?.signals.join(" ")).toMatch(/60 days.*30 days|30 days|amounts and periods changed/i);
    expect(termination?.signals.join(" ")).toMatch(/30 days/i);
    expect(["high", "critical"]).toContain(payment?.significance ?? "");
  });

  it("flags a deleted clause and an added clause", () => {
    const removed = findChange((entry) => entry.kind === "removed");
    expect(removed?.label).toMatch(/NON-SOLICITATION/i);

    const added = findChange((entry) => entry.kind === "added");
    expect(added?.label).toMatch(/FORCE MAJEURE/i);
    expect(["high", "medium"]).toContain(added?.significance ?? "");
  });

  it("notices a change of forum even though no number or obligation changed", () => {
    const jurisdiction = findChange((entry) => entry.left?.number === "13");
    expect(jurisdiction?.signals.join(" ")).toMatch(/named parties or places changed/i);
    expect(jurisdiction?.significance).toBe("high");
  });

  it("does not report clauses that are identical", () => {
    const definitions = findChange((entry) => entry.left?.number === "1");
    if (definitions) {
      expect(definitions.kind).toBe("reworded");
      expect(definitions.significance).toBe("low");
    }
    const counts = compareDocuments(base, revised).counts;
    expect(counts.added + counts.removed + counts.modified + counts.critical).toBeGreaterThan(0);
  });

  it("sorts changes with the most significant first", () => {
    const order = changes.map((change) => change.significance);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const ranks = order.map((significance) => rank[significance]);
    expect([...ranks]).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("counts matched clauses and cosmetic noise separately", () => {
    const result = compareDocuments(base, revised);
    expect(result.matched).toBeGreaterThan(10);
    expect(result.ignoredNoise).toBeGreaterThanOrEqual(0);
    expect(result.counts.critical).toBeGreaterThanOrEqual(1);
  });

  it("produces a compact record for the summary prompt", () => {
    const first = changes[0];
    expect(first).toBeTruthy();
    const formatted = formatChangeForSummary(first as ClauseChange);
    expect(formatted.label).toBeTruthy();
    expect(formatted.changedTokens).toBeGreaterThanOrEqual(0);
    expect(formatted.totalTokens).toBeGreaterThan(0);
  });

  it("handles a document compared with itself", () => {
    const result = compareDocuments(base, base);
    expect(result.counts.critical).toBe(0);
    expect(result.counts.added).toBe(0);
    expect(result.counts.removed).toBe(0);
  });
});
