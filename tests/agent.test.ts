import fs from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { type StreamEvent } from "@/lib/agent/events";
import { runAgent } from "@/lib/agent/runner";
import { extractDocument } from "@/lib/extract";
import { createOfflineProvider } from "@/lib/llm/offline";
import type { LlmProvider } from "@/lib/llm/provider";
import { chunkDocument } from "@/lib/text/chunk";
import { createSearchableDocument } from "@/lib/text/document";
import type { DocumentBundle } from "@/lib/storage/documents";

const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.resolve(process.cwd(), "fixtures", name)));

let bundle: DocumentBundle;

beforeAll(async () => {
  const extraction = await extractDocument({ name: "services-agreement.docx", bytes: fixture("services-agreement.docx") });
  const document = createSearchableDocument({
    id: "doc-1",
    title: "Master Services Agreement",
    text: extraction.text,
    pages: extraction.pages,
  });
  bundle = {
    document,
    chunks: chunkDocument(document),
    clauses: [],
    record: {
      id: "doc-1",
      title: "Master Services Agreement",
      kind: "docx",
      byteSize: 100,
      pageCount: 0,
      charCount: extraction.charCount,
      clauseCount: 16,
      createdAt: new Date().toISOString(),
      warnings: [],
      contentHash: "hash",
      fileBase64: "",
      text: extraction.text,
      pages: [],
    },
  };
});

async function collect(input: Parameters<typeof runAgent>[0]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of runAgent(input)) events.push(event);
  return events;
}

function baseInput(overrides: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return {
    bundles: [bundle],
    question: "What is the liability cap?",
    history: [],
    conversationId: "conv-1",
    messageId: "msg-1",
    ...overrides,
  };
}

/** A provider with a scripted plan per round and a scripted answer. */
function scriptedProvider(plans: string[], answer: string, options: { kind?: "llm" | "offline" } = {}): LlmProvider {
  let planIndex = 0;
  return {
    label: "scripted",
    model: "scripted-1",
    kind: options.kind ?? "llm",
    available: true,
    async complete() {
      const plan = plans[Math.min(planIndex, plans.length - 1)] ?? "{}";
      planIndex += 1;
      return plan;
    },
    async *stream() {
      for (const piece of answer.match(/[\s\S]{1,30}/g) ?? []) yield piece;
    },
  };
}

const textOf = (events: StreamEvent[]) =>
  events.filter((event): event is { type: "token"; text: string } => event.type === "token").map((event) => event.text).join("");

const steps = (events: StreamEvent[]) => events.flatMap((event) => (event.type === "step" ? [event.step] : []));
const quotes = (events: StreamEvent[]) => events.flatMap((event) => (event.type === "quote" ? [event] : []));
const warnings = (events: StreamEvent[]) => events.flatMap((event) => (event.type === "warning" ? [event.message] : []));

describe("agent loop", () => {
  it("runs the offline provider end to end and answers with a verified quote", async () => {
    const events = await collect(baseInput({ provider: createOfflineProvider() }));
    const done = events.find((event) => event.type === "done");
    const coverage = events.find((event) => event.type === "coverage");

    expect(events[0]?.type).toBe("start");
    expect(done?.type).toBe("done");
    expect(steps(events).length).toBeGreaterThan(0);
    expect(steps(events).some((step) => step.kind === "tool")).toBe(true);
    expect(steps(events).some((step) => step.kind === "result")).toBe(true);

    const found = quotes(events);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => entry.quote.status === "verified")).toBe(true);

    // Verification located the quote itself, and the span is a real slice of text.
    const first = found[0];
    expect(first?.quote.spans[0]?.text).toBeTruthy();
    expect(bundle.document.text.slice(first?.quote.start ?? 0, first?.quote.end ?? 0)).toBe(
      first?.quote.spans[0]?.text,
    );

    expect(coverage?.type).toBe("coverage");
    if (coverage?.type === "coverage") {
      expect(coverage.coverage.documentsSearched).toBe(1);
      expect(coverage.coverage.chunksSearched).toBe(bundle.chunks.length);
      expect(coverage.coverage.scope).toMatch(/searched lexically/i);
      expect(coverage.coverage.passages.length).toBeGreaterThan(0);
    }
  });

  it("stops at the round limit instead of looping forever", async () => {
    const provider = scriptedProvider(
      Array.from({ length: 12 }, () => '{"thought":"searching","action":{"tool":"search_document","arguments":{"query":"liability cap"}}}'),
      "Answer text.",
    );
    const events = await collect(baseInput({ provider, maxRounds: 3 }));
    const coverage = events.find((event) => event.type === "coverage");

    expect(steps(events).filter((step) => step.round === 3).length).toBeGreaterThan(0);
    expect(steps(events).every((step) => (step.round ?? 1) <= 3)).toBe(true);
    expect(warnings(events).join(" ")).toMatch(/round limit of 3/i);
    if (coverage?.type === "coverage") {
      expect(coverage.coverage.rounds).toBe(3);
      expect(coverage.coverage.truncated).toBe(true);
    }
  });

  it("caps the total number of tool calls", async () => {
    let counter = 0;
    const provider: LlmProvider = {
      label: "scripted",
      model: "scripted",
      kind: "llm",
      available: true,
      async complete() {
        counter += 1;
        return `{"thought":"search ${counter}","action":{"tool":"search_document","arguments":{"query":"liability ${counter}"}}}`;
      },
      async *stream() {
        yield "No passage answers this.";
      },
    };

    const events = await collect(baseInput({ provider, maxRounds: 10 }));
    const toolSteps = steps(events).filter((step) => step.kind === "tool");
    expect(toolSteps.length).toBeLessThanOrEqual(9);
    expect(warnings(events).join(" ")).toMatch(/tool-call limit/i);
  });

  it("rejects an invented tool name without crashing", async () => {
    const provider = scriptedProvider(
      [
        '{"thought":"clean up","action":{"tool":"delete_document","arguments":{"id":"doc-1"}}}',
        '{"thought":"try again","action":{"tool":"shell","arguments":{"cmd":"rm -rf /"}}}',
      ],
      "I could not find that in the document.",
    );
    const events = await collect(baseInput({ provider }));

    const rejected = steps(events).filter((step) => /invented tool call/i.test(step.title));
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0]?.detail).toMatch(/available tools/i);
    expect(rejected[0]?.detail).toMatch(/search_document/);
    expect(warnings(events).join(" ")).toMatch(/invented tool names/i);
    // The request still finishes with an answer.
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("recovers from unparseable JSON with one repair attempt", async () => {
    const repairs: string[] = [];
    let call = 0;
    const provider: LlmProvider = {
      label: "scripted",
      model: "scripted",
      kind: "llm",
      available: true,
      async complete(request) {
        call += 1;
        const message = request.messages[request.messages.length - 1]?.content ?? "";
        if (request.messages.some((entry) => entry.role === "system" && entry.content.includes("could not be parsed"))) {
          repairs.push(message);
          return '{"thought":"found it","action":{"tool":"final_answer","arguments":{}}}';
        }
        return "Sure! I will look for the liability cap now.";
      },
      async *stream() {
        yield "I could not find a liability cap in the passages provided.";
      },
    };

    const events = await collect(baseInput({ provider }));
    expect(call).toBe(2);
    expect(repairs).toHaveLength(1);
    expect(steps(events).some((step) => /not valid JSON/i.test(step.title))).toBe(true);
    expect(warnings(events).join(" ")).not.toMatch(/did not return a usable plan/i);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("gives up gracefully when the model never returns usable JSON", async () => {
    const provider = scriptedProvider(["not json at all", "still not json"], "I could not find that.");
    const events = await collect(baseInput({ provider }));

    expect(warnings(events).join(" ")).toMatch(/did not return a usable plan/i);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("rejects malformed and nonsense tool arguments with a corrective message", async () => {
    const provider = scriptedProvider(
      [
        '{"thought":"search","action":{"tool":"search_document","arguments":{}}}',
        '{"thought":"search","action":{"tool":"search_document","arguments":{"query":"  "}}}',
      ],
      "I could not find that.",
    );
    const events = await collect(baseInput({ provider }));

    const rejected = steps(events).filter((step) => /Rejected a search/i.test(step.title));
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0]?.detail).toMatch(/must be a string of two or more words/i);
    expect(warnings(events).join(" ")).toMatch(/arguments were rejected/i);
  });

  it("rejects a clause number that is not a number", async () => {
    const provider = scriptedProvider(
      ['{"thought":"read it","action":{"tool":"get_section","arguments":{"number":"the liability one"}}}'],
      "I could not find that.",
    );
    const events = await collect(baseInput({ provider }));
    const rejected = steps(events).find((step) => /Rejected a section request/i.test(step.title));
    expect(rejected).toBeTruthy();
    expect(rejected?.detail).toMatch(/clause number such as/i);
  });

  it("never presents an invented quote as genuine", async () => {
    const provider = scriptedProvider(
      ['{"thought":"answer","action":{"tool":"search_document","arguments":{"query":"liability cap"}}}', '{"thought":"done","action":{"tool":"final_answer","arguments":{}}}'],
      'The cap is <quote doc="p1">five million United States dollars, payable on demand in Zurich</quote> and that is the end of it.',
    );
    const events = await collect(baseInput({ provider }));

    const found = quotes(events);
    expect(found.length).toBe(1);
    expect(found[0]?.quote.status).toBe("unverified");
    expect(found[0]?.quote.spans).toHaveLength(0);
    expect(found[0]?.quote.start).toBeNull();
    expect(found[0]?.quote.notes.join(" ")).toMatch(/not in the document text/i);
    // A wholly invented sentence often has no near neighbour at all, and saying
    // so is more honest than surfacing an unrelated passage as a "closest match".
    if (found[0]?.quote.closest) {
      expect(found[0].quote.similarity).toBeLessThan(0.9);
    }
    expect(warnings(events).join(" ")).toMatch(/None of the quotes/i);
  });

  it("keeps a real quote and flags a fabricated one in the same answer", async () => {
    const real = "The Supplier shall invoice the Client monthly in arrears";
    const provider = scriptedProvider(
      ['{"thought":"answer","action":{"tool":"search_document","arguments":{"query":"invoice payment terms"}}}', '{"thought":"done","action":{"tool":"final_answer","arguments":{}}}'],
      `Payment works like this: <quote doc="p1">${real}</quote>. The cap is <quote doc="p1">one billion euros exactly</quote>.`,
    );
    const events = await collect(baseInput({ provider }));

    const found = quotes(events);
    expect(found).toHaveLength(2);
    expect(found[0]?.quote.status).toBe("verified");
    expect(found[0]?.quote.method).toBe("exact");
    expect(found[1]?.quote.status).toBe("unverified");
    expect(bundle.document.text).toContain(real);
  });

  it("discards a quote that was cut off mid-sentence", async () => {
    const provider: LlmProvider = {
      label: "scripted",
      model: "scripted",
      kind: "llm",
      available: true,
      async complete() {
        return '{"thought":"answer","action":{"tool":"search_document","arguments":{"query":"liability cap"}}}';
      },
      async *stream() {
        yield "The contract says <quote doc=\"p1\">the total aggregate liab";
      },
    };
    const events = await collect(baseInput({ provider }));
    expect(warnings(events).join(" ")).toMatch(/cut off and discarded/i);
    expect(quotes(events)).toHaveLength(0);

    // The live stream carries the raw marker (that is how the interface shows a
    // quote being written), but what is saved and shown afterwards must not
    // contain a half sentence presented as a quotation.
    const done = events.find((event) => event.type === "done");
    if (done?.type === "done") {
      expect(done.content).not.toContain("<quote");
      expect(done.content).toContain("The contract says");
    }
    expect(textOf(events)).not.toContain("</quote>");
  });

  it("streams quotes before the answer finishes, so verification is visible while writing", async () => {
    const provider = scriptedProvider(
      ['{"thought":"answer","action":{"tool":"search_document","arguments":{"query":"liability cap"}}}', '{"thought":"done","action":{"tool":"final_answer","arguments":{}}}'],
      'The cap is <quote doc="p1">AED 100,000</quote> in total.',
    );
    const events = await collect(baseInput({ provider }));
    const order = events.map((event) => event.type);
    const quoteAt = order.indexOf("quote");
    const doneAt = order.indexOf("done");
    const answerStart = order.indexOf("answer_start");

    expect(answerStart).toBeGreaterThan(-1);
    expect(quoteAt).toBeGreaterThan(answerStart);
    expect(quoteAt).toBeLessThan(doneAt);
    expect(order.indexOf("coverage")).toBeLessThan(doneAt);
  });

  it("marks the message stopped when the client aborts, and keeps the partial answer", async () => {
    const controller = new AbortController();
    const provider: LlmProvider = {
      label: "scripted",
      model: "scripted",
      kind: "llm",
      available: true,
      async complete() {
        return '{"thought":"answer","action":{"tool":"search_document","arguments":{"query":"liability cap"}}}';
      },
      async *stream() {
        yield "The agreement states that ";
        controller.abort();
        yield "the supplier shall ";
        yield "keep information secret.";
      },
    };

    const events = await collect(baseInput({ provider, signal: controller.signal }));
    const done = events.find((event) => event.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.status).toBe("stopped");
      expect(done.content).toContain("The agreement states that");
    }
    expect(warnings(events).join(" ")).toMatch(/stopped/i);
  });

  it("abstains when the documents do not cover the question", async () => {
    const events = await collect(
      baseInput({ provider: createOfflineProvider(), question: "What is the employee share option vesting schedule?" }),
    );
    const answer = textOf(events);
    expect(quotes(events)).toHaveLength(0);
    expect(answer).toMatch(/could not find|not covered|does not appear/i);
  });
});
