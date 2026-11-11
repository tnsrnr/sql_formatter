"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { depthLook, restingFill } from "@/lib/depthStyle";
import { queryRegionDepths } from "@/lib/queryRegions";

const RAIL = 16;
const ROW = 22;
const DASH = 5;
const GAP = 4;

export default function RegionPanel({ sql }: { sql: string }) {
  const lines = useMemo(() => (sql ? paintSql(sql) : []), [sql]);
  const depths = useMemo(() => (sql.trim() ? queryRegionDepths(sql) : []), [sql]);
  const gutter = depths.reduce((max, depth) => Math.max(max, depth), 0) * RAIL + RAIL;

  if (!sql.trim()) {
    return <p className="analysis-empty">정렬된 쿼리가 여기에 표시됩니다.</p>;
  }

  return (
    <div className="analysis region-view" aria-label="정렬 결과">
      {lines.map((line, index) => {
        const depth = depths[index] ?? 0;
        return (
          <div className="analysis-row" key={index} style={{ background: restingFill(depth) }}>
            <span className="region-gutter" style={{ width: gutter }}>
              {Array.from({ length: depth + 1 }, (_, level) => (
                <span className="rail" key={level} style={railStyle(level, level * RAIL + 2, index, edgeOf(depths, index, level))} />
              ))}
            </span>
            <span className="analysis-text">{line}</span>
          </div>
        );
      })}
    </div>
  );
}

function paintSql(sql: string): ReactNode[] {
  const lines: ReactNode[][] = [[]];
  let plain = "";
  let quote: "'" | '"' | null = null;
  let key = 0;

  const flush = () => {
    if (!plain) return;
    lines[lines.length - 1].push(plain);
    plain = "";
  };

  let index = 0;
  while (index < sql.length) {
    if (quote) {
      if (sql[index] === "\n") {
        flush();
        lines.push([]);
        index += 1;
        continue;
      }
      plain += sql[index];
      if (sql[index] === quote && sql[index + 1] === quote) {
        plain += sql[index + 1];
        index += 2;
        continue;
      }
      if (sql[index] === quote) quote = null;
      index += 1;
      continue;
    }

    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      plain += sql.slice(index, end === -1 ? sql.length : end);
      index = end === -1 ? sql.length : end;
      continue;
    }

    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      const bits = sql.slice(index, stop).split("\n");
      bits.forEach((bit, bitIndex) => {
        plain += bit;
        flush();
        if (bitIndex < bits.length - 1) lines.push([]);
      });
      index = stop;
      continue;
    }

    if (sql[index] === "'" || sql[index] === '"') {
      quote = sql[index] as "'" | '"';
      plain += sql[index];
      index += 1;
      continue;
    }

    if (sql[index] === "\n") {
      flush();
      lines.push([]);
      index += 1;
      continue;
    }

    const word = clauseAt(sql, index);
    if (word) {
      flush();
      lines[lines.length - 1].push(
        <span className="clause" key={key}>
          {word}
        </span>,
      );
      key += 1;
      index += word.length;
      continue;
    }

    plain += sql[index];
    index += 1;
  }

  flush();
  return lines.map((parts) => (parts.length > 0 ? parts : " "));
}

function clauseAt(sql: string, index: number): string | null {
  const previous = index > 0 ? sql[index - 1] : "";
  if (previous && /[A-Za-z0-9_$#]/.test(previous)) return null;
  return /^(SELECT|FROM|GROUP[ \t]+BY|ORDER[ \t]+BY)(?![A-Za-z0-9_$#])/i.exec(sql.slice(index))?.[0] ?? null;
}

function edgeOf(depths: number[], index: number, level: number): "start" | "mid" | "end" | "only" {
  const above = index > 0 && (depths[index - 1] ?? -1) >= level;
  const below = index < depths.length - 1 && (depths[index + 1] ?? -1) >= level;
  if (!above && !below) return "only";
  if (!above) return "start";
  if (!below) return "end";
  return "mid";
}

function railStyle(depth: number, left: number, index: number, edge: "start" | "mid" | "end" | "only"): CSSProperties {
  const look = depthLook(depth);
  const period = DASH + GAP;
  return {
    left,
    width: 12,
    borderLeft: "0",
    backgroundImage: `repeating-linear-gradient(to bottom, ${look.color} 0 ${DASH}px, transparent ${DASH}px ${period}px)`,
    backgroundSize: `${Math.max(look.width, 2)}px ${period}px`,
    backgroundRepeat: "repeat-y",
    backgroundPosition: `0 ${-((index * ROW) % period)}px`,
    borderTop: edge === "start" || edge === "only" ? `2px solid ${look.color}` : undefined,
    borderBottom: edge === "end" || edge === "only" ? `2px solid ${look.color}` : undefined,
  };
}
