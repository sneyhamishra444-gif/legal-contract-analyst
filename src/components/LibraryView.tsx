"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { UploadPanel } from "@/components/UploadPanel";
import { Badge, Button, Card, EmptyState, SectionLabel, formatBytes, formatRelative } from "@/components/ui";
import type { StoredDocument } from "@/lib/types";

export function LibraryView({ initialDocuments }: { initialDocuments: StoredDocument[] }) {
  const router = useRouter();
  const [documents, setDocuments] = useState(initialDocuments);
  const [selected, setSelected] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedDocuments = useMemo(
    () => documents.filter((document) => selected.includes(document.id)),
    [documents, selected],
  );

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));

  const remove = async (document: StoredDocument) => {
    if (!window.confirm(`Delete "${document.title}"? Its chat history will be removed too.`)) return;
    setBusyId(document.id);
    setError(null);
    try {
      const response = await fetch(`/api/documents?id=${encodeURIComponent(document.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: { message?: string } };
        setError(payload.error?.message ?? "That document could not be deleted.");
        return;
      }
      setDocuments((current) => current.filter((value) => value.id !== document.id));
      setSelected((current) => current.filter((value) => value !== document.id));
    } catch {
      setError("That document could not be deleted.");
    } finally {
      setBusyId(null);
    }
  };

  const askSelected = () => {
    const primary = selectedDocuments[0];
    if (!primary) return;
    const others = selectedDocuments.slice(1).map((document) => document.id);
    router.push(
      `/documents/${primary.id}${others.length > 0 ? `?also=${encodeURIComponent(others.join(","))}` : ""}`,
    );
  };

  return (
    <div className="mx-auto max-w-[1500px] px-5 py-8">
      <div className="mb-7 max-w-3xl">
        <h1 className="font-serif text-[30px] leading-tight">Review contracts, with every claim traced back</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-ink-soft)]">
          Ask questions about an uploaded contract and get answers that cite the document. Every quote is checked
          against the text before it is shown: quotes that cannot be found are marked as unverified rather than
          presented as real.
        </p>
      </div>

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SectionLabel>Document library</SectionLabel>
            <span className="text-[12px] text-[var(--color-ink-muted)]">
              {documents.length} document{documents.length === 1 ? "" : "s"}
            </span>
            {selected.length > 0 ? (
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[12px] text-[var(--color-ink-muted)]">{selected.length} selected</span>
                <Button size="sm" onClick={askSelected}>
                  {selected.length > 1 ? "Ask across these documents" : "Ask about this document"}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setSelected([])}>
                  Clear
                </Button>
                {selected.length === 2 ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const [left, right] = selectedDocuments;
                      if (left && right) router.push(`/compare?left=${left.id}&right=${right.id}`);
                    }}
                  >
                    Compare two
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="mb-3 rounded-md border border-[#eec4c4] bg-[var(--color-danger-soft)] px-4 py-2 text-[13px] text-[var(--color-danger)]">
              {error}
            </div>
          ) : null}

          {documents.length === 0 ? (
            <EmptyState
              title="No documents yet"
              body="Upload a contract to start. The sample contracts in the fixtures folder of the repository are a good first test — services-agreement.pdf is six pages, large-master-agreement.pdf is about 150."
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {documents.map((document) => {
                const isSelected = selected.includes(document.id);
                return (
                  <Card key={document.id} className={`p-4 transition ${isSelected ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent-soft)]" : ""}`}>
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(document.id)}
                        aria-label={`Select ${document.title}`}
                        className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/documents/${document.id}`}
                          className="block truncate font-medium hover:underline"
                          title={document.title}
                        >
                          {document.title}
                        </Link>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)]">
                          <Badge tone="neutral">{document.kind.toUpperCase()}</Badge>
                          {document.pageCount > 0 ? <span>{document.pageCount} pages</span> : <span>no page layout</span>}
                          <span>·</span>
                          <span>{document.clauseCount} clauses</span>
                          <span>·</span>
                          <span>{formatBytes(document.byteSize)}</span>
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                          added {formatRelative(document.createdAt)}
                        </div>
                        {document.warnings.length > 0 ? (
                          <p className="mt-2 text-[11px] leading-snug text-[var(--color-warning)]">
                            {document.warnings[0]}
                          </p>
                        ) : null}
                        <div className="mt-3 flex items-center gap-2">
                          <Link
                            href={`/documents/${document.id}`}
                            className="rounded-md border border-[var(--color-line-strong)] px-2.5 py-1 text-[12px] font-medium hover:border-[var(--color-ink-muted)]"
                          >
                            Open
                          </Link>
                          <a
                            href={`/api/documents/${document.id}/file`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[12px] text-[var(--color-ink-soft)] hover:underline"
                          >
                            Original file
                          </a>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={busyId === document.id}
                            onClick={() => void remove(document)}
                            className="ml-auto"
                          >
                            {busyId === document.id ? "Deleting…" : "Delete"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <UploadPanel
            onUploaded={(document) => {
              setDocuments((current) => [document, ...current.filter((value) => value.id !== document.id)]);
            }}
          />

          <Card className="p-4">
            <SectionLabel>How verification works</SectionLabel>
            <ol className="mt-2 space-y-2 text-[12.5px] leading-relaxed text-[var(--color-ink-soft)]">
              <li>
                <span className="font-medium text-[var(--color-ink)]">1. Search the whole document.</span> Your question
                is turned into search terms and matched against every clause, not just the first pages.
              </li>
              <li>
                <span className="font-medium text-[var(--color-ink)]">2. Answer from the passages found.</span> The model
                sees only those passages, and is told how much of the document was searched.
              </li>
              <li>
                <span className="font-medium text-[var(--color-ink)]">3. Locate every quote ourselves.</span> Positions
                come from our own search of the text. Whitespace, line breaks and punctuation are ignored; the words are
                not.
              </li>
              <li>
                <span className="font-medium text-[var(--color-ink)]">4. Mark what does not check out.</span> A quote
                that is not in the document is shown as unverified, with the closest passage for comparison — never as a
                quotation.
              </li>
            </ol>
          </Card>
        </aside>
      </div>
    </div>
  );
}
