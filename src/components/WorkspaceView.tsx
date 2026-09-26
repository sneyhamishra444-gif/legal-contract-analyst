"use client";

import { useCallback, useMemo, useState } from "react";

import { ChatPanel } from "@/components/ChatPanel";
import { DocumentViewer, type ViewerHighlight } from "@/components/DocumentViewer";
import { type QuoteTarget } from "@/components/QuoteCard";
import { Badge, Button } from "@/components/ui";
import type { ClauseOutline } from "@/lib/text/chunk";
import type { PageSpan } from "@/lib/text/document";
import type { ChatMessage, Conversation, StoredDocument } from "@/lib/types";

export type ViewerDocument = {
  id: string;
  title: string;
  kind: "pdf" | "docx";
  text: string;
  pages: PageSpan[];
  clauses: ClauseOutline[];
};

/**
 * The workspace holds the two panes and the one piece of shared state that
 * matters: which passage the reader should be looking at. A quote in the answer
 * sets it, and the reader scrolls to it, opening the right document first when
 * the question spans several.
 */
export function WorkspaceView({
  primary,
  allDocuments,
  initialScopeIds,
  conversations,
  initialConversationId,
  initialMessages,
}: {
  primary: ViewerDocument;
  allDocuments: StoredDocument[];
  initialScopeIds: string[];
  conversations: Conversation[];
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
}) {
  const [scopeIds, setScopeIds] = useState(initialScopeIds);
  const [documents, setDocuments] = useState<Record<string, ViewerDocument>>({ [primary.id]: primary });
  const [viewerId, setViewerId] = useState(primary.id);
  const [highlight, setHighlight] = useState<ViewerHighlight | null>(null);
  const [pane, setPane] = useState<"chat" | "document">("chat");
  const [loadingDocument, setLoadingDocument] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);

  const scopeDocuments = useMemo(
    () => allDocuments.filter((document) => scopeIds.includes(document.id)),
    [allDocuments, scopeIds],
  );

  const viewer = documents[viewerId] ?? primary;

  const loadDocument = useCallback(
    async (id: string): Promise<ViewerDocument | null> => {
      const cached = documents[id];
      if (cached) return cached;
      setLoadingDocument(id);
      setLoadFailure(null);
      try {
        const response = await fetch(`/api/documents/${id}`);
        if (!response.ok) {
          setLoadFailure("A document cited by this answer could not be opened. It may have been deleted.");
          return null;
        }
        const payload = (await response.json()) as {
          document: StoredDocument;
          text: string;
          pages: PageSpan[];
          clauses: ClauseOutline[];
        };
        const loaded: ViewerDocument = {
          id: payload.document.id,
          title: payload.document.title,
          kind: payload.document.kind,
          text: payload.text,
          pages: payload.pages,
          clauses: payload.clauses,
        };
        setDocuments((current) => ({ ...current, [id]: loaded }));
        return loaded;
      } catch {
        // A failed or interrupted load must not leave a rejected promise behind:
        // without this, clicking "Show in document" appears to do nothing at all.
        setLoadFailure("That document could not be loaded. Check your connection and try again.");
        return null;
      } finally {
        setLoadingDocument(null);
      }
    },
    [documents],
  );

  const showQuote = useCallback(
    async (target: QuoteTarget, label?: string) => {
      if (!documents[target.documentId]) {
        const loaded = await loadDocument(target.documentId);
        if (!loaded) return;
      }
      setViewerId(target.documentId);
      setHighlight({
        documentId: target.documentId,
        ranges: target.ranges,
        version: Date.now(),
        label,
      });
      setPane("document");
    },
    [documents, loadDocument],
  );

  return (
    <div className="mx-auto flex h-[calc(100vh-57px)] max-w-[1600px] flex-col px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="font-serif text-[21px] leading-tight">{primary.title}</h1>
        <Badge tone="neutral">
          {scopeDocuments.length} document{scopeDocuments.length === 1 ? "" : "s"} in scope
        </Badge>
        {loadingDocument ? <Badge tone="info">loading {loadingDocument.slice(0, 12)}…</Badge> : null}
        {loadFailure ? <Badge tone="danger">{loadFailure}</Badge> : null}

        <div className="ml-auto flex items-center gap-1.5 lg:hidden">
          <Button size="sm" variant={pane === "chat" ? "primary" : "secondary"} onClick={() => setPane("chat")}>
            Chat
          </Button>
          <Button
            size="sm"
            variant={pane === "document" ? "primary" : "secondary"}
            onClick={() => setPane("document")}
          >
            Document
          </Button>
        </div>

        {scopeDocuments.length > 1 ? (
          <div className="ml-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[var(--color-ink-muted)]">Viewing:</span>
            {scopeDocuments.map((document) => (
              <button
                key={document.id}
                type="button"
                onClick={() => setViewerId(document.id)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                  viewerId === document.id
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]"
                    : "border-[var(--color-line-strong)] text-[var(--color-ink-soft)]"
                }`}
              >
                {document.title.slice(0, 28)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(400px,42%)_minmax(0,1fr)]">
        <div
          className={`min-h-0 overflow-hidden rounded-lg border border-[var(--color-line)] ${
            pane === "chat" ? "flex" : "hidden lg:flex"
          } flex-col`}
        >
          <ChatPanel
            scopeDocuments={scopeDocuments}
            allDocuments={allDocuments}
            conversations={conversations}
            initialConversationId={initialConversationId}
            initialMessages={initialMessages}
            onScopeChange={(ids) => {
              setScopeIds(ids);
              if (!ids.includes(viewerId) && ids[0]) setViewerId(ids[0]);
            }}
            onShowQuote={(target, label) => void showQuote(target, label)}
          />
        </div>

        <div
          className={`min-h-0 overflow-hidden rounded-lg border border-[var(--color-line)] ${
            pane === "document" ? "block" : "hidden lg:block"
          }`}
        >
          <DocumentViewer
            documentId={viewer.id}
            title={viewer.title}
            kind={viewer.kind}
            text={viewer.text}
            pages={viewer.pages}
            clauses={viewer.clauses}
            highlight={highlight}
          />
        </div>
      </div>
    </div>
  );
}
