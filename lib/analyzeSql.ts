export type AnalysisNode = {
  id: string;
  kind: string;
  label: string;
  items: string[];
  itemTitle: string;
  selectItems: string[];
  whereItems: string[];
  children: AnalysisNode[];
};

export type TableLink = {
  left: string;
  right: string;
  how: string;
  on: string;
};

export type SqlAnalysis = {
  root: AnalysisNode;
  links: TableLink[];
  tableCount: number;
  subqueryCount: number;
};

type TableRef = { key: string; label: string };

const stopWords = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "UNION", "MINUS", "INTERSECT",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER", "ON", "USING",
  "AS", "SET", "WHEN", "THEN", "ELSE", "END", "START", "CONNECT", "AND", "OR", "INSERT",
  "UPDATE", "DELETE", "MERGE", "INTO", "VALUES", "WITH", "PIVOT", "UNPIVOT", "MATCHED",
  "NOT", "BY", "FETCH", "OFFSET", "LIMIT", "WINDOW", "QUALIFY", "RETURNING", "PARTITION",
  "SAMPLE", "LATERAL", "LOOP", "APPLY", "WHERE",
]);

const clausePhrases = [
  ["GROUP", "BY"],
  ["ORDER", "BY"],
  ["CONNECT", "BY"],
  ["START", "WITH"],
  ["UNION", "ALL"],
  ["UNION"],
  ["MINUS"],
  ["INTERSECT"],
  ["SELECT"],
  ["FROM"],
  ["WHERE"],
  ["HAVING"],
  ["FETCH"],
  ["OFFSET"],
  ["LIMIT"],
];

export function analyzeSql(sql: string): SqlAnalysis {
  const ids = makeIds();
  const links: TableLink[] = [];
  const root = parseScript(sql, 0, sql.length, ids, links);
  const tables = new Set<string>();
  let subqueryCount = 0;
  walk(root, (node) => {
    if (node.kind === "table" || node.kind === "inline") tables.add(node.label);
    if (node.kind === "inline" || node.kind === "subquery" || node.kind === "cte") subqueryCount += 1;
  });
  return { root, links, tableCount: tables.size, subqueryCount };
}

function parseScript(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  const parts = splitChar(sql, start, end, ";").map((part) => trimRange(sql, part.start, part.end)).filter((part) => part.start < part.end);
  if (parts.length <= 1) return parseStatement(sql, start, end, ids, links);
  return make(ids, "script", `스크립트 · ${parts.length}`, parts.map((part) => parseStatement(sql, part.start, part.end, ids, links)));
}

function parseStatement(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  const range = unwrap(sql, start, end);
  const at = advance(sql, range.start, range.end);
  if (at >= range.end) return make(ids, "empty", "빈 쿼리");

  if (isKeywordAt(sql, at, "WITH")) return parseWith(sql, at, range.end, ids, links);
  if (isKeywordAt(sql, at, "SELECT")) return parseSelect(sql, at, range.end, ids, links);
  if (isKeywordAt(sql, at, "INSERT")) return parseInsert(sql, at, range.end, ids, links);
  if (isKeywordAt(sql, at, "UPDATE")) return parseUpdate(sql, at, range.end, ids, links);
  if (isKeywordAt(sql, at, "DELETE")) return parseDelete(sql, at, range.end, ids, links);
  if (isKeywordAt(sql, at, "MERGE")) return parseMerge(sql, at, range.end, ids, links);
  return make(ids, "unknown", oneLine(sql.slice(at, range.end), 80));
}

function parseWith(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  const node = make(ids, "with", "WITH");
  let index = start + "WITH".length;
  while (index < end) {
    index = advance(sql, index, end);
    const name = readIdent(sql, index, end);
    if (!name) break;
    index = name.end;
    index = advance(sql, index, end);
    if (sql[index] === "(" && !startsQuery(sql, index)) index = findMatchingParen(sql, index) + 1;
    index = advance(sql, index, end);
    if (!isKeywordAt(sql, index, "AS")) break;
    index = advance(sql, index + 2, end);
    if (sql[index] !== "(") break;
    const close = findMatchingParen(sql, index);
    const innerQuery = parseStatement(sql, index + 1, close, ids, links);
    const cte = make(ids, "cte", `CTE ${name.text}`, innerQuery.kind === "query" ? innerQuery.children : [innerQuery]);
    cte.selectItems = innerQuery.selectItems;
    cte.whereItems = innerQuery.whereItems;
    node.children.push(cte);
    index = advance(sql, close + 1, end);
    if (sql[index] === ",") {
      index += 1;
      continue;
    }
    break;
  }
  if (index < end) node.children.push(parseStatement(sql, index, end, ids, links));
  return node;
}

function parseSelect(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  const parts = splitSet(sql, start, end);
  if (parts.length > 1) {
    const label = parts.slice(1).map((part) => part.op).filter(Boolean).join(" / ") || "집합";
    return make(ids, "set", label, parts.map((part) => parseSelect(sql, part.start, part.end, ids, links)));
  }
  return parseSelectBody(sql, start, end, ids, links);
}

function parseSelectBody(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  const marks = findClauses(sql, start, end);
  const query = make(ids, "query", "SELECT");
  const selectMark = marks.find((mark) => mark.name === "SELECT");
  if (!selectMark) return query;

  const selectRange = clauseRange(marks, "SELECT", end);
  if (!selectRange) return query;
  const items = splitChar(sql, skipSelectMods(sql, selectRange.start, selectRange.end), selectRange.end, ",")
    .map((part) => summarizeExpression(sql.slice(part.start, part.end)))
    .filter(Boolean);
  const selectNode = make(ids, "select", `SELECT · ${items.length}`);
  selectNode.items = items;
  selectNode.itemTitle = "조회 항목";
  selectNode.children = findSubqueries(sql, selectRange.start, selectRange.end, ids, links);
  query.children.push(selectNode);
  query.selectItems = items;

  const fromRange = clauseRange(marks, "FROM", end);
  if (fromRange) {
    const parsed = parseFrom(sql, fromRange.start, fromRange.end, ids, links);
    const fromNode = make(ids, "from", `FROM · ${parsed.nodes.length}`, parsed.nodes);
    query.children.push(fromNode);
    const whereRange = clauseRange(marks, "WHERE", end);
    if (whereRange && parsed.tables.length > 1) addWhereLinks(sql, whereRange.start, whereRange.end, parsed.tables, links);
  }

  for (const name of ["WHERE", "GROUP BY", "HAVING", "ORDER BY", "CONNECT BY", "START WITH"]) {
    const range = clauseRange(marks, name, end);
    if (!range) continue;
    if (name === "WHERE") {
      const predicates = splitAnd(sql, range.start, range.end)
        .map((part) => oneLine(sql.slice(part.start, part.end)))
        .filter(Boolean);
      const whereNode = make(ids, "where", `WHERE · ${predicates.length}`);
      whereNode.items = predicates;
      whereNode.itemTitle = "검색 조건";
      whereNode.children = findSubqueries(sql, range.start, range.end, ids, links);
      query.children.push(whereNode);
      query.whereItems = predicates;
      continue;
    }
    const pieces = splitChar(sql, range.start, range.end, ",").map((part) => oneLine(sql.slice(part.start, part.end))).filter(Boolean);
    const clause = make(ids, name === "GROUP BY" ? "group" : name === "ORDER BY" ? "order" : "clause", `${name} · ${pieces.length}`);
    clause.items = pieces;
    clause.itemTitle = name;
    query.children.push(clause);
  }

  return query;
}

function parseFrom(
  sql: string,
  start: number,
  end: number,
  ids: () => string,
  links: TableLink[],
): { nodes: AnalysisNode[]; tables: TableRef[] } {
  const nodes: AnalysisNode[] = [];
  const tables: TableRef[] = [];
  let index = start;
  let previous: string | null = null;
  let pendingJoin: string | null = null;

  while (index < end) {
    index = advance(sql, index, end);
    if (index >= end) break;
    if (sql[index] === ",") {
      pendingJoin = "콤마";
      index += 1;
      continue;
    }
    const join = readJoin(sql, index, end);
    if (join) {
      pendingJoin = join.how;
      index = advance(sql, join.end, end);
      if (isKeywordAt(sql, index, "LATERAL")) index = advance(sql, index + "LATERAL".length, end);
      continue;
    }

    const source = readSource(sql, index, end, ids, links);
    if (!source) {
      index += 1;
      continue;
    }
    let cursor = source.end;
    const condition = readJoinCondition(sql, cursor, end);
    if (pendingJoin && pendingJoin !== "콤마" && previous) {
      source.node.label = `${pendingJoin} ${source.node.label}`;
      const on = oneLine(condition.text.replace(/^(ON|USING)\s+/i, ""));
      if (on) source.node.items = [on];
      source.node.itemTitle = "연결 조건";
      const mentioned = tables.findLast((table) => new RegExp(`(?:^|[^\\p{L}\\p{N}_$#])${escapeRegExp(table.key)}\\.`, "iu").test(on));
      pushLink(links, mentioned?.label ?? previous, source.ref.label, pendingJoin, on);
    }
    nodes.push(source.node);
    tables.push(source.ref);
    previous = source.ref.label;
    pendingJoin = null;
    index = condition.end > cursor ? condition.end : cursor;
  }

  return { nodes, tables };
}

function readSource(
  sql: string,
  index: number,
  end: number,
  ids: () => string,
  links: TableLink[],
): { node: AnalysisNode; ref: TableRef; end: number } | null {
  if (sql[index] === "(") {
    const close = findMatchingParen(sql, index);
    const inner = unwrap(sql, index + 1, close);
    let node: AnalysisNode;
    let label: string;
    if (startsQuery(sql, index)) {
      const alias = readAlias(sql, close + 1, end);
      label = alias.text ? `인라인 뷰 ${alias.text}` : "인라인 뷰";
      const innerQuery = parseStatement(sql, inner.start, inner.end, ids, links);
      node = make(ids, "inline", label, innerQuery.kind === "query" ? innerQuery.children : [innerQuery]);
      node.selectItems = innerQuery.selectItems;
      node.whereItems = innerQuery.whereItems;
      return { node, ref: { key: (alias.text || label).toUpperCase(), label }, end: alias.end };
    }
    const nested = parseFrom(sql, inner.start, inner.end, ids, links);
    const alias = readAlias(sql, close + 1, end);
    label = alias.text || "조인 묶음";
    node = make(ids, "table", label, nested.nodes);
    return { node, ref: { key: label.toUpperCase(), label }, end: alias.end };
  }

  const name = readQualified(sql, index, end);
  if (!name) return null;
  let cursor = skipPivot(sql, name.end, end);
  const alias = readAlias(sql, cursor, end);
  const label = alias.text ? `${name.text} ${alias.text}` : name.text;
  const node = make(ids, "table", label);
  return { node, ref: { key: (alias.text || name.text).toUpperCase(), label }, end: alias.end };
}

function parseInsert(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  let index = advance(sql, start + "INSERT".length, end);
  if (isKeywordAt(sql, index, "INTO")) index = advance(sql, index + 4, end);
  const table = readQualified(sql, index, end);
  const node = make(ids, "insert", table ? `INSERT ${table.text}` : "INSERT");
  if (table) index = table.end;
  index = advance(sql, index, end);
  if (sql[index] === "(" && !startsQuery(sql, index)) index = advance(sql, findMatchingParen(sql, index) + 1, end);
  const queryAt = findKeyword(sql, index, end, "SELECT") ?? findKeyword(sql, index, end, "WITH");
  if (queryAt !== null) node.children.push(parseStatement(sql, queryAt, end, ids, links));
  return node;
}

function parseUpdate(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  const table = readQualified(sql, advance(sql, start + "UPDATE".length, end), end);
  const node = make(ids, "update", table ? `UPDATE ${table.text}` : "UPDATE");
  const setAt = findKeyword(sql, start, end, "SET");
  const whereAt = findKeyword(sql, start, end, "WHERE");
  if (setAt !== null) {
    const items = splitChar(sql, setAt + 3, whereAt ?? end, ",").map((part) => oneLine(sql.slice(part.start, part.end))).filter(Boolean);
    const setNode = make(ids, "set", `SET · ${items.length}`);
    setNode.items = items;
    setNode.itemTitle = "변경 값";
    node.children.push(setNode);
  }
  if (whereAt !== null) node.children.push(whereNode(sql, whereAt + 5, end, ids, links));
  return node;
}

function parseDelete(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  let index = advance(sql, start + "DELETE".length, end);
  if (isKeywordAt(sql, index, "FROM")) index = advance(sql, index + 4, end);
  const table = readQualified(sql, index, end);
  const node = make(ids, "delete", table ? `DELETE ${table.text}` : "DELETE");
  const where = findKeyword(sql, index, end, "WHERE");
  if (where !== null) {
    const next = nextClause(sql, where + 5, end);
    node.children.push(whereNode(sql, where + 5, next, ids, links));
  }
  return node;
}

function parseMerge(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  let index = advance(sql, start + "MERGE".length, end);
  if (isKeywordAt(sql, index, "INTO")) index = advance(sql, index + 4, end);
  const target = readQualified(sql, index, end);
  const node = make(ids, "merge", target ? `MERGE ${target.text}` : "MERGE");
  if (target) {
    const alias = readAlias(sql, target.end, end);
    node.children.push(make(ids, "table", alias.text ? `${target.text} ${alias.text}` : target.text));
    index = alias.end;
  }
  const using = findKeyword(sql, index, end, "USING");
  if (using !== null) {
    const source = readSource(sql, advance(sql, using + "USING".length, end), end, ids, links);
    if (source) {
      source.node.label = `USING ${source.node.label}`;
      node.children.push(source.node);
      index = source.end;
    }
  }
  const on = findKeyword(sql, index, end, "ON");
  if (on !== null) {
    const condition = readJoinCondition(sql, on, end);
    const onNode = make(ids, "on", "ON");
    onNode.items = [oneLine(condition.text.replace(/^ON\s+/i, ""))];
    onNode.itemTitle = "연결 조건";
    node.children.push(onNode);
  }
  return node;
}

function whereNode(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode {
  const predicates = splitAnd(sql, start, end).map((part) => oneLine(sql.slice(part.start, part.end))).filter(Boolean);
  const node = make(ids, "where", `WHERE · ${predicates.length}`);
  node.items = predicates;
  node.itemTitle = "검색 조건";
  node.children = findSubqueries(sql, start, end, ids, links);
  return node;
}

function findSubqueries(sql: string, start: number, end: number, ids: () => string, links: TableLink[]): AnalysisNode[] {
  const found: AnalysisNode[] = [];
  let index = start;
  while (index < end) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === "(" && startsQuery(sql, index)) {
      const close = Math.min(findMatchingParen(sql, index), end - 1);
      const label = subqueryLabel(sql, index);
      const innerQuery = parseStatement(sql, index + 1, close, ids, links);
      const subquery = make(ids, "subquery", label, innerQuery.kind === "query" ? innerQuery.children : [innerQuery]);
      subquery.selectItems = innerQuery.selectItems;
      subquery.whereItems = innerQuery.whereItems;
      found.push(subquery);
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return found;
}

function addWhereLinks(sql: string, start: number, end: number, tables: TableRef[], links: TableLink[]) {
  const byKey = new Map(tables.map((table) => [table.key, table.label]));
  for (const part of splitAnd(sql, start, end)) {
    const text = sql.slice(part.start, part.end);
    const pattern = /([\p{L}_][\p{L}\p{N}_$#]*)\s*\.\s*([\p{L}_][\p{L}\p{N}_$#]*)\s*=\s*([\p{L}_][\p{L}\p{N}_$#]*)\s*\.\s*([\p{L}_][\p{L}\p{N}_$#]*)(?:\s*\(\s*\+\s*\))?/giu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const left = byKey.get(match[1].toUpperCase());
      const right = byKey.get(match[3].toUpperCase());
      if (!left || !right || left === right) continue;
      pushLink(links, left, right, "WHERE", oneLine(`${match[1]}.${match[2]} = ${match[3]}.${match[4]}`));
    }
  }
}

function pushLink(links: TableLink[], left: string, right: string, how: string, on: string) {
  const existing = links.find((link) => link.how === how && ((link.left === left && link.right === right) || (link.left === right && link.right === left)));
  if (!existing) {
    links.push({ left, right, how, on });
    return;
  }
  if (on && !existing.on.split(" AND ").includes(on)) existing.on = existing.on ? `${existing.on} AND ${on}` : on;
}

function splitSet(sql: string, start: number, end: number): { op: string; start: number; end: number }[] {
  const parts: { op: string; start: number; end: number }[] = [];
  let depth = 0;
  let cursor = start;
  let partStart = start;
  let op = "";
  while (cursor < end) {
    const skipped = skipLiteral(sql, cursor);
    if (skipped > cursor) {
      cursor = skipped;
      continue;
    }
    if (sql[cursor] === "(") depth += 1;
    else if (sql[cursor] === ")" && depth > 0) depth -= 1;
    else if (depth === 0) {
      const found = matchPhrase(sql, cursor, [["UNION", "ALL"], ["UNION"], ["MINUS"], ["INTERSECT"]]);
      if (found) {
        parts.push({ op, start: partStart, end: cursor });
        op = found.name;
        cursor = found.end;
        partStart = cursor;
        continue;
      }
    }
    cursor += 1;
  }
  parts.push({ op, start: partStart, end });
  return parts.filter((part) => advance(sql, part.start, part.end) < part.end);
}

function findClauses(sql: string, start: number, end: number): { name: string; at: number; content: number }[] {
  const marks: { name: string; at: number; content: number }[] = [];
  let depth = 0;
  let index = start;
  while (index < end) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")" && depth > 0) depth -= 1;
    else if (depth === 0) {
      const found = matchPhrase(sql, index, clausePhrases);
      if (found) {
        marks.push({ name: found.name, at: index, content: found.end });
        index = found.end;
        continue;
      }
    }
    index += 1;
  }
  return marks;
}

function clauseRange(marks: { name: string; at: number; content: number }[], name: string, end: number): { start: number; end: number } | null {
  const index = marks.findIndex((mark) => mark.name === name);
  if (index < 0) return null;
  const next = marks[index + 1];
  return { start: marks[index].content, end: next ? next.at : end };
}

function nextClause(sql: string, start: number, end: number): number {
  const marks = findClauses(sql, start, end);
  return marks.length ? marks[0].at : end;
}

function findKeyword(sql: string, start: number, end: number, word: string): number | null {
  let depth = 0;
  let index = start;
  while (index < end) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")" && depth > 0) depth -= 1;
    else if (depth === 0 && isKeywordAt(sql, index, word)) return index;
    index += 1;
  }
  return null;
}

function splitAnd(sql: string, start: number, end: number): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let depth = 0;
  let index = start;
  let partStart = start;
  let between = false;
  while (index < end) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")" && depth > 0) depth -= 1;
    else if (depth === 0 && isKeywordAt(sql, index, "BETWEEN")) between = true;
    else if (depth === 0 && isKeywordAt(sql, index, "AND")) {
      if (between) {
        between = false;
        index += 3;
        continue;
      }
      parts.push({ start: partStart, end: index });
      index += 3;
      partStart = index;
      continue;
    }
    index += 1;
  }
  parts.push({ start: partStart, end });
  return parts.filter((part) => oneLine(sql.slice(part.start, part.end)) !== "");
}

function splitChar(sql: string, start: number, end: number, mark: string): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let depth = 0;
  let index = start;
  let partStart = start;
  while (index < end) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")" && depth > 0) depth -= 1;
    else if (depth === 0 && sql[index] === mark) {
      parts.push({ start: partStart, end: index });
      index += 1;
      partStart = index;
      continue;
    }
    index += 1;
  }
  parts.push({ start: partStart, end });
  return parts;
}

function readJoin(sql: string, index: number, end: number): { how: string; end: number } | null {
  const words: string[] = [];
  let cursor = index;
  for (let count = 0; count < 4; count += 1) {
    cursor = advance(sql, cursor, end);
    const ident = readIdent(sql, cursor, end);
    if (!ident) break;
    const word = ident.text.toUpperCase();
    if (!["NATURAL", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "JOIN"].includes(word)) break;
    words.push(word);
    cursor = ident.end;
    if (word === "JOIN") {
      return { how: words.join(" "), end: cursor };
    }
  }
  return null;
}

function readJoinCondition(sql: string, index: number, end: number): { text: string; end: number } {
  let cursor = advance(sql, index, end);
  if (!isKeywordAt(sql, cursor, "ON") && !isKeywordAt(sql, cursor, "USING")) return { text: "", end: index };
  const start = cursor;
  let depth = 0;
  while (cursor < end) {
    const skipped = skipLiteral(sql, cursor);
    if (skipped > cursor) {
      cursor = skipped;
      continue;
    }
    if (sql[cursor] === "(") depth += 1;
    else if (sql[cursor] === ")" && depth > 0) depth -= 1;
    else if (depth === 0 && cursor > start && (sql[cursor] === "," || readJoin(sql, cursor, end) || isMatchedWhen(sql, cursor, end))) break;
    cursor += 1;
  }
  return { text: sql.slice(start, cursor), end: cursor };
}

function isMatchedWhen(sql: string, index: number, end: number): boolean {
  if (!isKeywordAt(sql, index, "WHEN")) return false;
  const next = advance(sql, index + 4, end);
  return isKeywordAt(sql, next, "MATCHED") || isKeywordAt(sql, next, "NOT");
}

function readAlias(sql: string, index: number, end: number): { text: string; end: number } {
  let cursor = advance(sql, index, end);
  if (isKeywordAt(sql, cursor, "AS")) cursor = advance(sql, cursor + 2, end);
  const ident = readIdent(sql, cursor, end);
  if (!ident || stopWords.has(ident.text.toUpperCase())) return { text: "", end: index };
  return ident;
}

function readQualified(sql: string, index: number, end: number): { text: string; end: number } | null {
  const first = readIdent(sql, index, end);
  if (!first || stopWords.has(first.text.toUpperCase())) return null;
  let text = first.text;
  let cursor = first.end;
  while (sql[cursor] === ".") {
    const next = readIdent(sql, cursor + 1, end);
    if (!next) break;
    text += `.${next.text}`;
    cursor = next.end;
  }
  if (sql[cursor] === "@") {
    const link = readIdent(sql, cursor + 1, end);
    if (link) {
      text += `@${link.text}`;
      cursor = link.end;
    }
  }
  return { text, end: cursor };
}

function skipPivot(sql: string, index: number, end: number): number {
  let cursor = advance(sql, index, end);
  if (!isKeywordAt(sql, cursor, "PIVOT") && !isKeywordAt(sql, cursor, "UNPIVOT")) return index;
  cursor = advance(sql, cursor + (isKeywordAt(sql, cursor, "UNPIVOT") ? 7 : 5), end);
  if (sql[cursor] === "(") cursor = findMatchingParen(sql, cursor) + 1;
  return cursor;
}

function skipSelectMods(sql: string, index: number, end: number): number {
  let cursor = advance(sql, index, end);
  for (const word of ["DISTINCT", "UNIQUE", "ALL"]) {
    if (isKeywordAt(sql, cursor, word)) cursor = advance(sql, cursor + word.length, end);
  }
  return cursor;
}

function startsQuery(sql: string, openIndex: number): boolean {
  if (sql[openIndex] !== "(") return false;
  const at = advance(sql, openIndex + 1, sql.length);
  return isKeywordAt(sql, at, "SELECT") || isKeywordAt(sql, at, "WITH");
}

function subqueryLabel(sql: string, openIndex: number): string {
  const before = sql.slice(Math.max(0, openIndex - 40), openIndex);
  if (/\bNOT\s+EXISTS\s*$/i.test(before)) return "NOT EXISTS";
  if (/\bEXISTS\s*$/i.test(before)) return "EXISTS";
  if (/\bNOT\s+IN\s*$/i.test(before)) return "NOT IN";
  if (/\bIN\s*$/i.test(before)) return "IN";
  return "스칼라 서브쿼리";
}

function summarizeExpression(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const as = /^(.*\S)\s+AS\s+([\p{L}_"][\p{L}\p{N}_$#"]*)$/iu.exec(flat);
  if (as) return `${as[2].replace(/"/g, "")} ← ${oneLine(as[1], 72)}`;
  const alias = /^(.*\S)\s+([\p{L}_][\p{L}\p{N}_$#]*)$/u.exec(flat);
  if (alias && !stopWords.has(alias[2].toUpperCase()) && /[^\s]/.test(alias[1])) return `${alias[2]} ← ${oneLine(alias[1], 72)}`;
  return oneLine(flat, 96);
}

function unwrap(sql: string, start: number, end: number): { start: number; end: number } {
  let range = trimRange(sql, start, end);
  while (sql[range.start] === "(") {
    const close = findMatchingParen(sql, range.start);
    if (close !== range.end - 1) break;
    range = trimRange(sql, range.start + 1, close);
  }
  return range;
}

function trimRange(sql: string, start: number, end: number): { start: number; end: number } {
  let left = advance(sql, start, end);
  let right = end;
  while (right > left && /\s/.test(sql[right - 1])) right -= 1;
  return { start: left, end: right };
}

function matchPhrase(sql: string, index: number, phrases: string[][]): { name: string; end: number } | null {
  for (const phrase of phrases) {
    let cursor = index;
    let matched = true;
    for (let wordIndex = 0; wordIndex < phrase.length; wordIndex += 1) {
      if (wordIndex > 0) cursor = advance(sql, cursor, sql.length);
      if (!isKeywordAt(sql, cursor, phrase[wordIndex])) {
        matched = false;
        break;
      }
      cursor += phrase[wordIndex].length;
    }
    if (matched) return { name: phrase.join(" "), end: cursor };
  }
  return null;
}

function readIdent(sql: string, index: number, end: number): { text: string; end: number } | null {
  if (index >= end) return null;
  if (sql[index] === '"') {
    const close = skipQuote(sql, index, '"');
    if (close > end) return null;
    return { text: sql.slice(index + 1, Math.max(index + 1, close - 1)).replace(/""/g, '"'), end: close };
  }
  const match = /^[\p{L}_][\p{L}\p{N}_$#]*/u.exec(sql.slice(index, end));
  if (!match) return null;
  return { text: match[0], end: index + match[0].length };
}

function advance(sql: string, index: number, end: number): number {
  let cursor = index;
  while (cursor < end) {
    if (sql.startsWith("--", cursor) || sql.startsWith("/*", cursor)) {
      cursor = skipLiteral(sql, cursor);
      continue;
    }
    if (/\s/.test(sql[cursor])) {
      cursor += 1;
      continue;
    }
    return cursor;
  }
  return cursor;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function make(ids: () => string, kind: string, label: string, children: AnalysisNode[] = []): AnalysisNode {
  return { id: ids(), kind, label, items: [], itemTitle: "", selectItems: [], whereItems: [], children };
}

function walk(node: AnalysisNode, visit: (node: AnalysisNode) => void) {
  visit(node);
  node.children.forEach((child) => walk(child, visit));
}

function makeIds(): () => string {
  let number = 0;
  return () => {
    number += 1;
    return `n${number}`;
  };
}

function isKeywordAt(sql: string, index: number, word: string): boolean {
  if (sql.slice(index, index + word.length).toUpperCase() !== word) return false;
  const before = index > 0 ? sql[index - 1] : "";
  const after = sql[index + word.length] ?? "";
  return !/[\p{L}\p{N}_$#]/u.test(before) && !/[\p{L}\p{N}_$#]/u.test(after);
}

function findMatchingParen(sql: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (sql[index] === "(") depth += 1;
    else if (sql[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return sql.length - 1;
}

function skipLiteral(sql: string, index: number): number {
  if (sql.startsWith("--", index)) {
    const end = sql.indexOf("\n", index);
    return end === -1 ? sql.length : end;
  }
  if (sql.startsWith("/*", index)) {
    const end = sql.indexOf("*/", index + 2);
    return end === -1 ? sql.length : end + 2;
  }
  const quoted = qQuoteEnd(sql, index) ?? nationalStringEnd(sql, index);
  if (quoted !== null) return quoted;
  if (sql[index] === "'") return skipQuote(sql, index, "'");
  if (sql[index] === '"') return skipQuote(sql, index, '"');
  return index;
}

function qQuoteEnd(sql: string, index: number): number | null {
  if (index > 0 && /[\p{L}\p{N}_$#]/u.test(sql[index - 1])) return null;
  let cursor = index;
  if (sql[cursor] === "n" || sql[cursor] === "N") {
    const next = sql[cursor + 1];
    if (next !== "q" && next !== "Q") return null;
    cursor += 1;
  } else if (sql[cursor] !== "q" && sql[cursor] !== "Q") return null;
  if (sql[cursor + 1] !== "'") return null;
  const delimiter = sql[cursor + 2];
  if (!delimiter) return sql.length;
  const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}", "<": ">" };
  const closing = `${pairs[delimiter] ?? delimiter}'`;
  const found = sql.indexOf(closing, cursor + 3);
  return found === -1 ? sql.length : found + closing.length;
}

function nationalStringEnd(sql: string, index: number): number | null {
  if (index > 0 && /[\p{L}\p{N}_$#]/u.test(sql[index - 1])) return null;
  if ((sql[index] === "n" || sql[index] === "N") && sql[index + 1] === "'") return skipQuote(sql, index + 1, "'");
  return null;
}

function skipQuote(sql: string, index: number, quote: "'" | '"'): number {
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote && sql[cursor + 1] === quote) {
      cursor += 2;
      continue;
    }
    if (sql[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return sql.length;
}
