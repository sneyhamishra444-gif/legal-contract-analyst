"use client";

import { QuoteCard, type QuoteTarget } from "@/components/QuoteCard";
import { Badge, Spinner } from "@/components/ui";
import { parseAnswer } from "@/lib/client/answer";
import type { QuoteVerification } from "@/lib/text/verify";

/**
 * Renders an answer: prose as prose, quotes as quote cards with their verdict,
 * and a quote still being written as a pending card. Nothing here decides whether
 * a quote is real — that verdict arrives from the server, computed by the
 * verifier against the document text.
 */
export function AnswerBody({
  content,
  quotes,
  quoteDocuments,
  documentTitles,
  onShow,
  streaming = false,
}: {
  content: string;
  quotes: Record<number, QuoteVerification>;
  /** passage id -> owning document, so a quote knows which file it came from. */
  quoteDocuments: Record<number, { documentId: string; documentTitle: string }>;
  documentTitles: Record<string, string>;
  onShow: (target: QuoteTarget) => void;
  streaming?: boolean;
}) {
  const segments = parseAnswer(content);

  return (
    <div className="prose-tight text-[13.5px] leading-relaxed">
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return (
            <p key={`text-${index}`} className="whitespace-pre-wrap">
              {segment.text.trim()}
            </p>
          );
        }

        if (segment.kind === "quote-pending") {
          return (
            <figure
              key={`pending-${index}`}
              className="my-3 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-3.5 py-3"
            >
              <div className="flex items-center gap-2">
                <Spinner label="Checking this quote against the document…" />
              </div>
              <blockquote className="mt-2 border-l-2 border-[var(--color-line-strong)] pl-3 font-serif text-[14.5px] leading-relaxed text-[var(--color-ink-soft)]">
                {segment.raw}
              </blockquote>
            </figure>
          );
        }

        const verification = quotes[segment.index];
        const owner = quoteDocuments[segment.index];
        if (!verification) {
          // The quote has closed but its verdict has not arrived yet — a frame
          // in flight, not a failure.
          return (
            <figure
              key={`quote-waiting-${index}`}
              className="my-3 rounded-md border border-[var(--color-line-strong)] bg-[var(--color-paper)] px-3.5 py-3"
            >
              <Spinner label="Verifying…" />
              <blockquote className="mt-2 font-serif text-[14.5px] leading-relaxed">{segment.raw}</blockquote>
            </figure>
          );
        }

        const documentId = owner?.documentId ?? "unknown";
        const documentTitle = owner?.documentTitle ?? documentTitles[documentId] ?? "document";
        return (
          <QuoteCard
            key={`quote-${index}`}
            quote={verification}
            documentId={documentId}
            documentTitle={documentTitle}
            onShow={onShow}
          />
        );
      })}

      {streaming ? (
        <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-[var(--color-ink)] align-middle" />
      ) : null}
    </div>
  );
}

export function CoverageBanner({
  scope,
  rounds,
  truncated,
  passages,
  noMatch,
}: {
  scope: string;
  rounds: number;
  truncated: boolean;
  passages: number;
  noMatch: boolean;
}) {
  return (
    <div className="mt-3 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[var(--color-ink-soft)]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{rounds} research round{rounds === 1 ? "" : "s"}</Badge>
        <Badge tone="neutral">{passages} passage{passages === 1 ? "" : "s"} read</Badge>
        {noMatch ? <Badge tone="warning">no matching passage found</Badge> : null}
        {truncated ? <Badge tone="warning">research stopped early</Badge> : null}
      </div>
      <p className="mt-2">
        <span className="font-medium text-[var(--color-ink)]">What was read: </span>
        {scope}
      </p>
    </div>
  );
}
