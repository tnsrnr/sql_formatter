"use client";

import { useMemo, type CSSProperties } from "react";
import { depthLook, restingFill } from "@/lib/depthStyle";
import { queryRegionDepths } from "@/lib/queryRegions";

const RAIL = 16;
const ROW = 22;
const DASH = 5;
const GAP = 4;

export default function RegionPanel({ sql }: { sql: string }) {
  const lines = useMemo(() => (sql ? sql.split("\n") : []), [sql]);
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
            <span className="analysis-text">{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
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
