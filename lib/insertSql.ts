import type { LetterCase } from "@/lib/formatSql";

export type InsertStatement = {
  insertKeyword: string;
  intoKeyword: string;
  valuesKeyword: string;
  table: string;
  columns: string[];
  rows: string[][];
  semicolon: boolean;
  end: number;
};

export type InsertColumnMap = {
  table: string;
  rows: { column: string; value: string }[][];
};

/** INSERT INTO ... (컬럼) VALUES (...) 이면 컬럼·값을 읽는다. 아니면 null. */
export function readInsert(sql: string): InsertStatement | null {
  let index = skipNoise(sql, 0);
  if (!isWord(sql, index, "INSERT")) return null;
  const insertKeyword = readWord(sql, index);
  index = skipNoise(sql, index + insertKeyword.length);
  if (!isWord(sql, index, "INTO")) return null;
  const intoKeyword = readWord(sql, index);
  index = skipNoise(sql, index + intoKeyword.length);
  const table = readName(sql, index);
  if (!table) return null;
  index = skipNoise(sql, table.end);
  if (sql[index] !== "(") return null;
  const columns = splitList(sql, index + 1);
  if (!columns || columns.items.length === 0) return null;
  index = skipNoise(sql, columns.end);
  if (!isWord(sql, index, "VALUES")) return null;
  const valuesKeyword = readWord(sql, index);
  index = skipNoise(sql, index + valuesKeyword.length);

  const rows: string[][] = [];
  while (index < sql.length && sql[index] === "(") {
    const row = splitList(sql, index + 1);
    if (!row || row.items.length === 0) return null;
    rows.push(row.items);
    index = skipNoise(sql, row.end);
    if (sql[index] === ",") {
      index = skipNoise(sql, index + 1);
      continue;
    }
    break;
  }
  if (rows.length === 0) return null;

  let semicolon = false;
  if (sql[index] === ";") {
    semicolon = true;
    index += 1;
  }

  return {
    insertKeyword,
    intoKeyword,
    valuesKeyword,
    table: table.text,
    columns: columns.items,
    rows,
    semicolon,
    end: index,
  };
}

/** 컬럼과 값을 각각 한 줄로 맞춘다. */
export function alignInsert(
  sql: string,
  letterCase: LetterCase,
  formatQuery: (query: string) => string,
): { text: string; end: number } | null {
  const found = readInsert(sql);
  if (!found) return null;

  const columns = found.columns.map((column, index) => {
    const comma = index < found.columns.length - 1 ? "," : "";
    return `    ${caseName(column, letterCase)}${comma}`;
  });
  const rows = found.rows.map((row) => {
    const lines = row.map((value, index) => indentValue(presentValue(value, letterCase, formatQuery), index < row.length - 1));
    return `(\n${lines.join("\n")}\n)`;
  });
  const text = [
    `${caseWords(found.insertKeyword, letterCase)} ${caseWords(found.intoKeyword, letterCase)} ${caseName(found.table, letterCase)} (`,
    columns.join("\n"),
    `) ${caseWords(found.valuesKeyword, letterCase)} ${rows.join(",\n")}${found.semicolon ? ";" : ""}`,
  ].join("\n");

  return { text, end: found.end };
}

/** 분석 화면용 컬럼-값 짝. 이 문장 전체가 INSERT VALUES 일 때만. */
export function insertColumnMap(
  sql: string,
  letterCase: LetterCase,
  formatQuery: (query: string) => string,
): InsertColumnMap | null {
  const found = readInsert(sql);
  if (!found) return null;
  if (sql.slice(found.end).trim()) return null;

  return {
    table: caseName(found.table, letterCase),
    rows: found.rows.map((row) => {
      const width = Math.max(found.columns.length, row.length);
      return Array.from({ length: width }, (_, index) => ({
        column: found.columns[index] ? caseName(found.columns[index], letterCase) : "",
        value: presentValue(row[index] ?? "", letterCase, formatQuery),
      }));
    }),
  };
}

function presentValue(value: string, letterCase: LetterCase, formatQuery: (query: string) => string): string {
  return expandSubqueries(tidyExpression(value, letterCase), formatQuery);
}

function tidyExpression(sql: string, letterCase: LetterCase): string {
  return caseWords(spaceCommas(collapseWs(sql).trim()), letterCase);
}

function caseName(text: string, letterCase: LetterCase): string {
  const flat = collapseWs(text).trim();
  const cleaned = flat.includes('"') ? flat : flat.replace(/\s+/g, "");
  return caseWords(cleaned, letterCase);
}

function indentValue(value: string, comma: boolean): string {
  const lines = value.split("\n");
  return lines
    .map((line, index) => {
      const suffix = index === lines.length - 1 && comma ? "," : "";
      return index === 0 ? `    ${line}${suffix}` : `${line}${suffix}`;
    })
    .join("\n");
}

function expandSubqueries(sql: string, formatQuery: (query: string) => string): string {
  let out = "";
  let index = 0;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      out += sql.slice(index, skipped);
      index = skipped;
      continue;
    }

    if (sql[index] === "(" && opensQuery(sql, index + 1)) {
      const close = findClose(sql, index);
      if (close === -1) {
        out += sql[index];
        index += 1;
        continue;
      }
      const formatted = formatInner(sql.slice(index + 1, close), formatQuery);
      const body = formatted
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n");
      out += `(\n${body}\n    )`;
      index = close + 1;
      continue;
    }

    out += sql[index];
    index += 1;
  }

  return out;
}

function formatInner(sql: string, formatQuery: (query: string) => string): string {
  const inner = sql.trim();
  if (!inner) return inner;
  try {
    const next = formatQuery(inner).trim();
    return next || inner;
  } catch {
    return inner;
  }
}

function opensQuery(sql: string, index: number): boolean {
  const at = skipNoise(sql, index);
  return isWord(sql, at, "SELECT") || isWord(sql, at, "WITH");
}

function findClose(sql: string, open: number): number {
  let depth = 0;
  let index = open;
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
  return -1;
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

function spaceCommas(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      out += sql.slice(index, skipped);
      index = skipped;
      continue;
    }
    out += sql[index];
    if (sql[index] === "," && sql[index + 1] !== " ") out += " ";
    index += 1;
  }
  return out;
}

function caseWords(sql: string, letterCase: LetterCase): string {
  if (letterCase === "preserve") return sql;
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      out += sql.slice(index, skipped);
      index = skipped;
      continue;
    }
    const previous = index > 0 ? sql[index - 1] : "";
    if (/[A-Za-z]/.test(sql[index]) && previous !== ":" && previous !== "&") {
      const word = /^[A-Za-z][A-Za-z0-9_$#]*/.exec(sql.slice(index))?.[0] ?? sql[index];
      out += letterCase === "upper" ? word.toUpperCase() : word.toLowerCase();
      index += word.length;
      continue;
    }
    out += sql[index];
    index += 1;
  }
  return out;
}

function splitList(sql: string, start: number): { items: string[]; end: number } | null {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let index = start;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      current += sql.slice(index, skipped);
      index = skipped;
      continue;
    }

    const char = sql[index];
    if (char === "(") {
      depth += 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) {
        pushItem(items, current);
        if (items.length > 0 && items[items.length - 1] === "") items.pop();
        if (items.length === 0 || items.some((item) => item === "")) return null;
        return { items, end: index + 1 };
      }
      depth -= 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === "," && depth === 0) {
      pushItem(items, current);
      current = "";
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  return null;
}

function pushItem(items: string[], current: string) {
  items.push(current.trim());
}

function readName(sql: string, index: number): { text: string; end: number } | null {
  let end = index;
  let any = false;
  while (end < sql.length) {
    if (sql[end] === '"') {
      const next = skipQuote(sql, end, '"');
      if (next === end) break;
      end = next;
      any = true;
      continue;
    }
    if (/[A-Za-z0-9_$#]/.test(sql[end]) || sql[end] === "." || sql[end] === "@") {
      end += 1;
      any = true;
      continue;
    }
    break;
  }
  if (!any) return null;
  return { text: sql.slice(index, end), end };
}

function isWord(sql: string, index: number, word: string): boolean {
  if (index < 0 || sql.slice(index, index + word.length).toUpperCase() !== word) return false;
  const after = sql[index + word.length];
  return !after || !/[A-Za-z0-9_$#]/.test(after);
}

function readWord(sql: string, index: number): string {
  return /^[A-Za-z][A-Za-z0-9_$#]*/.exec(sql.slice(index))?.[0] ?? "";
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
