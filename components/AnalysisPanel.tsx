"use client";

import { useEffect, useMemo, type CSSProperties } from "react";
import { formatOracleSql, type FormatterSettings } from "@/lib/formatSql";
import { depthLook } from "@/lib/depthStyle";
import { insertColumnMap } from "@/lib/insertSql";
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
  settings,
  onClose,
}: {
  source: string;
  settings: FormatterSettings;
  onClose: () => void;
}) {
  const insertMap = useMemo(() => {
    if (!source.trim()) return null;
    try {
      return insertColumnMap(source, settings.letterCase, (query) => formatOracleSql(query, settings));
    } catch {
      return null;
    }
  }, [source, settings]);

  const skeleton = useMemo(() => {
    if (insertMap || !source.trim()) return "";
    try {
      return skeletonSql(source, settings.letterCase);
    } catch {
      return "";
    }
  }, [insertMap, source, settings.letterCase]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (insertMap) {
    return (
      <div className="analysis insert-map" aria-label="쿼리 분석">
        <div className="insert-head">INSERT INTO {insertMap.table}</div>
        {insertMap.rows.map((pairs, rowIndex) => (
          <div className="insert-block" key={rowIndex}>
            {insertMap.rows.length > 1 ? <div className="insert-row-label">{rowIndex + 1}행</div> : null}
            <div className="insert-pair insert-pair-head">
              <span>컬럼</span>
              <span>값</span>
            </div>
            {pairs.map((pair, index) => (
              <div className="insert-pair" key={index}>
                <span className="insert-col">{pair.column || " "}</span>
                <span className="insert-val">{pair.value || " "}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

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
