"use client";

import { useCallback, useRef, useState } from "react";

import { Badge, Button, Spinner } from "@/components/ui";
import { ApiRequestError } from "@/lib/client/stream";
import type { StoredDocument } from "@/lib/types";

type Status =
  | { kind: "idle" }
  | { kind: "uploading"; fileName: string }
  | { kind: "done"; document: StoredDocument; duplicate: boolean; warnings: string[] }
  | { kind: "error"; message: string; hints: string[] };

export function UploadPanel({ onUploaded }: { onUploaded: (document: StoredDocument) => void }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(
    async (file: File) => {
      // Client-side check for instant feedback; the server decides for real.
      const extension = file.name.toLowerCase().split(".").pop() ?? "";
      if (!["pdf", "docx"].includes(extension)) {
        setStatus({
          kind: "error",
          message: `.${extension || "that type"} files are not supported.`,
          hints: ["Supported formats: PDF and DOCX."],
        });
        return;
      }

      setStatus({ kind: "uploading", fileName: file.name });
      const body = new FormData();
      body.append("file", file);

      try {
        const response = await fetch("/api/documents", { method: "POST", body });
        const payload = (await response.json()) as {
          document?: StoredDocument;
          duplicate?: boolean;
          warnings?: string[];
          error?: { message?: string; hints?: string[] };
        };

        if (!response.ok || !payload.document) {
          setStatus({
            kind: "error",
            message: payload.error?.message ?? "That file could not be processed.",
            hints: payload.error?.hints ?? [],
          });
          return;
        }

        setStatus({
          kind: "done",
          document: payload.document,
          duplicate: Boolean(payload.duplicate),
          warnings: payload.warnings ?? [],
        });
        onUploaded(payload.document);
      } catch (error) {
        setStatus({
          kind: "error",
          message:
            error instanceof ApiRequestError
              ? error.message
              : "The upload could not be completed. Check your connection and try again.",
          hints: [],
        });
      }
    },
    [onUploaded],
  );

  return (
    <section
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void upload(file);
      }}
      className={`rounded-lg border-2 border-dashed bg-[var(--color-surface)] px-6 py-8 text-center transition ${
        dragging ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-line-strong)]"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }}
      />

      {status.kind === "uploading" ? (
        <div className="flex flex-col items-center gap-2">
          <Spinner label={`Reading ${status.fileName}…`} />
          <p className="text-[12px] text-[var(--color-ink-muted)]">
            Extracting text and building the clause index. A 150-page contract takes a few seconds.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <p className="font-serif text-[17px]">Add a contract</p>
          <p className="max-w-lg text-[13px] leading-relaxed text-[var(--color-ink-soft)]">
            Drop a PDF or DOCX here, or choose a file. Scanned PDFs with no text layer are refused rather than stored
            as empty documents.
          </p>
          <Button onClick={() => inputRef.current?.click()}>Choose file</Button>
          <p className="text-[11px] text-[var(--color-ink-muted)]">PDF or DOCX · up to 4 MB</p>
        </div>
      )}

      {status.kind === "done" ? (
        <div className="mt-5 rounded-md border border-[var(--color-line)] bg-[var(--color-paper)] px-4 py-3 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.duplicate ? "info" : "verified"}>
              {status.duplicate ? "Already in the library" : "Processed"}
            </Badge>
            <span className="text-[13px] font-medium">{status.document.title}</span>
            <span className="text-[12px] text-[var(--color-ink-muted)]">
              {status.document.pageCount > 0 ? `${status.document.pageCount} pages · ` : ""}
              {status.document.clauseCount} clauses ·{" "}
              {status.document.charCount.toLocaleString()} characters
            </span>
          </div>
          {status.warnings.length > 0 ? (
            <ul className="mt-2 space-y-1 text-[12px] text-[var(--color-warning)]">
              {status.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {status.kind === "error" ? (
        <div className="mt-5 rounded-md border border-[#eec4c4] bg-[var(--color-danger-soft)] px-4 py-3 text-left">
          <p className="text-[13px] font-medium text-[var(--color-danger)]">{status.message}</p>
          {status.hints.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 text-[12px] text-[var(--color-ink-soft)]">
              {status.hints.map((hint) => (
                <li key={hint}>· {hint}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2">
            <Button variant="secondary" size="sm" onClick={() => setStatus({ kind: "idle" })}>
              Try another file
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
