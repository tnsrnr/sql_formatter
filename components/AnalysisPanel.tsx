"use client";

import { useEffect, useMemo, useState } from "react";
import { analyzeSql, type AnalysisNode, type SqlAnalysis } from "@/lib/analyzeSql";

const queryKinds = new Set(["query", "inline", "cte", "subquery"]);

export default function AnalysisPanel({ source, onClose }: { source: string; onClose: () => void }) {
  const analysis = useMemo(() => {
    if (!source.trim()) return null;
    try {
      return analyzeSql(source);
    } catch {
      return null;
    }
  }, [source]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState("");
  const [seen, setSeen] = useState<SqlAnalysis | null>(null);
  if (analysis !== seen) {
    setSeen(analysis);
    setExpanded(new Set(analysis ? shallowIds(analysis.root) : []));
    setSelectedId(analysis?.root.id ?? "");
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = analysis ? findNode(analysis.root, selectedId) ?? analysis.root : null;

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expandAll() {
    if (!analysis) return;
    const ids = new Set<string>();
    walk(analysis.root, (node) => {
      if (node.children.length) ids.add(node.id);
    });
    setExpanded(ids);
  }

  return (
    <aside className="analysis" aria-label="쿼리 분석">
      <div className="analysis-head">
        <h2>분석</h2>
        <button className="btn" type="button" onClick={onClose}>
          닫기
        </button>
      </div>
      {!source.trim() || !analysis || !selected ? (
        <p className="analysis-empty">쿼리를 넣으면 전체 구조를 보여 줍니다.</p>
      ) : (
        <>
          <div className="analysis-body">
            <p className="analysis-count">
              테이블 {analysis.tableCount} · 하위 쿼리 {analysis.subqueryCount}
            </p>
            <section>
              <h3>테이블 관계</h3>
              <RelationMap analysis={analysis} />
            </section>
            <section>
              <div className="tree-head">
                <h3>구조</h3>
                <div>
                  <button type="button" onClick={expandAll}>
                    모두 펼치기
                  </button>
                  <button type="button" onClick={() => setExpanded(new Set())}>
                    모두 접기
                  </button>
                </div>
              </div>
              <Tree
                nodes={[analysis.root]}
                depth={0}
                expanded={expanded}
                selectedId={selected.id}
                onToggle={toggle}
                onSelect={setSelectedId}
              />
            </section>
          </div>
          <Detail node={selected} />
        </>
      )}
    </aside>
  );
}

function RelationMap({ analysis }: { analysis: SqlAnalysis }) {
  if (analysis.links.length === 0) {
    return <p className="muted">조인이나 WHERE 연결을 찾지 못했습니다.</p>;
  }
  return (
    <ul className="relations">
      {analysis.links.map((link) => (
        <li key={`${link.left}-${link.how}-${link.right}-${link.on}`}>
          <div className="relation">
            <span>{link.left}</span>
            <em>{link.how}</em>
            <span>{link.right}</span>
          </div>
          {link.on && <p>{link.on}</p>}
        </li>
      ))}
    </ul>
  );
}

function Tree({
  nodes,
  depth,
  expanded,
  selectedId,
  onToggle,
  onSelect,
}: {
  nodes: AnalysisNode[];
  depth: number;
  expanded: Set<string>;
  selectedId: string;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="tree" style={{ paddingLeft: depth ? 14 : 0 }}>
      {nodes.map((node) => {
        const open = expanded.has(node.id);
        return (
          <li key={node.id}>
            <div className={node.id === selectedId ? "tree-row on" : "tree-row"}>
              {node.children.length > 0 ? (
                <button type="button" className="twist" aria-label={open ? "접기" : "펼치기"} onClick={() => onToggle(node.id)}>
                  {open ? "▾" : "▸"}
                </button>
              ) : (
                <span className="twist blank" />
              )}
              <button type="button" className="tree-label" onClick={() => onSelect(node.id)}>
                {node.label}
              </button>
            </div>
            {open && node.children.length > 0 && (
              <Tree
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                selectedId={selectedId}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Detail({ node }: { node: AnalysisNode }) {
  const blocks: { title: string; items: string[] }[] = [];
  if (queryKinds.has(node.kind)) {
    blocks.push({ title: "조회 항목", items: node.selectItems });
    blocks.push({ title: "검색 조건", items: node.whereItems });
  } else if (node.items.length) {
    blocks.push({ title: node.itemTitle || "내용", items: node.items });
  }

  return (
    <div className="analysis-detail">
      <h3>{node.label}</h3>
      {blocks.length === 0 && <p className="muted">이 단계에서 따로 펼칠 항목이 없습니다.</p>}
      {blocks.map((block) => (
        <div key={block.title}>
          <h4>
            {block.title}
            <span>{block.items.length}</span>
          </h4>
          {block.items.length === 0 ? (
            <p className="muted">없음</p>
          ) : (
            <ul>
              {block.items.slice(0, 80).map((item, index) => (
                <li key={`${block.title}-${index}`}>{item}</li>
              ))}
              {block.items.length > 80 && <li>외 {block.items.length - 80}개</li>}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function shallowIds(node: AnalysisNode): string[] {
  const ids = node.children.length ? [node.id] : [];
  node.children.forEach((child) => {
    if (child.children.length) ids.push(child.id);
  });
  return ids;
}

function findNode(node: AnalysisNode, id: string): AnalysisNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function walk(node: AnalysisNode, visit: (node: AnalysisNode) => void) {
  visit(node);
  node.children.forEach((child) => walk(child, visit));
}
