import { describe, expect, it } from "vitest";

import { buildPaginatedText, createSearchableDocument } from "@/lib/text/document";
import { normalizeText, originalSlice, toOriginalRange } from "@/lib/text/normalize";
import { splitQuoteIntoSegments, verifyQuote } from "@/lib/text/verify";

function doc(text: string) {
  return createSearchableDocument({ id: "doc-1", title: "Test contract", text });
}

/** Every span we report must be a true slice of the document text. */
function expectSpansAreReal(documentText: string, spans: Array<{ start: number; end: number; text: string }>) {
  for (const span of spans) {
    expect(documentText.slice(span.start, span.end)).toBe(span.text);
  }
}

describe("normalisation", () => {
  it("collapses whitespace but keeps a map back to the original characters", () => {
    const original = "The  Client\n\tshall   pay";
    const normalized = normalizeText(original);

    expect(normalized.text).toBe("The Client shall pay");
    expect(normalized.map.length).toBe(normalized.text.length);

    const range = toOriginalRange(normalized, 0, normalized.text.length);
    expect(range.start).toBe(0);
    expect(range.end).toBe(original.length);
  });

  it("folds typographic variants so a quote copied from a different reader still matches", () => {
    const normalized = normalizeText("“Confidential Information” — proﬁt…");
    expect(normalized.text).toContain('"Confidential Information"');
    expect(normalized.text).toContain("profit");
    expect(normalized.text).toContain("...");
  });

  it("reports the character a normalised offset came from, even when one source character expands", () => {
    const original = "profit… loss";
    const normalized = normalizeText(original);
    const index = normalized.text.indexOf("...");
    const range = toOriginalRange(normalized, index, index + 3);
    // The three dots all point back at the single ellipsis character.
    expect(original.slice(range.start, range.end)).toBe("…");
  });

  it("removes invisible characters that split a word apart", () => {
    // A soft hyphen or zero-width space inside a word is invisible, so a quote
    // typed or copied without it must still match the document, and the offsets
    // we report must still point at real characters in the original text.
    const original = "the indemnifi\u00adcation and non\u200b-disclosure obligations";
    const normalized = normalizeText(original);
    expect(normalized.text).toBe("the indemnification and non-disclosure obligations");

    const range = toOriginalRange(normalized, normalized.text.indexOf("indemnification"), normalized.text.indexOf("indemnification") + "indemnification".length);
    expect(range.end).toBeGreaterThan(range.start);
    expect(original.slice(range.start, range.end)).toContain("indemnifi");

    const verification = verifyQuote("the indemnification and non-disclosure obligations", doc(original));
    expect(verification.status).toBe("verified");
  });

  it("keeps lowercasing length-preserving", () => {
    const normalized = normalizeText("İstanbul AGREEMENT");
    expect(normalized.lower.length).toBe(normalized.text.length);
  });
});

describe("quote verification", () => {
  const contract =
    "11.1 Subject to clause 11.3, the total aggregate liability of each Party shall not exceed one hundred thousand United Arab Emirates Dirhams (AED 100,000).";

  it("verifies a quote that appears exactly as written", () => {
    const result = verifyQuote(contract, doc(contract));
    expect(result.status).toBe("verified");
    expect(result.method).toBe("exact");
    expect(result.spans).toHaveLength(1);
    expect(result.start).toBe(0);
    expectSpansAreReal(contract, result.spans);
  });

  it("verifies a quote whose line breaks and spacing differ from the document", () => {
    const documentText =
      "11.1 Subject to clause 11.3, the total aggregate\nliability of each Party shall\n   not exceed one hundred thousand\nUnited Arab Emirates Dirhams (AED 100,000).";
    const quote =
      "the total aggregate liability of each Party shall not exceed one hundred thousand United Arab Emirates Dirhams";

    const result = verifyQuote(quote, doc(documentText));
    expect(result.status).toBe("verified");
    expect(result.spans).toHaveLength(1);
    // The span keeps the document's own line breaks, which is what gets highlighted.
    expect(result.spans[0]?.text).toContain("aggregate\nliability");
    expectSpansAreReal(documentText, result.spans);
  });

  it("verifies a quote when the document uses curly quotes, ligatures and non-breaking spaces", () => {
    const documentText = "The term “Confidential\u00a0Information” means proﬁt data and revenue ﬁgures.";
    const quote = 'The term "Confidential Information" means profit data and revenue figures.';
    const result = verifyQuote(quote, doc(documentText));
    expect(result.status).toBe("verified");
    expectSpansAreReal(documentText, result.spans);
  });

  it("verifies a quote when only capitalisation differs, and says so", () => {
    const documentText = "The Supplier shall notify the Client in writing.";
    const result = verifyQuote("the supplier shall notify the client in writing", doc(documentText));
    expect(result.status).toBe("verified");
    expect(result.method).toBe("case-insensitive");
    expect(result.notes.join(" ")).toMatch(/capitalisation/i);
  });

  it("verifies a quote when the model added surrounding punctuation", () => {
    const documentText = "12.1 Either Party may terminate this Agreement immediately by written notice";
    const result = verifyQuote('"Either Party may terminate this Agreement immediately by written notice."', doc(documentText));
    expect(result.status).toBe("verified");
    expect(["punctuation-trimmed", "exact"]).toContain(result.method);
    expectSpansAreReal(documentText, result.spans);
  });

  it("rejects a paraphrase and shows the closest passage instead of a quote", () => {
    const documentText =
      "11.1 the total aggregate liability of each Party shall not exceed one hundred thousand United Arab Emirates Dirhams (AED 100,000).";
    const paraphrase =
      "the total liability of each Party is capped at around one hundred thousand dirhams";

    const result = verifyQuote(paraphrase, doc(documentText));
    expect(result.status).toBe("unverified");
    expect(result.spans).toHaveLength(0);
    expect(result.start).toBeNull();
    expect(result.similarity).toBeGreaterThan(0.45);
    expect(result.similarity).toBeLessThan(1);
    expect(result.closest).not.toBeNull();
    expect(result.notes.join(" ")).toMatch(/not in the document text/i);
    expect(result.notes.join(" ")).toMatch(/not a quotation/i);
  });

  it("rejects a quote with a word dropped from the middle", () => {
    const documentText = "The Client shall pay each undisputed invoice within thirty (30) days of receipt.";
    const result = verifyQuote(
      "The Client shall pay each invoice within thirty (30) days of receipt.",
      doc(documentText),
    );
    expect(result.status).toBe("unverified");
    expect(result.spans).toHaveLength(0);
  });

  it("rejects a quote that reorders the document's words", () => {
    const documentText = "the Supplier shall deliver the Deliverables to the Client";
    const result = verifyQuote("the Client shall deliver the Deliverables to the Supplier", doc(documentText));
    expect(result.status).toBe("unverified");
  });

  it("verifies an elided quote part by part, in order", () => {
    const documentText =
      "12.1 Either Party may terminate this Agreement immediately by written notice if the other Party commits a material breach of this Agreement and fails to remedy that breach within sixty (60) days of receiving written notice.";
    const quote = "Either Party may terminate this Agreement immediately ... fails to remedy that breach within sixty (60) days";

    const result = verifyQuote(quote, doc(documentText));
    expect(result.status).toBe("verified");
    expect(result.spans).toHaveLength(2);
    expect(result.spans[0]?.text).toContain("Either Party may terminate");
    expect(result.spans[1]?.text).toContain("fails to remedy");
    expectSpansAreReal(documentText, result.spans);
  });

  it("verifies an ellipsis marked with the single ellipsis character", () => {
    const documentText = "Clause 5.1 The receiving Party shall keep the Confidential Information secret.";
    const result = verifyQuote("Clause 5.1 … shall keep the Confidential Information secret.", doc(documentText));
    expect(result.status).toBe("verified");
    expect(result.spans).toHaveLength(2);
  });

  it("marks a partly found quote as partial rather than verified", () => {
    const documentText = "The Supplier shall notify the Client within seventy-two (72) hours.";
    // The first half is genuine, the second half was invented. Reporting this as
    // "verified" would put a fabricated clause into the user's hands.
    const result = verifyQuote(
      "The Supplier shall notify the Client ... within ten (10) business days",
      doc(documentText),
    );
    expect(result.status).toBe("partial");
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.text).toContain("shall notify the Client");
    expect(result.failedSegments).toEqual(["within ten (10) business days"]);
    expect(result.notes.join(" ")).toMatch(/could not be located/i);
    expect(result.notes.join(" ")).toMatch(/1 of 2 parts/i);
  });

  it("ignores a bracketed editorial insertion but still requires the surrounding words", () => {
    const documentText = "the Client shall pay the Supplier within thirty (30) days of receipt";
    const good = verifyQuote("the Client shall pay [the Supplier] within thirty (30) days", doc(documentText));
    expect(good.status).toBe("verified");

    const bad = verifyQuote("the Client shall pay [the Supplier] within ninety (90) days", doc(documentText));
    expect(bad.status).not.toBe("verified");
  });

  it("recovers a word hyphenated across a line break", () => {
    const documentText = "Each Party shall indemnify and hold harmless the other against any non-\nsolicitation claim.";
    const result = verifyQuote("indemnify and hold harmless the other against any nonsolicitation claim", doc(documentText));
    expect(result.status).toBe("verified");
    expect(result.method).toBe("hyphen-joined");
    expectSpansAreReal(documentText, result.spans);
  });

  it("counts repeated wording and lets the caller prefer the occurrence the answer came from", () => {
    const documentText =
      "Clause 1 The Supplier shall notify the Client. Some other text in between that is long enough. Clause 9 The Supplier shall notify the Client.";
    const quote = "The Supplier shall notify the Client";

    const first = verifyQuote(quote, doc(documentText));
    expect(first.status).toBe("verified");
    expect(first.occurrences).toBe(2);
    expect(first.alternatives).toHaveLength(1);
    expect(first.start).toBe(documentText.indexOf(quote));

    const laterStart = documentText.lastIndexOf(quote);
    const preferred = verifyQuote(quote, doc(documentText), {
      preferredRanges: [{ start: laterStart, end: documentText.length }],
    });
    expect(preferred.start).toBe(laterStart);
    expect(preferred.occurrences).toBe(2);
  });

  it("attributes a quote that crosses a page break to both pages", () => {
    const { text, pages } = buildPaginatedText([
      "The total aggregate liability of each Party shall not exceed",
      "one hundred thousand United Arab Emirates Dirhams (AED 100,000).",
    ]);
    const document = createSearchableDocument({ id: "d", title: "t", text, pages });

    const result = verifyQuote(
      "liability of each Party shall not exceed one hundred thousand United Arab Emirates Dirhams",
      document,
    );
    expect(result.status).toBe("verified");
    expect(result.crossPage).toBe(true);
    expect(result.pageStart).toBe(1);
    expect(result.pageEnd).toBe(2);
    expect(result.notes.join(" ")).toMatch(/crosses a page break/i);
    expectSpansAreReal(text, result.spans);
  });

  it("flags a quote that spans several lines", () => {
    const documentText = "the Supplier shall keep\nall Confidential Information\nsecure at all times";
    const result = verifyQuote("shall keep all Confidential Information secure", doc(documentText));
    expect(result.status).toBe("verified");
    expect(result.multiLine).toBe(true);
    expect(result.notes.join(" ")).toMatch(/more than one line/i);
  });

  it("never returns metrics when nothing was found, and never a span", () => {
    const result = verifyQuote("This clause does not exist anywhere at all in this document", doc("A short contract about payment terms."));
    expect(result.status).toBe("unverified");
    expect(result.start).toBeNull();
    expect(result.end).toBeNull();
    expect(result.pageStart).toBeNull();
    expect(result.spans).toHaveLength(0);
  });

  it("handles an empty quote without pretending it is verified", () => {
    const result = verifyQuote("   ", doc("Any text at all."));
    expect(result.status).toBe("unverified");
    expect(result.spans).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/empty quote/i);
  });

  it("flags a very short quote as weak evidence", () => {
    const result = verifyQuote("AED 100,000", doc("the cap is AED 100,000 in total"));
    expect(result.status).toBe("verified");
    expect(result.weakEvidence).toBe(true);
  });

  it("verifies non-Latin text", () => {
    const documentText = "يلتزم الطرف الثاني بدفع المبلغ خلال ثلاثين (30) يوماً من تاريخ الفاتورة.";
    const result = verifyQuote("بدفع المبلغ خلال ثلاثين (30) يوماً", doc(documentText));
    expect(result.status).toBe("verified");
    expectSpansAreReal(documentText, result.spans);
  });

  it("ignores any position the caller might pass alongside the quote text", () => {
    // The verifier only ever reads the quote string plus the document. Even if a
    // model reports a page, we locate the text ourselves.
    const documentText = "Payment shall be made within thirty (30) days.";
    const result = verifyQuote("Payment shall be made within thirty (30) days.", doc(documentText));
    expect(result.start).toBe(0);
    expect(result.end).toBe(documentText.length);
    expect(result.pageStart).toBeNull(); // no page map => no page claim
  });
});

describe("quote splitting", () => {
  it("splits on ellipses and bracketed ellipses alike", () => {
    expect(splitQuoteIntoSegments("one ... two")).toEqual(["one", "two"]);
    expect(splitQuoteIntoSegments("one […] two")).toEqual(["one", "two"]);
    expect(splitQuoteIntoSegments("one . . . two")).toEqual(["one", "two"]);
    expect(splitQuoteIntoSegments("plain quote")).toEqual(["plain quote"]);
  });

  it("keeps a slice of the original text for a normalised range", () => {
    const normalized = normalizeText("alpha\n\nbeta   gamma");
    const start = normalized.text.indexOf("beta");
    expect(originalSlice(normalized, start, start + "beta gamma".length)).toBe("beta   gamma");
  });
});
