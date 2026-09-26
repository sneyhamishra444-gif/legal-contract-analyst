import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

import { Badge } from "@/components/ui";
import { readLlmConfig } from "@/lib/llm/config";

export const metadata: Metadata = {
  title: "Contract Analyst — answers with verified quotes",
  description:
    "Upload a legal contract, ask questions, and get answers backed by quotes that are verified against the document text.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const config = readLlmConfig();
  const offline = config.apiKey === null;

  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur">
          <div className="mx-auto flex max-w-[1500px] items-center gap-6 px-5 py-3">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="font-serif text-[19px] tracking-tight">Contract Analyst</span>
              <span className="text-[11px] text-[var(--color-ink-muted)]">verified-quote document review</span>
            </Link>

            <nav className="ml-2 flex items-center gap-1 text-[13px]">
              <Link
                href="/"
                className="rounded-md px-2.5 py-1.5 text-[var(--color-ink-soft)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
              >
                Library
              </Link>
              <Link
                href="/compare"
                className="rounded-md px-2.5 py-1.5 text-[var(--color-ink-soft)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
              >
                Compare versions
              </Link>
              <a
                href="/api/health"
                className="rounded-md px-2.5 py-1.5 text-[var(--color-ink-soft)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
              >
                Status
              </a>
            </nav>

            <div className="ml-auto flex items-center gap-2">
              <Badge
                tone={offline ? "warning" : "accent"}
                title={
                  offline
                    ? "No LLM_API_KEY is configured, so answers are extracted verbatim from the document by a deterministic extractor instead of written by a model."
                    : `Answers are written by ${config.model}`
                }
              >
                {offline ? "Offline extractor" : `Model: ${config.model}`}
              </Badge>
            </div>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
