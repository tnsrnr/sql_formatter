"use client";

import { useEffect, useMemo, type CSSProperties } from "react";
import type { LetterCase } from "@/lib/formatSql";
import { depthLook } from "@/lib/depthStyle";
import { SKELETON_INDENT, skeletonSql } from "@/lib/skeletonSql";

const CLAUSE = new Set([
  "WITH",
  "AS",
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP",
  "BY",
  "ORDER",
  "HAVING",
  "UNION",
  "ALL",
  "MINUS",
  "INTERSECT",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "NATURAL",
  "ON",
  "USING",
  "CONNECT",
  "START",
]);

export default function AnalysisPanel({
  source,
  letterCase,
  onClose,
}: {
  source: string;
  letterCase: LetterCase;
  onClose: () => void;
}) {
  const skeleton = useMemo(() => {
    if (!source.trim()) return "";
    try {
      return skeletonSql(source, letterCase);
    } catch {
      return "";
    }
  }, [source, letterCase]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!skeleton) {
    return <p className="analysis-empty">쿼리를 넣으면 전체 구조를 보여 줍니다.</p>;
  }

  return (
    <div className="analysis" aria-label="쿼리 분석">
      {skeleton.split("\n").map((line, index) => {
        const leading = line.match(/^ */)?.[0].length ?? 0;
        const depth = Math.floor(leading / SKELETON_INDENT);
        return (
          <div className="analysis-row" key={index}>
            {Array.from({ length: depth }, (_, level) => (
              <span className="rail" key={level} style={railStyle(level + 1, `calc(${level * SKELETON_INDENT}ch + 3ch)`)} />
            ))}
            <span className="analysis-text">{paint(line)}</span>
          </div>
        );
      })}
    </div>
  );
}

function railStyle(depth: number, left: string): CSSProperties {
  const look = depthLook(depth);
  return {
    left,
    borderLeftWidth: look.width,
    borderLeftStyle: look.dashed ? "dashed" : "solid",
    borderLeftColor: look.color,
  };
}

function paint(line: string) {
  const body = line.trim();
  const namesTable =
    /^(?:FROM|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|NATURAL)\b/i.test(body) ||
    /^[A-Za-z_][A-Za-z0-9_$#.]*,?$/.test(body);
  if (!namesTable) return line;

  const parts = line.split(/([A-Za-z_][A-Za-z0-9_$#]*)/);
  return parts.map((part, index) =>
    part && !CLAUSE.has(part.toUpperCase()) && /^[A-Za-z_]/.test(part) ? (
      <span className="table" key={index}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}
