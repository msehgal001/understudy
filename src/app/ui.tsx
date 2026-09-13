import Link from "next/link";
import type { ReactNode } from "react";

export type Tone = "verified" | "awaiting" | "caught" | "neutral" | "accent";

const TONE: Record<Tone, string> = {
  verified: "text-verified border-verified/35 bg-verifiedbg",
  awaiting: "text-awaiting border-awaiting/35 bg-awaitingbg",
  caught: "text-caught border-caught/35 bg-caughtbg",
  neutral: "text-dim border-line bg-panel2",
  accent: "text-accent border-accent/35 bg-accent/10",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`mono inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] leading-4 ${TONE[tone]}`}>
      {children}
    </span>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`mono ${className}`}>{children}</span>;
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-panel ${className}`}>{children}</div>;
}

export function PanelHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-linesoft px-4 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{title}</div>
      {right}
    </div>
  );
}

export function statusTone(status: string): Tone {
  if (status === "verified") return "verified";
  if (status === "unresolved" || status === "failed") return "caught";
  if (status === "rolled-back" || status === "rejected") return "awaiting";
  return "neutral";
}

export const PHASES = ["discover", "plan", "rehearse", "approve", "commit", "verify"] as const;
export type Phase = (typeof PHASES)[number];

export function PhaseNav({ runId, active }: { runId: string; active: string }) {
  return (
    <nav className="flex items-center gap-1 overflow-x-auto">
      {PHASES.map((p, i) => {
        const on = p === active;
        return (
          <Link
            key={p}
            href={`/run/${runId}/${p}`}
            className={`mono relative whitespace-nowrap rounded px-3 py-1.5 text-[12px] transition-colors ${
              on ? "bg-panel2 text-fg" : "text-faint hover:text-dim"
            }`}
          >
            <span className="mr-1.5 text-[10px] text-faint">{i + 1}</span>
            {p}
          </Link>
        );
      })}
    </nav>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-faint">{children}</div>;
}
