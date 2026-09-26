import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ExtractionError, MAX_UPLOAD_BYTES, extractDocument } from "@/lib/extract";
import { searchChunks } from "@/lib/search/rank";
import { hashBytes } from "@/lib/storage/repository";
import { chunkDocument, extractClauseOutline } from "@/lib/text/chunk";
import { createSearchableDocument } from "@/lib/text/document";
import { verifyQuote } from "@/lib/text/verify";

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.resolve(process.cwd(), "fixtures", name)));

async function loadFixture(name: string) {
  const extraction = await extractDocument({ name, bytes: fixture(name) });
  const document = createSearchableDocument({
    id: "fixture",
    title: name,
    text: extraction.text,
    pages: extraction.pages,
  });
  return { extraction, document, chunks: chunkDocument(document) };
}

describe("extraction", () => {
  it("extracts a multi-page PDF with a page map", async () => {
    const { extraction } = await loadFixture("services-agreement.pdf");
    expect(extraction.kind).toBe("pdf");
    expect(extraction.pageCount).toBeGreaterThanOrEqual(4);
    expect(extraction.pages).toHaveLength(extraction.pageCount);
    expect(extraction.charCount).toBeGreaterThan(10_000);
    expect(extraction.text).toContain("MASTER SERVICES AGREEMENT");
    // Page spans must tile the text.
    for (const page of extraction.pages) {
      expect(page.start).toBeLessThan(page.end);
      expect(extraction.text.slice(page.start, page.end).trim().length).toBeGreaterThan(0);
    }
  });

  it("extracts DOCX text and says there is no page layout to cite", async () => {
    const { extraction } = await loadFixture("services-agreement.docx");
    expect(extraction.kind).toBe("docx");
    expect(extraction.pages).toHaveLength(0);
    expect(extraction.text).toContain("LIMITATION OF LIABILITY");
    expect(extraction.warnings.join(" ")).toMatch(/no fixed page layout/i);
  });

  it("leaves the uploaded bytes intact, so size and content hash are real", async () => {
    // pdf.js transfers the document buffer to its worker, which detaches the
    // caller's view. Handed the original bytes, extraction leaves them
    // zero-length, so every PDF is stored as 0 bytes under one shared content
    // hash and duplicate detection then fires on unrelated contracts.
    const first = fixture("services-agreement.pdf");
    const second = fixture("short-nda.pdf");
    await extractDocument({ name: "services-agreement.pdf", bytes: first });
    await extractDocument({ name: "short-nda.pdf", bytes: second });

    expect(first.length).toBeGreaterThan(10_000);
    expect(second.length).toBeGreaterThan(100);
    expect(hashBytes(first)).not.toBe(hashBytes(second));
  });

  it("refuses a scanned PDF instead of storing an empty document", async () => {
    await expect(loadFixture("scanned-contract.pdf")).rejects.toThrowError(ExtractionError);
    try {
      await loadFixture("scanned-contract.pdf");
    } catch (error) {
      const failure = error as ExtractionError;
      expect(failure.code).toBe("no-text");
      expect(failure.userMessage).toMatch(/no extractable text/i);
      expect(failure.hints.join(" ")).toMatch(/optical character recognition is not built in/i);
    }
  });

  it("rejects unsupported file types with a clear message", async () => {
    const bytes = new TextEncoder().encode("Just some notes about a contract.");
    await expect(extractDocument({ name: "notes.txt", bytes })).rejects.toMatchObject({
      code: "unsupported-type",
    });
    await expect(extractDocument({ name: "notes.txt", bytes })).rejects.toThrowError(/not supported/i);
  });

  it("tells the user what to do about a legacy .doc file", async () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    await expect(extractDocument({ name: "contract.doc", bytes })).rejects.toMatchObject({
      code: "unsupported-type",
    });
    try {
      await extractDocument({ name: "contract.doc", bytes });
    } catch (error) {
      expect((error as ExtractionError).hints.join(" ")).toMatch(/save as .docx/i);
    }
  });

  it("refuses a file that is named .pdf but is not one", async () => {
    const bytes = new TextEncoder().encode("this is plainly not a pdf at all, but it is named like one");
    await expect(extractDocument({ name: "fake.pdf", bytes })).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses a damaged PDF", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nthis is not a real pdf body\n%%EOF");
    await expect(extractDocument({ name: "broken.pdf", bytes })).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses an empty file and an oversized file", async () => {
    await expect(extractDocument({ name: "empty.pdf", bytes: new Uint8Array(0) })).rejects.toMatchObject({
      code: "unsupported-type",
    });
    const huge = new Uint8Array(MAX_UPLOAD_BYTES + 10);
    huge.set([0x25, 0x50, 0x44, 0x46], 0);
    await expect(extractDocument({ name: "huge.pdf", bytes: huge })).rejects.toMatchObject({ code: "too-large" });
  });
});

describe("chunking", () => {
  it("splits on clause boundaries and keeps offsets exact", async () => {
    const { document, chunks } = await loadFixture("services-agreement.pdf");
    expect(chunks.length).toBeGreaterThan(5);

    for (const chunk of chunks) {
      expect(document.text.slice(chunk.start, chunk.end)).toBe(chunk.text);
      expect(chunk.text.trim().length).toBeGreaterThan(0);
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  it("never lets a chunk cross a top-level clause boundary", async () => {
    const { chunks } = await loadFixture("services-agreement.pdf");
    const sized = chunks.filter((chunk) => chunk.clauseNumber !== null);
    expect(sized.length).toBeGreaterThan(5);
    // Each chunk carries exactly one clause number.
    for (const chunk of sized) {
      const numbers = new Set(chunk.text.match(/^\d+\.\d+/gm)?.map((line) => line.split(".")[0]));
      if (numbers.size > 0) {
        expect(numbers.size).toBe(1);
      }
    }
  });

  it("builds a clause outline with headings", async () => {
    const { document } = await loadFixture("services-agreement.pdf");
    const outline = extractClauseOutline(document);
    const liability = outline.find((clause) => clause.number === "11");
    const termination = outline.find((clause) => clause.number === "12");

    expect(liability?.heading).toMatch(/LIMITATION OF LIABILITY/i);
    expect(termination?.heading).toMatch(/TERMINATION/i);
    expect(outline.length).toBeGreaterThanOrEqual(10);
  });

  it("respects a smaller chunk budget when asked", async () => {
    const { document } = await loadFixture("services-agreement.docx");
    const small = chunkDocument(document, { maxChars: 700 });
    const large = chunkDocument(document);
    expect(small.length).toBeGreaterThan(large.length);
    expect(Math.max(...small.map((chunk) => chunk.end - chunk.start))).toBeLessThan(1400);
  });
});

describe("retrieval", () => {
  it("finds the clause that answers a question", async () => {
    const { chunks } = await loadFixture("services-agreement.pdf");
    const result = searchChunks("what is the liability cap?", chunks);

    expect(result.noMatch).toBe(false);
    expect(result.ranked.length).toBeGreaterThan(0);
    const top = result.ranked[0];
    expect(top?.chunk.clauseNumber).toBe("11");
    expect(top?.chunk.text).toContain("AED 100,000");
    expect(top?.reason).toMatch(/liability|phrase|matching term/i);
  });

  it("finds a clause by its heading even when the body does not repeat the word", async () => {
    const { chunks } = await loadFixture("services-agreement.pdf");
    const result = searchChunks("what does the contract say about non-solicitation?", chunks);
    expect(result.noMatch).toBe(false);
    expect(result.ranked[0]?.chunk.clauseNumber).toBe("8");
  });

  it("reports no match rather than the least-bad match when the document does not cover the question", async () => {
    const { chunks } = await loadFixture("services-agreement.pdf");
    const result = searchChunks(
      "how many shares are issued under the employee equity incentive plan and what is the strike price?",
      chunks,
    );
    expect(result.noMatch).toBe(true);
    expect(result.chunksSearched).toBe(chunks.length);
  });

  it("searches the whole document, including the far end of a 150-page contract", async () => {
    const { extraction, document, chunks } = await loadFixture("large-master-agreement.pdf");
    expect(extraction.pageCount).toBeGreaterThanOrEqual(140);
    expect(chunks.length).toBeGreaterThan(200);

    // A clause from one of the last schedules must still be reachable.
    const tailStart = Math.floor(document.text.length * 0.97);
    const tail = document.text.slice(tailStart);
    const sentence = tail.match(/[A-Z][^.\n]{60,180}\./)?.[0];
    expect(sentence).toBeTruthy();

    const quote = sentence as string;
    const result = searchChunks(quote.slice(0, 120), chunks, { limit: 5 });
    expect(result.noMatch).toBe(false);
    expect(result.ranked.some((entry) => entry.chunk.text.includes(quote.slice(0, 80)))).toBe(true);

    // The wording repeats: this contract is the same clauses repeated as numbered
    // schedules, so verification must report every occurrence rather than assume
    // the first hit is the one the answer meant.
    const verification = verifyQuote(quote, document);
    expect(verification.status).toBe("verified");
    expect(verification.occurrences).toBeGreaterThan(1);
    expect(verification.alternatives).toHaveLength(verification.occurrences - 1);

    // Asking for the occurrence that overlaps the tail must return the tail one,
    // which is what makes "click the quote" open the right passage.
    const preferred = verifyQuote(quote, document, {
      preferredRanges: [{ start: tailStart - 2000, end: document.text.length }],
    });
    expect(preferred.status).toBe("verified");
    expect(preferred.start).toBeGreaterThanOrEqual(tailStart - 2000);
  });

  it("returns nothing for an empty query instead of guessing", async () => {
    const { chunks } = await loadFixture("services-agreement.pdf");
    const result = searchChunks("   ", chunks);
    expect(result.ranked).toHaveLength(0);
    expect(result.noMatch).toBe(true);
  });
});
