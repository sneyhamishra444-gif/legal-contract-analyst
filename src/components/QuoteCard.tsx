"use client";

import { useState } from "react";

import { Badge, Button } from "@/components/ui";
import type { QuoteVerification } from "@/lib/text/verify";

export type QuoteTarget = {
  documentId: string;
  ranges: Array<{ start: number; end: number }>;
};

function statusBadge(quote: QuoteVerification) {
  if (quote.status === "verified") {
    return (
      <Badge tone="verified" title="The words were located in the document text by the application.">
        ✓ Verified in document
      </Badge>
    );
  }
  if (quote.status === "partial") {
    return (
      <Badge tone="warning" title="Some of this quote was found, and some of it was not. The missing parts are not shown as quotations.">
        Partly verified
      </Badge>
    );
  }
  return (
    <Badge tone="danger" title="This wording is not in the document. It is shown so you can see it was rejected, not as a quotation.">
      ✕ Not in document
    </Badge>
  );
}

export function QuoteCard({
  quote,
  documentId,
  documentTitle,
  onShow,
}: {
  quote: QuoteVerification;
  documentId: string;
  documentTitle: string;
  onShow: (target: QuoteTarget) => void;
}) {
  const [occurrence, setOccurrence] = useState(0);
  const verified = quote.status === "verified" || quote.status === "partial";

  // A single-part quote that appears more than once can be stepped through. A
  // quote split by an ellipsis has several spans, and stepping those
  // independently would be misleading, so the arrows are hidden for those.
  const occurrences = quote.spans.length === 1 ? [quote.spans[0], ...quote.alternatives] : quote.spans;
  const current = occurrences[Math.min(occurrence, occurrences.length - 1)];
  const canStep = quote.spans.length === 1 && occurrences.length > 1;

  const show = () => {
    if (!current) return;
    onShow({ documentId, ranges: [{ start: current.start, end: current.end }] });
  };

  return (
    <figure
      className={`my-3 rounded-md border px-3.5 py-3 ${
        quote.status === "verified"
          ? "border-[#bfe0cc] bg-[var(--color-verified-soft)]"
          : quote.status === "partial"
            ? "border-[#efd9a8] bg-[var(--color-warning-soft)]"
            : "border-[#eec4c4] bg-[var(--color-danger-soft)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {statusBadge(quote)}
        <span className="text-[11px] text-[var(--color-ink-muted)]">
          {documentTitle}
          {quote.pageStart !== null
            ? ` · page ${quote.pageStart}${quote.pageEnd !== null && quote.pageEnd !== quote.pageStart ? `–${quote.pageEnd}` : ""}`
            : ""}
        </span>
        {quote.weakEvidence ? <Badge tone="neutral">short — weak evidence</Badge> : null}
        {canStep ? (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-[var(--color-ink-muted)]">
            <button
              type="button"
              aria-label="Previous occurrence"
              className="rounded border border-[var(--color-line-strong)] px-1.5 hover:bg-white"
              onClick={() => setOccurrence((value) => (value - 1 + occurrences.length) % occurrences.length)}
            >
              ↑
            </button>
            <span>
              occurrence {Math.min(occurrence, occurrences.length - 1) + 1} of {occurrences.length}
            </span>
            <button
              type="button"
              aria-label="Next occurrence"
              className="rounded border border-[var(--color-line-strong)] px-1.5 hover:bg-white"
              onClick={() => setOccurrence((value) => (value + 1) % occurrences.length)}
            >
              ↓
            </button>
          </span>
        ) : null}
      </div>

      {verified ? (
        <blockquote className="mt-2.5 border-l-2 border-[var(--color-verified)] pl-3 font-serif text-[15px] leading-relaxed">
          {quote.spans.map((span, index) => (
            <span key={`${span.start}-${index}`}>
              {index > 0 ? <span className="text-[var(--color-ink-muted)]"> … </span> : null}
              “{span.text.trim()}”
            </span>
          ))}
        </blockquote>
      ) : (
        <div className="mt-2.5">
          <p className="text-[12px] font-medium text-[var(--color-danger)]">Rejected — this was not found in the document:</p>
          <blockquote className="mt-1 border-l-2 border-[#d99] pl-3 font-serif text-[14px] italic leading-relaxed text-[var(--color-ink-soft)] line-through decoration-[#d99]">
            {quote.raw}
          </blockquote>
        </div>
      )}

      {quote.closest && !verified ? (
        <details className="mt-2.5 text-[12px]">
          <summary className="cursor-pointer text-[var(--color-ink-soft)]">
            Closest passage in the document ({Math.round(quote.similarity * 100)}% word overlap) — shown for reference only
          </summary>
          <p className="mt-1.5 border-l-2 border-[var(--color-line-strong)] pl-3 font-serif text-[13px] leading-relaxed text-[var(--color-ink)]">
            “{quote.closest.text.trim().slice(0, 400)}”
          </p>
        </details>
      ) : null}

      {quote.notes.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11.5px] leading-snug text-[var(--color-ink-soft)]">
          {quote.notes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {verified && current ? (
          <Button size="sm" variant="secondary" onClick={show}>
            Show in document
          </Button>
        ) : null}
        {quote.failedSegments.length > 0 ? (
          <span className="text-[11px] text-[var(--color-warning)]">
            Not found: {quote.failedSegments.map((part) => part.slice(0, 60)).join(" · ")}
          </span>
        ) : null}
      </div>
    </figure>
  );
}
