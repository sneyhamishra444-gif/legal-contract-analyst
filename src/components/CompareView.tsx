"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge, Button, Card, EmptyState, SectionLabel, SignificanceBadge } from "@/components/ui";
import { postStream } from "@/lib/client/stream";
import type { CompareStreamEvent } from "@/app/api/compare/route";
import type { ClauseChange, ComparisonResult } from "@/lib/compare/compare";
import type { StoredDocument } from "@/lib/types";

type Filter = "all" | "critical" | "high" | "substantive" | "reworded";

function InlineDiff({ change }: { change: ClauseChange }) {
  if (change.segments.length === 0) return null;
  return (
    <p className="mt-2 whitespace-pre-wrap rounded border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-2 text-[12.5px] leading-relaxed">
      {change.segments.map((segment, index) => (
        <span
          key={index}
          className={
            segment.type === "added"
              ? "bg-[var(--color-verified-soft)] text-[var(--color-verified)]"
              : segment.type === "removed"
                ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)] line-through"
                : "text-[var(--color-ink-soft)]"
          }
        >
          {segment.text}
        </span>
      ))}
    </p>
  );
}

export function CompareView({
  documents,
  initialLeft,
  initialRight,
}: {
  documents: StoredDocument[];
  initialLeft: string | null;
  initialRight: string | null;
}) {
  const [leftId, setLeftId] = useState(initialLeft ?? documents[1]?.id ?? documents[0]?.id ?? "");
  const [rightId, setRightId] = useState(initialRight ?? documents[0]?.id ?? "");
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const changes = useMemo(() => {
    if (!result) return [];
    switch (filter) {
      case "critical":
        return result.changes.filter((change) => change.significance === "critical");
      case "high":
        return result.changes.filter((change) => change.significance === "high");
      case "substantive":
        return result.changes.filter((change) => change.significance === "critical" || change.significance === "high");
      case "reworded":
        return result.changes.filter((change) => change.kind === "reworded" || change.significance === "low");
      default:
        return result.changes;
    }
  }, [result, filter]);

  const run = async () => {
    if (!leftId || !rightId) return;
    setBusy(true);
    setError(null);
    setSummary("");
    setResult(null);
    try {
      await postStream<CompareStreamEvent>("/api/compare", { leftDocumentId: leftId, rightDocumentId: rightId }, {
        onEvent: (event) => {
          if (event.type === "diff") {
            setResult(event.result);
            setExpanded(event.result.changes[0]?.id ?? null);
          }
          if (event.type === "token") setSummary((current) => current + event.text);
          if (event.type === "error") setError(event.message);
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The comparison could not be run.");
    } finally {
      setBusy(false);
    }
  };

  if (documents.length < 2) {
    return (
      <div className="mx-auto max-w-[900px] px-5 py-10">
        <EmptyState
          title="Two versions are needed"
          body="Upload both versions of the contract — for example the executed copy and the redlined draft — and they will appear here for comparison."
          action={
            <Link href="/" className="rounded-md border border-[var(--color-line-strong)] px-3 py-1.5 text-[13px]">
              Go to the library
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] px-5 py-8">
      <h1 className="font-serif text-[28px] leading-tight">Compare two versions</h1>
      <p className="mt-1.5 max-w-3xl text-[14px] leading-relaxed text-[var(--color-ink-soft)]">
        Differences are found at clause level, not by comparing characters, and each one is graded by what actually
        changed: amounts, obligations and named parties outrank prose. A clause that was only reworded is listed
        separately rather than presented as a change in substance.
      </p>

      <Card className="mt-5 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[240px] flex-1 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-muted)]">
              Original
            </span>
            <select
              value={leftId}
              onChange={(event) => setLeftId(event.target.value)}
              className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2.5 py-2 text-[13px]"
            >
              {documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.title}
                </option>
              ))}
            </select>
          </label>

          <span className="pb-2 text-[var(--color-ink-muted)]">→</span>

          <label className="flex min-w-[240px] flex-1 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-muted)]">
              Revised
            </span>
            <select
              value={rightId}
              onChange={(event) => setRightId(event.target.value)}
              className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2.5 py-2 text-[13px]"
            >
              {documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.title}
                </option>
              ))}
            </select>
          </label>

          <Button onClick={() => void run()} disabled={busy || leftId === rightId}>
            {busy ? "Comparing…" : "Compare"}
          </Button>
        </div>
        {leftId === rightId ? (
          <p className="mt-2 text-[12px] text-[var(--color-warning)]">Pick two different documents.</p>
        ) : null}
      </Card>

      {error ? (
        <div className="mt-4 rounded-md border border-[#eec4c4] bg-[var(--color-danger-soft)] px-4 py-2.5 text-[13px] text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}

      {result ? (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-4">
            {[
              { label: "Critical", value: result.counts.critical },
              { label: "High", value: result.counts.high },
              { label: "Added / removed", value: result.counts.added + result.counts.removed },
              { label: "Reworded only", value: result.counts.reworded },
            ].map((stat) => (
              <Card key={stat.label} className="px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-muted)]">
                  {stat.label}
                </div>
                <div className="font-serif text-[26px] leading-tight">{stat.value}</div>
              </Card>
            ))}
          </div>

          <Card className="mt-4 p-4">
            <SectionLabel>What changed, in plain language</SectionLabel>
            {summary ? (
              <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed">{summary}</p>
            ) : (
              <p className="mt-2 text-[13px] text-[var(--color-ink-muted)]">
                {busy ? "Writing the summary…" : "Summary unavailable. The change list below is complete regardless."}
              </p>
            )}
            <p className="mt-3 text-[11.5px] text-[var(--color-ink-muted)]">
              {result.matched} clauses matched between the two versions · {result.ignoredNoise} differences look
              cosmetic · clauses graded by amounts, obligations and named parties.
            </p>
          </Card>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <SectionLabel>Changes</SectionLabel>
            {(
              [
                ["all", `All ${result.changes.length}`],
                ["critical", `Critical ${result.counts.critical}`],
                ["high", `High ${result.counts.high}`],
                ["substantive", `Substantive ${result.counts.critical + result.counts.high}`],
                ["reworded", `Reworded ${result.counts.reworded}`],
              ] as Array<[Filter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded-full border px-2.5 py-1 text-[11.5px] ${
                  filter === value
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]"
                    : "border-[var(--color-line-strong)] text-[var(--color-ink-soft)]"
                }`}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto text-[11.5px] text-[var(--color-ink-muted)]">
              sorted by significance, then by position
            </span>
          </div>

          {changes.length === 0 ? (
            <p className="mt-3 text-[13px] text-[var(--color-ink-muted)]">Nothing in this category.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {changes.map((change) => {
                const isOpen = expanded === change.id;
                return (
                  <li key={change.id}>
                    <Card className="overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : change.id)}
                        className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left"
                      >
                        <SignificanceBadge significance={change.significance} />
                        <Badge
                          tone={
                            change.kind === "added" ? "verified" : change.kind === "removed" ? "danger" : "neutral"
                          }
                        >
                          {change.kind === "added"
                            ? "Added"
                            : change.kind === "removed"
                              ? "Removed"
                              : change.kind === "reworded"
                                ? "Reworded"
                                : "Modified"}
                        </Badge>
                        <span className="font-medium">{change.label}</span>
                        <span className="ml-auto text-[11.5px] text-[var(--color-ink-muted)]">
                          {Math.round(change.similarity * 100)}% similar
                        </span>
                      </button>

                      <div className="border-t border-[var(--color-line)] px-4 py-3">
                        <p className="text-[13px]">{change.summary}</p>
                        {change.signals.length > 0 ? (
                          <ul className="mt-1.5 space-y-0.5 text-[11.5px] text-[var(--color-ink-soft)]">
                            {change.signals.map((signal) => (
                              <li key={signal}>· {signal}</li>
                            ))}
                          </ul>
                        ) : null}

                        {isOpen ? (
                          <>
                            {change.coarse ? (
                              <p className="mt-2 text-[11.5px] text-[var(--color-warning)]">
                                This clause is very long, so the word-level comparison is coarse.
                              </p>
                            ) : null}
                            <InlineDiff change={change} />
                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                              <div>
                                <SectionLabel>Original</SectionLabel>
                                <pre className="thin-scroll mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap rounded border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-2 font-serif text-[12.5px] leading-relaxed">
                                  {change.left?.text.trim() ?? "— clause not present in this version —"}
                                </pre>
                              </div>
                              <div>
                                <SectionLabel>Revised</SectionLabel>
                                <pre className="thin-scroll mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap rounded border border-[var(--color-line)] bg-[var(--color-paper)] px-3 py-2 font-serif text-[12.5px] leading-relaxed">
                                  {change.right?.text.trim() ?? "— clause removed in this version —"}
                                </pre>
                              </div>
                            </div>
                          </>
                        ) : null}
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
