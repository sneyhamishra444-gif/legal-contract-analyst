"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AnswerBody, CoverageBanner } from "@/components/AnswerBody";
import { type QuoteTarget } from "@/components/QuoteCard";
import { StepTimeline } from "@/components/StepTimeline";
import { Badge, Button, Card, EmptyState, SectionLabel, formatRelative } from "@/components/ui";
import { postStream } from "@/lib/client/stream";
import type { StreamEvent } from "@/lib/agent/events";
import type { AgentStep, ChatMessage, Conversation, CoverageReport, StoredDocument } from "@/lib/types";
import type { QuoteVerification } from "@/lib/text/verify";

type StreamingState = {
  content: string;
  quotes: Record<number, QuoteVerification>;
  quoteDocuments: Record<number, { documentId: string; documentTitle: string }>;
  steps: AgentStep[];
  coverage: CoverageReport | null;
  warnings: string[];
  provider: "llm" | "offline";
  model: string;
} | null;

const emptyStreaming: NonNullable<StreamingState> = {
  content: "",
  quotes: {},
  quoteDocuments: {},
  steps: [],
  coverage: null,
  warnings: [],
  provider: "offline",
  model: "",
};

export function ChatPanel({
  scopeDocuments,
  allDocuments,
  initialConversationId,
  initialMessages,
  conversations: initialConversations,
  onScopeChange,
  onShowQuote,
}: {
  scopeDocuments: StoredDocument[];
  allDocuments: StoredDocument[];
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
  conversations: Conversation[];
  onScopeChange: (ids: string[]) => void;
  onShowQuote: (target: QuoteTarget, label?: string) => void;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState<StreamingState>(null);
  const [error, setError] = useState<string | null>(null);
  const [showScope, setShowScope] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const documentTitles = useMemo(
    () => Object.fromEntries(allDocuments.map((document) => [document.id, document.title])),
    [allDocuments],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, streaming?.content, streaming?.steps.length]);

  const refreshConversations = async () => {
    try {
      const response = await fetch("/api/conversations");
      const payload = (await response.json()) as { conversations?: Conversation[] };
      if (payload.conversations) setConversations(payload.conversations);
    } catch {
      // History refresh is cosmetic; the conversation still exists on the server.
    }
  };

  const openConversation = async (id: string) => {
    setConversationId(id);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${id}`);
      const payload = (await response.json()) as { messages?: ChatMessage[] };
      setMessages(payload.messages ?? []);
    } catch {
      setError("That conversation could not be opened.");
    }
  };

  const ask = async () => {
    const trimmed = question.trim();
    if (!trimmed || streaming) return;

    setError(null);
    setQuestion("");
    const localUserMessage: ChatMessage = {
      id: `local-${Date.now()}`,
      conversationId: conversationId ?? "pending",
      role: "user",
      content: trimmed,
      status: "complete",
      createdAt: new Date().toISOString(),
      meta: { quotes: [], steps: [], coverage: null, model: "", provider: "offline", warnings: [] },
    };
    setMessages((current) => [...current, localUserMessage]);
    setStreaming({ ...emptyStreaming, provider: "offline", model: "" });

    const controller = new AbortController();
    controllerRef.current = controller;

    let content = "";
    let steps: AgentStep[] = [];
    const quotes: Record<number, QuoteVerification> = {};
    const quoteDocuments: Record<number, { documentId: string; documentTitle: string }> = {};
    let coverage: CoverageReport | null = null;
    let warnings: string[] = [];
    let provider: "llm" | "offline" = "offline";
    let model = "";
    let stopped = false;

    try {
      await postStream<StreamEvent>(
        "/api/chat",
        { documentIds: scopeDocuments.map((document) => document.id), question: trimmed, conversationId },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "start") {
              provider = event.provider;
              model = event.model;
              if (!conversationId) setConversationId(event.conversationId);
            }
            if (event.type === "step") steps = [...steps, event.step];
            if (event.type === "token") content += event.text;
            if (event.type === "quote") {
              quotes[event.index] = event.quote;
              quoteDocuments[event.index] = {
                documentId: event.documentId,
                documentTitle: documentTitles[event.documentId] ?? "document",
              };
              // The first verified quote is surfaced in the reader straight away,
              // so the citation and its source stay connected while reading.
              if (event.quote.status === "verified" && event.quote.start !== null && event.quote.end !== null) {
                onShowQuote(
                  { documentId: event.documentId, ranges: [{ start: event.quote.start, end: event.quote.end }] },
                  `Latest verified quote · ${quoteDocuments[event.index]?.documentTitle ?? ""}`,
                );
              }
            }
            if (event.type === "coverage") coverage = event.coverage;
            if (event.type === "warning") warnings = [...warnings, event.message];
            if (event.type === "error") {
              setError(event.message);
            }
            if (event.type === "done") {
              content = event.content;
            }
            setStreaming({ content, quotes: { ...quotes }, quoteDocuments: { ...quoteDocuments }, steps, coverage, warnings, provider, model });
          },
        },
      );
    } catch (caught) {
      if (controller.signal.aborted) {
        stopped = true;
      } else {
        setError(caught instanceof Error ? caught.message : "The answer could not be generated.");
      }
    } finally {
      controllerRef.current = null;
      const finalContent = content.trim();
      if (finalContent.length > 0) {
        setMessages((current) => [
          ...current,
          {
            id: `local-assistant-${Date.now()}`,
            conversationId: conversationId ?? "pending",
            role: "assistant",
            content: finalContent,
            status: stopped ? "stopped" : "complete",
            createdAt: new Date().toISOString(),
            meta: {
              quotes: Object.values(quotes),
              steps,
              coverage,
              model,
              provider,
              warnings: stopped ? [...warnings, "Generation was stopped; the part already written has been kept."] : warnings,
            },
          },
        ]);
      }
      setStreaming(null);
      void refreshConversations();
      // Re-read from storage so the message ids and stored metadata match exactly.
      if (conversationId) void openConversation(conversationId);
    }
  };

  const stop = () => {
    controllerRef.current?.abort();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2.5">
        <SectionLabel>Ask about the contract</SectionLabel>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="max-w-[220px] rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 text-[12px]"
            value={conversationId ?? ""}
            onChange={(event) => {
              if (event.target.value === "") {
                setConversationId(null);
                setMessages([]);
                return;
              }
              void openConversation(event.target.value);
            }}
          >
            <option value="">New conversation</option>
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title.slice(0, 48)} · {formatRelative(conversation.updatedAt)}
              </option>
            ))}
          </select>
          <Button size="sm" variant="ghost" onClick={() => setShowScope((value) => !value)}>
            {scopeDocuments.length > 1 ? `${scopeDocuments.length} documents` : "1 document"}
          </Button>
        </div>
      </div>

      {showScope ? (
        <div className="border-b border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-2.5">
          <p className="mb-2 text-[11.5px] text-[var(--color-ink-soft)]">
            Questions are answered across every document ticked here. Each quote is verified against its own document.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {allDocuments.map((document) => {
              const checked = scopeDocuments.some((value) => value.id === document.id);
              return (
                <button
                  key={document.id}
                  type="button"
                  onClick={() => {
                    const next = checked
                      ? scopeDocuments.filter((value) => value.id !== document.id).map((value) => value.id)
                      : [...scopeDocuments.map((value) => value.id), document.id];
                    if (next.length > 0) onScopeChange(next);
                  }}
                  className={`rounded-full border px-2.5 py-1 text-[11.5px] ${
                    checked
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)]"
                      : "border-[var(--color-line-strong)] text-[var(--color-ink-soft)]"
                  }`}
                >
                  {checked ? "✓ " : ""}
                  {document.title.slice(0, 34)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div ref={scrollRef} className="thin-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !streaming ? (
          <EmptyState
            title="Ask something specific"
            body="For example: what is the liability cap, what notice is required to terminate, or which law governs the agreement. Every answer must quote the document — and every quote is checked against the text before you see it."
          />
        ) : null}

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-lg rounded-br-sm bg-[var(--color-accent)] px-3.5 py-2 text-[13px] text-white">
                {message.content}
              </div>
            </div>
          ) : (
            <Card key={message.id} className="px-4 py-3">
              <div className="mb-1 flex items-center gap-2">
                <Badge tone={message.meta.provider === "llm" ? "accent" : "warning"}>
                  {message.meta.provider === "llm" ? message.meta.model : "offline extractor"}
                </Badge>
                {message.status === "stopped" ? <Badge tone="neutral">stopped — partial answer kept</Badge> : null}
                {message.meta.coverage?.truncated ? <Badge tone="warning">research cut short</Badge> : null}
              </div>
              <AnswerBody
                content={message.content}
                quotes={Object.fromEntries(message.meta.quotes.map((quote, index) => [index, quote]))}
                quoteDocuments={Object.fromEntries(
                  message.meta.quotes.map((quote, index) => [
                    index,
                    {
                      documentId:
                        message.meta.coverage?.passages.find((passage) => passage.start === quote.start)?.documentId ??
                        scopeDocuments[0]?.id ??
                        "",
                      documentTitle:
                        message.meta.coverage?.passages.find((passage) => passage.start === quote.start)?.documentTitle ??
                        scopeDocuments[0]?.title ??
                        "document",
                    },
                  ]),
                )}
                documentTitles={documentTitles}
                onShow={onShowQuote}
              />
              {message.meta.coverage ? (
                <CoverageBanner
                  scope={message.meta.coverage.scope}
                  rounds={message.meta.coverage.rounds}
                  truncated={message.meta.coverage.truncated}
                  passages={message.meta.coverage.passages.length}
                  noMatch={message.meta.coverage.noMatch}
                />
              ) : null}
              {message.meta.warnings.length > 0 ? (
                <ul className="mt-2 space-y-1 text-[11.5px] text-[var(--color-warning)]">
                  {message.meta.warnings.map((warning) => (
                    <li key={warning}>· {warning}</li>
                  ))}
                </ul>
              ) : null}
              {message.meta.steps.length > 0 ? (
                <div className="mt-2.5">
                  <StepTimeline steps={message.meta.steps} live={false} />
                </div>
              ) : null}
            </Card>
          ),
        )}

        {streaming ? (
          <Card className="px-4 py-3">
            <div className="mb-2">
              <StepTimeline steps={streaming.steps} live />
            </div>
            {streaming.content ? (
              <AnswerBody
                content={streaming.content}
                quotes={streaming.quotes}
                quoteDocuments={streaming.quoteDocuments}
                documentTitles={documentTitles}
                onShow={onShowQuote}
                streaming
              />
            ) : (
              <p className="py-2 text-[13px] text-[var(--color-ink-muted)]">
                Searching the document before answering…
              </p>
            )}
            {streaming.coverage ? (
              <CoverageBanner
                scope={streaming.coverage.scope}
                rounds={streaming.coverage.rounds}
                truncated={streaming.coverage.truncated}
                passages={streaming.coverage.passages.length}
                noMatch={streaming.coverage.noMatch}
              />
            ) : null}
            {streaming.warnings.length > 0 ? (
              <ul className="mt-2 space-y-1 text-[11.5px] text-[var(--color-warning)]">
                {streaming.warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}
          </Card>
        ) : null}
      </div>

      {error ? (
        <div className="border-t border-[#eec4c4] bg-[var(--color-danger-soft)] px-4 py-2 text-[12.5px] text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}

      <div className="border-t border-[var(--color-line)] px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask();
              }
            }}
            rows={2}
            placeholder="What is the liability cap? What notice is needed to terminate?"
            className="thin-scroll min-h-[46px] flex-1 resize-none rounded-md border border-[var(--color-line-strong)] px-3 py-2 text-[13px] outline-none focus:border-[var(--color-accent)]"
          />
          {streaming ? (
            <Button variant="danger" onClick={stop} title="Stop generating and keep what has been written">
              Stop
            </Button>
          ) : (
            <Button onClick={() => void ask()} disabled={question.trim().length === 0}>
              Ask
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--color-ink-muted)]">
          Asking across {scopeDocuments.length} document{scopeDocuments.length === 1 ? "" : "s"} · answers cite the
          document, and unverifiable quotes are marked rather than shown as quotations.
        </p>
      </div>
    </div>
  );
}
