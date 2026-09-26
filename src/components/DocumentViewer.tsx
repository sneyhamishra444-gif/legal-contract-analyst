"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Badge, Button } from "@/components/ui";
import type { ClauseOutline } from "@/lib/text/chunk";
import type { PageSpan } from "@/lib/text/document";

export type ViewerHighlight = {
  documentId: string;
  ranges: Array<{ start: number; end: number }>;
  /** Bumped on every request so clicking the same quote twice still scrolls. */
  version: number;
  label?: string;
};

type Segment = { text: string; highlighted: boolean; active: boolean };

/**
 * Cut a page's text into plain and highlighted runs.
 *
 * Highlighting is done by *rendering* the split text rather than by wrapping DOM
 * ranges after the fact. That is what makes the hard cases work: a quote that
 * spans several lines is still one offset range, a quote that crosses a page
 * break simply produces a highlighted run at the end of one page and another at
 * the start of the next, and a quote that appears several times is highlighted
 * exactly where the user asked for it, because the offsets came from the
 * verifier's own search.
 */
function splitPageText(pageText: string, pageStart: number, ranges: Array<{ start: number; end: number }>): Segment[] {
  const local = ranges
    .map((range, index) => ({
      start: Math.max(0, range.start - pageStart),
      end: Math.min(pageText.length, range.end - pageStart),
      index,
    }))
    .filter((range) => range.end > range.start && range.start < pageText.length)
    .sort((a, b) => a.start - b.start);

  if (local.length === 0) return [{ text: pageText, highlighted: false, active: false }];

  // Merge overlapping runs (a quote wholly inside another, for example).
  const merged: Array<{ start: number; end: number; active: boolean }> = [];
  for (const range of local) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      last.active = last.active || range.index === 0;
    } else {
      merged.push({ start: range.start, end: range.end, active: range.index === 0 });
    }
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) segments.push({ text: pageText.slice(cursor, range.start), highlighted: false, active: false });
    segments.push({ text: pageText.slice(range.start, range.end), highlighted: true, active: range.active });
    cursor = range.end;
  }
  if (cursor < pageText.length) segments.push({ text: pageText.slice(cursor), highlighted: false, active: false });
  return segments;
}

export function DocumentViewer({
  documentId,
  title,
  kind,
  text,
  pages,
  clauses,
  highlight,
}: {
  documentId: string;
  title: string;
  kind: "pdf" | "docx";
  text: string;
  pages: PageSpan[];
  clauses: ClauseOutline[];
  highlight: ViewerHighlight | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showOutline, setShowOutline] = useState(false);

  const effectivePages = useMemo<PageSpan[]>(
    () => (pages.length > 0 ? pages : [{ number: 1, start: 0, end: text.length }]),
    [pages, text.length],
  );

  const activeRanges = highlight && highlight.documentId === documentId ? highlight.ranges : [];

  useEffect(() => {
    if (activeRanges.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const timer = window.setTimeout(() => {
      const target = container.querySelector<HTMLElement>('[data-active="true"]');
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 30);
    return () => window.clearTimeout(timer);
    // Re-runs when the request changes or when the visible document changes, so
    // a citation from another document scrolls once its own text is on screen.
  }, [highlight?.version, documentId, activeRanges.length]);

  const jumpToOffset = (offset: number) => {
    const container = containerRef.current;
    if (!container) return;
    const blocks = [...container.querySelectorAll<HTMLElement>("[data-page-start]")];
    const target = [...blocks].reverse().find((block) => Number(block.dataset.pageStart ?? 0) <= offset);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2.5">
        <span className="truncate font-medium" title={title}>
          {title}
        </span>
        <Badge tone="neutral">{kind.toUpperCase()}</Badge>
        {pages.length > 0 ? (
          <span className="text-[11.5px] text-[var(--color-ink-muted)]">{pages.length} pages</span>
        ) : (
          <span className="text-[11.5px] text-[var(--color-ink-muted)]">no page layout</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {clauses.length > 0 ? (
            <select
              className="max-w-[240px] rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[12px]"
              defaultValue=""
              onChange={(event) => {
                const clause = clauses.find((value) => value.number === event.target.value);
                if (clause) jumpToOffset(clause.start);
              }}
            >
              <option value="">Jump to clause…</option>
              {clauses
                .filter((clause) => clause.number !== null)
                .map((clause) => (
                  <option key={`${clause.number}-${clause.start}`} value={clause.number ?? ""}>
                    {clause.number}. {clause.heading ?? "clause"}
                    {clause.pageStart ? ` (p${clause.pageStart})` : ""}
                  </option>
                ))}
            </select>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setShowOutline((value) => !value)}>
            {showOutline ? "Hide outline" : "Outline"}
          </Button>
          <a
            href={`/api/documents/${documentId}/file`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-[var(--color-line-strong)] px-2.5 py-1 text-[12px] hover:border-[var(--color-ink-muted)]"
          >
            Original file
          </a>
        </div>
      </div>

      {highlight && highlight.documentId === documentId && highlight.label ? (
        <div className="border-b border-[var(--color-line)] bg-[var(--color-verified-soft)] px-4 py-1.5 text-[11.5px] text-[var(--color-verified)]">
          {highlight.label}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {showOutline ? (
          <nav className="thin-scroll w-[260px] shrink-0 overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-muted)]">
              Clauses
            </div>
            <ul className="space-y-0.5">
              {clauses.map((clause) => (
                <li key={`${clause.number}-${clause.start}`}>
                  <button
                    type="button"
                    onClick={() => jumpToOffset(clause.start)}
                    className="w-full rounded px-2 py-1 text-left text-[12px] text-[var(--color-ink-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
                  >
                    <span className="font-medium">{clause.number ?? "—"}</span> {clause.heading ?? ""}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <div ref={containerRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--color-surface)] px-5 py-4">
          {effectivePages.map((page) => {
            const pageText = text.slice(page.start, page.end);
            const segments = splitPageText(pageText, page.start, activeRanges);
            return (
              <section
                key={`${page.number}-${page.start}`}
                data-page-start={page.start}
                data-page={page.number}
                className="doc-page mb-6 last:mb-0"
              >
                <div className="mb-1.5 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-muted)]">
                  <span>{pages.length > 0 ? `Page ${page.number}` : "Extracted text"}</span>
                  <span className="h-px flex-1 bg-[var(--color-line)]" />
                </div>
                <p className="whitespace-pre-wrap font-serif text-[13.5px] leading-[1.6]">
                  {segments.map((segment, index) =>
                    segment.highlighted ? (
                      <mark
                        key={index}
                        className="quote-hit"
                        data-active={segment.active ? "true" : "false"}
                      >
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </p>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
