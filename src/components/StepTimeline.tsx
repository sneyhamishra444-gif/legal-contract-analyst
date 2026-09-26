"use client";

import { useState } from "react";

import type { AgentStep } from "@/lib/types";

/**
 * The live trace of what the agent is doing.
 *
 * This is the visible half of the agentic option: instead of a spinner, the user
 * watches the searches happen, including the ones that fail. Rejected tool calls
 * appear here too, because a model inventing a tool name is worth showing rather
 * than hiding.
 */
export function StepTimeline({ steps, live }: { steps: AgentStep[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  if (steps.length === 0 && !live) return null;

  return (
    <div className="rounded-md border border-[var(--color-line)] bg-[var(--color-surface)]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-[var(--color-ink-soft)]"
      >
        <span className="text-[var(--color-ink-muted)]">{open ? "▾" : "▸"}</span>
        Research activity
        <span className="text-[var(--color-ink-muted)]">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
        {live ? <span className="ml-auto animate-pulse text-[11px] text-[var(--color-accent)]">working…</span> : null}
      </button>

      {open ? (
        <ol className="space-y-1.5 border-t border-[var(--color-line)] px-3 py-2.5">
          {steps.map((step) => (
            <li key={step.id} className="flex gap-2 text-[12px] leading-snug">
              <span
                aria-hidden
                className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${
                  step.kind === "tool"
                    ? "bg-[var(--color-accent)]"
                    : step.kind === "result"
                      ? "bg-[var(--color-verified)]"
                      : step.kind === "note"
                        ? "bg-[var(--color-warning)]"
                        : "bg-[var(--color-line-strong)]"
                }`}
              />
              <div className="min-w-0">
                <span
                  className={
                    step.kind === "tool"
                      ? "font-medium text-[var(--color-ink)]"
                      : step.kind === "note"
                        ? "text-[var(--color-warning)]"
                        : "text-[var(--color-ink-soft)]"
                  }
                >
                  {step.title}
                </span>
                {step.detail ? (
                  <div className="whitespace-pre-wrap break-words text-[11.5px] text-[var(--color-ink-muted)]">
                    {step.detail}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
          {live && steps.length === 0 ? (
            <li className="text-[12px] text-[var(--color-ink-muted)]">Planning what to look up…</li>
          ) : null}
        </ol>
      ) : null}
    </div>
  );
}
