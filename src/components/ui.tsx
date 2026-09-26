import type { ReactNode } from "react";

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "neutral" | "verified" | "warning" | "danger" | "info" | "accent";
  children: ReactNode;
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-[var(--color-paper)] text-[var(--color-ink-soft)] border-[var(--color-line-strong)]",
    verified: "bg-[var(--color-verified-soft)] text-[var(--color-verified)] border-[#bfe0cc]",
    warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[#efd9a8]",
    danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[#eec4c4]",
    info: "bg-[var(--color-info-soft)] text-[var(--color-info)] border-[#c8d6ef]",
    accent: "bg-[var(--color-accent-soft)] text-[var(--color-accent-ink)] border-[#c3ddd5]",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  size = "md",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  size?: "sm" | "md";
  title?: string;
  className?: string;
}) {
  const variants: Record<string, string> = {
    primary:
      "bg-[var(--color-accent)] text-white hover:bg-[#17483c] border border-[var(--color-accent)] disabled:bg-[var(--color-line-strong)] disabled:border-[var(--color-line-strong)]",
    secondary:
      "bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-line-strong)] hover:border-[var(--color-ink-muted)] disabled:text-[var(--color-ink-muted)]",
    ghost: "bg-transparent text-[var(--color-ink-soft)] border border-transparent hover:bg-[var(--color-paper)]",
    danger:
      "bg-transparent text-[var(--color-danger)] border border-[#eec4c4] hover:bg-[var(--color-danger-soft)]",
  };
  const sizes = { sm: "px-2.5 py-1 text-[12px]", md: "px-3.5 py-2 text-[13px]" };

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] ${className}`}>
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-muted)]">
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface)] px-6 py-10 text-center">
      <p className="font-serif text-lg text-[var(--color-ink)]">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-soft)]">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[12px] text-[var(--color-ink-muted)]">
      <span
        aria-hidden
        className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-[var(--color-line-strong)] border-t-[var(--color-accent)]"
      />
      {label}
    </span>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleDateString();
}

export function SignificanceBadge({ significance }: { significance: string }) {
  const tone =
    significance === "critical" ? "danger" : significance === "high" ? "warning" : significance === "medium" ? "info" : "neutral";
  const label =
    significance === "critical"
      ? "Critical"
      : significance === "high"
        ? "High"
        : significance === "medium"
          ? "Medium"
          : "Low";
  return <Badge tone={tone as "danger" | "warning" | "info" | "neutral"}>{label}</Badge>;
}
