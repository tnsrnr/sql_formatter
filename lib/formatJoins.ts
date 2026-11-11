const JOIN_PHRASES = [
  ["FULL", "OUTER", "JOIN"],
  ["LEFT", "OUTER", "JOIN"],
  ["RIGHT", "OUTER", "JOIN"],
  ["INNER", "JOIN"],
  ["CROSS", "JOIN"],
  ["NATURAL", "JOIN"],
  ["FULL", "JOIN"],
  ["LEFT", "JOIN"],
  ["RIGHT", "JOIN"],
  ["JOIN"],
];

const CLAUSE_ENDS = [
  ["WHERE"],
  ["HAVING"],
  ["GROUP", "BY"],
  ["ORDER", "BY"],
  ["UNION"],
  ["MINUS"],
  ["INTERSECT"],
  ["CONNECT", "BY"],
  ["START", "WITH"],
  ["FETCH"],
  ["OFFSET"],
  ["LIMIT"],
  ["WINDOW"],
  ["RETURNING"],
  ["QUALIFY"],
  ["PIVOT"],
  ["UNPIVOT"],
];

type Condition = { op: string; expr: string };
type Join = { keyword: string; table: string; using: string | null; conditions: Condition[] };
type FromItem = { table: string; joins: Join[] };

/** ANSI JOIN을 ON 위치와 = 위치에 맞추고, JOIN 사이는 한 줄 비운다. */
export function formatJoinLayout(sql: string): string {
  const froms: number[] = [];
  let index = 0;
  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (isLineStart(sql, index) && matchWord(sql, index, "FROM")) froms.push(index);
    index += 1;
  }

  let out = sql;
  for (let cursor = froms.length - 1; cursor >= 0; cursor -= 1) {
    const rewritten = rewriteFrom(out, froms[cursor]);
    if (!rewritten) continue;
    out = out.slice(0, rewritten.from) + rewritten.text + out.slice(rewritten.to);
  }
  return out;
}

function rewriteFrom(sql: string, fromIndex: number): { from: number; to: number; text: string } | null {
  const fromKeyword = readWord(sql, fromIndex);
  const parsed = parseFromBody(sql, fromIndex + fromKeyword.length);
  if (!parsed.items.some((item) => item.joins.length > 0)) return null;
  const indent = indentOf(sql, fromIndex);
  return { from: fromIndex - indent, to: parsed.end, text: renderFrom(indent, fromKeyword, parsed.items) };
}

function parseFromBody(sql: string, start: number): { items: FromItem[]; end: number } {
  const items: FromItem[] = [];
  let index = start;

  while (index < sql.length) {
    const at = skipNoise(sql, index);
    if (at >= sql.length || isClauseEnd(sql, at) || sql[at] === ")" || sql[at] === ";") {
      return { items, end: index };
    }
    if (sql[at] === ",") {
      index = at + 1;
      continue;
    }

    const table = readUntil(sql, at, false);
    index = table.end;
    const joins: Join[] = [];
    while (index < sql.length) {
      const joinAt = skipNoise(sql, index);
      const keyword = matchJoin(sql, joinAt);
      if (!keyword) break;
      const join = readJoin(sql, joinAt, keyword);
      joins.push(join.value);
      index = join.end;
    }
    const cleaned = cleanup(table.text);
    if (cleaned || joins.length > 0) items.push({ table: cleaned, joins });
  }

  return { items, end: index };
}

function readJoin(sql: string, start: number, keyword: string): { value: Join; end: number } {
  const afterKeyword = skipNoise(sql, start + keyword.length);
  const table = readUntil(sql, afterKeyword, true);
  let index = table.end;
  const at = skipNoise(sql, index);
  let using: string | null = null;
  let conditions: Condition[] = [];

  if (matchWord(sql, at, "ON")) {
    const read = readConditions(sql, at);
    conditions = read.conditions;
    index = read.end;
  } else if (matchWord(sql, at, "USING")) {
    const read = readUsing(sql, at);
    using = read.text;
    index = read.end;
  }

  return {
    value: { keyword: keyword.replace(/\s+/g, " "), table: cleanup(table.text), using, conditions },
    end: index,
  };
}

function readConditions(sql: string, start: number): { conditions: Condition[]; end: number } {
  const conditions: Condition[] = [];
  let index = start;
  let op = readWord(sql, index);
  index = skipNoise(sql, index + op.length);

  while (index < sql.length) {
    const expr = readUntil(sql, index, true);
    const text = collapseWs(expr.text).trim();
    if (text) conditions.push({ op, expr: text });
    const at = skipNoise(sql, expr.end);
    if (matchWord(sql, at, "AND") || matchWord(sql, at, "OR")) {
      op = readWord(sql, at);
      index = skipNoise(sql, at + op.length);
      continue;
    }
    return { conditions, end: expr.end };
  }

  return { conditions, end: index };
}

function readUsing(sql: string, start: number): { text: string; end: number } {
  const keyword = readWord(sql, start);
  let index = skipNoise(sql, start + keyword.length);
  if (sql[index] !== "(") return { text: keyword, end: index };
  const list = readUntil(sql, index, false);
  return { text: `${keyword} ${collapseWs(list.text).trim()}`, end: list.end };
}

function readUntil(sql: string, start: number, stopAtOn: boolean): { text: string; end: number } {
  let depth = 0;
  let index = start;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }

    const char = sql[index];
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0) {
      if (char === "," || char === ";" || isClauseEnd(sql, index) || matchJoin(sql, index)) break;
      if (
        stopAtOn &&
        (matchWord(sql, index, "ON") || matchWord(sql, index, "USING") || matchWord(sql, index, "AND") || matchWord(sql, index, "OR"))
      ) {
        break;
      }
    }

    index += 1;
  }

  const end = rewindWs(sql, index, start);
  return { text: sql.slice(start, end), end };
}

function rewindWs(sql: string, index: number, floor: number): number {
  let cursor = index;
  while (cursor > floor && /\s/.test(sql[cursor - 1])) cursor -= 1;
  return cursor;
}

function renderFrom(indentSize: number, fromKeyword: string, items: FromItem[]): string {
  const indent = " ".repeat(indentSize);
  const lines: string[] = [];

  items.forEach((item, itemIndex) => {
    if (itemIndex > 0) lines.push("");
    const head = item.table ? `${fromKeyword} ${item.table}` : fromKeyword;
    lines.push(itemIndex === 0 ? `${indent}${head}` : `${" ".repeat(indentSize + fromKeyword.length - 1)}, ${item.table}`);
    lines.push(...renderJoins(indentSize, item.joins));
  });

  return lines.join("\n");
}

function renderJoins(indentSize: number, joins: Join[]): string[] {
  const indent = " ".repeat(indentSize);
  const lines: string[] = [];

  joins.forEach((join, index) => {
    if (index > 0) lines.push("");
    lines.push(join.table ? `${indent}${join.keyword} ${join.table}` : `${indent}${join.keyword}`);
    const joinAt = join.keyword.toUpperCase().lastIndexOf("JOIN");
    const onColumn = indentSize + (joinAt < 0 ? 0 : joinAt);
    if (join.using) lines.push(`${" ".repeat(onColumn)}${join.using}`);
    if (join.conditions.length > 0) lines.push(...renderConditions(onColumn, join.conditions));
  });

  return lines;
}

function renderConditions(onColumn: number, conditions: Condition[]): string[] {
  const pieces = conditions.map((condition) => ({ op: condition.op, ...splitEquals(condition.expr) }));
  const width = pieces.reduce((max, piece) => Math.max(max, piece.left?.length ?? 0), 0);

  return pieces.map((piece) => {
    const opColumn = Math.max(0, onColumn + 2 - piece.op.length);
    const pad = " ".repeat(opColumn);
    if (piece.left == null) return `${pad}${piece.op} ${piece.expr}`;
    const left = width > 0 ? piece.left.padEnd(width) : piece.left;
    return `${pad}${piece.op} ${left} = ${piece.right}`;
  });
}

function splitEquals(expr: string): { left: string | null; expr: string; right?: string } {
  let depth = 0;
  let index = 0;
  while (index < expr.length) {
    const skipped = skipLiteral(expr, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (expr[index] === "(") depth += 1;
    else if (expr[index] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && expr[index] === "=") {
      const previous = index > 0 ? expr[index - 1] : "";
      const next = expr[index + 1] ?? "";
      if (!"!<>".includes(previous) && next !== ">") {
        const left = expr.slice(0, index).trim();
        const right = expr.slice(index + 1).trim();
        if (left && right) return { left, expr, right };
      }
    }
    index += 1;
  }
  return { left: null, expr };
}

function cleanup(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.includes("\n")) return collapseWs(trimmed).trim();
  return trimmed;
}

function isClauseEnd(sql: string, index: number): boolean {
  return CLAUSE_ENDS.some((phrase) => matchPhrase(sql, index, phrase));
}

function matchJoin(sql: string, index: number): string | null {
  for (const phrase of JOIN_PHRASES) {
    const matched = matchPhrase(sql, index, phrase);
    if (matched) return matched;
  }
  return null;
}

function matchPhrase(sql: string, index: number, phrase: string[]): string | null {
  let cursor = index;
  const parts: string[] = [];
  for (let wordIndex = 0; wordIndex < phrase.length; wordIndex += 1) {
    if (wordIndex > 0) {
      if (!/\s/.test(sql[cursor] ?? "")) return null;
      while (/\s/.test(sql[cursor] ?? "")) cursor += 1;
    }
    const word = phrase[wordIndex];
    if (!matchWord(sql, cursor, word)) return null;
    parts.push(sql.slice(cursor, cursor + word.length));
    cursor += word.length;
  }
  return parts.join(" ");
}

function matchWord(sql: string, index: number, word: string): boolean {
  if (index < 0 || index >= sql.length) return false;
  if (sql.slice(index, index + word.length).toUpperCase() !== word) return false;
  const previous = index > 0 ? sql[index - 1] : "";
  const next = sql[index + word.length] ?? "";
  if (previous && /[A-Za-z0-9_$#]/.test(previous)) return false;
  if (next && /[A-Za-z0-9_$#]/.test(next)) return false;
  return true;
}

function readWord(sql: string, index: number): string {
  return /^[A-Za-z][A-Za-z0-9_$#]*/.exec(sql.slice(index))?.[0] ?? "";
}

function isLineStart(sql: string, index: number): boolean {
  let cursor = index;
  while (cursor > 0 && sql[cursor - 1] !== "\n") {
    cursor -= 1;
    if (!/\s/.test(sql[cursor])) return false;
  }
  return true;
}

function indentOf(sql: string, index: number): number {
  let cursor = index;
  while (cursor > 0 && sql[cursor - 1] !== "\n") cursor -= 1;
  return index - cursor;
}

function skipNoise(sql: string, index: number): number {
  let cursor = index;
  while (cursor < sql.length) {
    if (/\s/.test(sql[cursor])) {
      cursor += 1;
      continue;
    }
    if (sql.startsWith("--", cursor)) {
      const end = sql.indexOf("\n", cursor);
      cursor = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", cursor)) {
      const end = sql.indexOf("*/", cursor + 2);
      cursor = end === -1 ? sql.length : end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function collapseWs(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      out += sql.slice(index, skipped);
      index = skipped;
      continue;
    }
    if (/\s/.test(sql[index])) {
      out += " ";
      while (index < sql.length && /\s/.test(sql[index])) index += 1;
      continue;
    }
    out += sql[index];
    index += 1;
  }
  return out;
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
  if (index > 0 && /[A-Za-z0-9_$#]/.test(sql[index - 1])) return null;
  let cursor = index;
  if (sql[cursor] === "n" || sql[cursor] === "N") {
    const next = sql[cursor + 1];
    if (next !== "q" && next !== "Q") return null;
    cursor += 1;
  } else if (sql[cursor] !== "q" && sql[cursor] !== "Q") {
    return null;
  }
  if (sql[cursor + 1] !== "'") return null;
  const delimiter = sql[cursor + 2];
  if (!delimiter) return sql.length;
  const pairs: Record<string, string> = { "[": "]", "(": ")", "{": "}", "<": ">" };
  const closing = `${pairs[delimiter] ?? delimiter}'`;
  const found = sql.indexOf(closing, cursor + 3);
  return found === -1 ? sql.length : found + closing.length;
}

function nationalStringEnd(sql: string, index: number): number | null {
  if (index > 0 && /[A-Za-z0-9_$#]/.test(sql[index - 1])) return null;
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
