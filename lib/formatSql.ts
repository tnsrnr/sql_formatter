import { format, type KeywordCase } from "sql-formatter";
import { alignInsert } from "./insertSql";

export type LetterCase = KeywordCase;
export type ExpressionWidth = 10 | 50 | 80 | 120;
export type ItemsPerLine = 1 | 2 | 3 | 5 | 10;
export type TabWidth = 0 | 1 | 2 | 4;

export type ThemeName = "dark" | "light";

export type FormatterSettings = {
  letterCase: LetterCase;
  tabWidth: TabWidth;
  expressionWidth: ExpressionWidth;
  selectItemsPerLine: ItemsPerLine;
  fromItemsPerLine: ItemsPerLine;
  clauseItemsPerLine: ItemsPerLine;
  theme: ThemeName;
};

export const defaultSettings: FormatterSettings = {
  letterCase: "upper",
  tabWidth: 2,
  expressionWidth: 80,
  selectItemsPerLine: 1,
  fromItemsPerLine: 1,
  clauseItemsPerLine: 5,
  theme: "dark",
};

/**
 * sql-formatter PL/SQL 방언이 키워드로 취급하지 않는 오라클 단어.
 * 키워드 대소문자가 "유지"가 아닐 때만 바꾸고, 문자열·주석·바인드 변수는 그대로 둔다.
 * 팀에 맞는 단어를 여기 추가하면 다음 정렬부터 적용된다.
 */
const extraOracleWords = new Set([
  "ROWNUM",
  "ROWID",
  "DUAL",
  "PIVOT",
  "UNPIVOT",
  "OVER",
  "LISTAGG",
  "WITHIN",
  "NULLS",
  "FIRST",
  "LAST",
]);

const letterCases = ["preserve", "upper", "lower"] as const;
const themeNames = ["dark", "light"] as const;
const itemsPerLineOptions = [1, 2, 3, 5, 10] as const;
const tabWidths = [0, 1, 2, 4] as const;
const expressionWidths = [10, 50, 80, 120] as const;

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isExpressionWidth(value: unknown): value is ExpressionWidth {
  return typeof value === "number" && (expressionWidths as readonly number[]).includes(value);
}

function isItemsPerLine(value: unknown): value is ItemsPerLine {
  return typeof value === "number" && (itemsPerLineOptions as readonly number[]).includes(value);
}

function isTabWidth(value: unknown): value is TabWidth {
  return typeof value === "number" && (tabWidths as readonly number[]).includes(value);
}

export function sanitizeSettings(value: unknown): FormatterSettings {
  if (!value || typeof value !== "object") return { ...defaultSettings };

  const raw = value as Partial<FormatterSettings> & { groupByItemsPerLine?: unknown };
  const storedClause = raw.clauseItemsPerLine ?? raw.groupByItemsPerLine;
  return {
    letterCase: isOneOf(raw.letterCase, letterCases) ? raw.letterCase : defaultSettings.letterCase,
    tabWidth: isTabWidth(raw.tabWidth) ? raw.tabWidth : defaultSettings.tabWidth,
    expressionWidth: isExpressionWidth(raw.expressionWidth)
      ? raw.expressionWidth
      : defaultSettings.expressionWidth,
    selectItemsPerLine: isItemsPerLine(raw.selectItemsPerLine)
      ? raw.selectItemsPerLine
      : defaultSettings.selectItemsPerLine,
    fromItemsPerLine: isItemsPerLine(raw.fromItemsPerLine) ? raw.fromItemsPerLine : defaultSettings.fromItemsPerLine,
    clauseItemsPerLine: isItemsPerLine(storedClause) ? storedClause : defaultSettings.clauseItemsPerLine,
    theme: isOneOf(raw.theme, themeNames) ? raw.theme : defaultSettings.theme,
  };
}

export function formatOracleSql(sql: string, settings: FormatterSettings): string {
  try {
    const masked = maskQuestionMarks(sql);
    const aligned = alignInsert(masked.sql, settings.letterCase, (query) => formatOracleSql(query, settings));
    if (aligned) {
      const rest = masked.sql.slice(aligned.end);
      const tail = rest.trim() ? formatOracleSql(rest, settings) : "";
      return collapseBlockComments(restoreQuestionMarks(joinParts(aligned.text, tail), masked.count));
    }
    const pieces = collectPieces(masked.sql, settings);
    let out = "";
    for (const piece of pieces) {
      out = joinParts(out, piece.polish ? polish(piece.text, settings) : piece.text);
    }
    return collapseBlockComments(restoreQuestionMarks(out, masked.count));
  } catch {
    return sql;
  }
}

function formatOptions(settings: FormatterSettings) {
  return {
    language: "plsql" as const,
    tabWidth: settings.tabWidth,
    useTabs: false,
    keywordCase: settings.letterCase,
    identifierCase: settings.letterCase,
    dataTypeCase: settings.letterCase,
    functionCase: settings.letterCase,
    indentStyle: "tabularRight" as const,
    logicalOperatorNewline: "before" as const,
    expressionWidth: settings.expressionWidth,
    linesBetweenQueries: 1,
    denseOperators: false,
    newlineBeforeSemicolon: false,
  };
}

type FormatAttempt = { ok: true; text: string } | { ok: false; index: number | null };

type Piece = { text: string; polish: boolean };

/**
 * 한 번에 읽히지 않는 쿼리도 맞출 수 있는 조각까지 정렬한다.
 * 깨진 토큰은 지우지 않고 그 자리에 둔다.
 */
function collectPieces(sql: string, settings: FormatterSettings): Piece[] {
  const pieces: Piece[] = [];
  let remaining = sql;
  let guard = 0;

  while (remaining.length > 0 && guard < 200) {
    guard += 1;
    if (!remaining.trim()) {
      pieces.push({ text: remaining, polish: false });
      break;
    }

    const attempt = attemptPiece(remaining, settings);
    if (attempt.ok) {
      pieces.push({ text: attempt.text, polish: true });
      break;
    }

    const errorAt = attempt.index ?? 0;
    let split = errorAt > 0 ? largestParseablePrefix(remaining, errorAt, settings) : 0;
    if (split > 0) {
      const cut = cutDanglingOperator(remaining, split);
      if (cut < split) {
        if (cut > 0 && attemptPiece(remaining.slice(0, cut), settings).ok) split = cut;
        else if (cut === 0) split = 0;
      }
    }
    if (split > 0 && split < remaining.length) {
      const head = attemptPiece(remaining.slice(0, split), settings);
      if (head.ok) {
        pieces.push({ text: head.text, polish: true });
        remaining = remaining.slice(split);
        continue;
      }
    }

    const brokenEnd = consumeBroken(remaining, errorAt);
    if (brokenEnd <= 0) {
      pieces.push({ text: remaining, polish: false });
      break;
    }
    pieces.push({ text: remaining.slice(0, brokenEnd), polish: false });
    remaining = remaining.slice(brokenEnd);
  }

  if (remaining.length > 0 && guard >= 200) pieces.push({ text: remaining, polish: false });
  return pieces;
}

function attemptFormat(sql: string, settings: FormatterSettings): FormatAttempt {
  try {
    return { ok: true, text: format(sql, formatOptions(settings)) };
  } catch (error) {
    return { ok: false, index: parseErrorIndex(error, sql) };
  }
}

function attemptPiece(sql: string, settings: FormatterSettings): FormatAttempt {
  const direct = attemptFormat(sql, settings);
  if (direct.ok) return direct;

  const leading = sql.length - sql.trimStart().length;
  const body = sql.slice(leading).trimEnd();
  const kind = fragmentKind(body);
  if (!kind) return direct;

  const wrapped = kind.prefix + body;
  const attempt = attemptFormat(wrapped, settings);
  if (!attempt.ok) {
    if (attempt.index == null) return direct;
    const mapped = attempt.index - kind.prefix.length + leading;
    return { ok: false, index: mapped < leading ? leading : Math.min(sql.length, mapped) };
  }

  const text = unwrapAfter(attempt.text, kind.marker, kind.occurrence, kind.expect);
  return text == null ? direct : { ok: true, text };
}

type FragmentKind = { prefix: string; marker: string; occurrence: number; expect: RegExp };

function fragmentKind(body: string): FragmentKind | null {
  if (/^(AND|OR)\b/i.test(body)) {
    return {
      prefix: "SELECT * FROM SQLFMT_ANCHOR WHERE SQLFMT_KEEP = SQLFMT_KEEP ",
      marker: "SQLFMT_KEEP",
      occurrence: 2,
      expect: /^\s*(AND|OR)\b/i,
    };
  }
  if (/^(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|CONNECT\s+BY|START\s+WITH)\b/i.test(body)) {
    return {
      prefix: "SELECT * FROM SQLFMT_ANCHOR ",
      marker: "SQLFMT_ANCHOR",
      occurrence: 1,
      expect: /^\s*(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|CONNECT\s+BY|START\s+WITH)\b/i,
    };
  }
  if (body.startsWith(",")) {
    return {
      prefix: "SELECT SQLFMT_KEEP ",
      marker: "SQLFMT_KEEP",
      occurrence: 1,
      expect: /^\s*,/,
    };
  }
  return null;
}

function unwrapAfter(formatted: string, marker: string, occurrence: number, expect: RegExp): string | null {
  const lower = formatted.toLowerCase();
  const needle = marker.toLowerCase();
  let from = 0;
  for (let count = 0; count < occurrence; count += 1) {
    const found = lower.indexOf(needle, from);
    if (found < 0) return null;
    from = found + needle.length;
  }

  const rest = formatted.slice(from).replace(/^[ \t]*\n/, "").replace(/\s+$/, "");
  if (!expect.test(rest)) return null;
  return rest;
}

/** 깨진 괄호 바로 앞의 연산자는 앞 문장에 붙이지 않고 `+)`처럼 원문 그대로 남긴다. */
function cutDanglingOperator(sql: string, split: number): number {
  let end = split;

  while (end > 0) {
    let index = 0;
    let tokenStart = -1;
    while (index < end) {
      const next = nextTokenEnd(sql, index);
      if (next <= index) break;
      const whitespace = next === index + 1 && /\s/.test(sql[index]);
      if (!whitespace && next === end) tokenStart = index;
      index = next;
    }
    if (tokenStart < 0) break;
    const token = sql.slice(tokenStart, end);
    if (!/^[=<>!+\-*/|&]+$/.test(token)) break;
    end = tokenStart;
    while (end > 0 && /\s/.test(sql[end - 1])) end -= 1;
  }

  return end;
}

function largestParseablePrefix(sql: string, errorAt: number, settings: FormatterSettings): number {
  const ends = boundaryEnds(sql, errorAt);
  let tried = 0;
  for (let index = ends.length - 1; index >= 0 && tried < 24; index -= 1) {
    tried += 1;
    const end = ends[index];
    if (end <= 0) continue;
    if (attemptPiece(sql.slice(0, end), settings).ok) return end;
  }
  return 0;
}

function boundaryEnds(sql: string, limit: number): number[] {
  const ends: number[] = [];
  let index = 0;

  while (index < limit) {
    const end = nextTokenEnd(sql, index);
    if (end <= index) break;
    const whitespace = end === index + 1 && /\s/.test(sql[index]);
    if (!whitespace) {
      if (end > limit) break;
      ends.push(end);
    }
    if (end > limit) break;
    index = end;
  }

  return ends;
}

function consumeBroken(sql: string, errorAt: number): number {
  let index = 0;
  let end = 0;

  while (index < sql.length) {
    const next = nextTokenEnd(sql, index);
    if (next <= index) return end;
    const whitespace = next === index + 1 && /\s/.test(sql[index]);
    if (!whitespace) end = next;
    if (next > errorAt && end > 0) return end;
    index = next;
  }

  return end;
}

function nextTokenEnd(sql: string, index: number): number {
  const skipped = skipLiteral(sql, index);
  if (skipped > index) return skipped;
  if (index >= sql.length) return index;
  if (/\s/.test(sql[index])) return index + 1;
  if (/[A-Za-z0-9_$#]/.test(sql[index])) {
    const word = /^[A-Za-z0-9_$#]+/.exec(sql.slice(index));
    return index + (word?.[0].length ?? 1);
  }
  const two = sql.slice(index, index + 2);
  if (two === "!=" || two === "<>" || two === "<=" || two === ">=" || two === "||" || two === ":=") {
    return index + 2;
  }
  return index + 1;
}

function parseErrorIndex(error: unknown, sql: string): number | null {
  if (!(error instanceof Error)) return null;
  const start = /"start"\s*:\s*(\d+)/.exec(error.message);
  if (start) {
    const index = Number(start[1]);
    if (index >= 0 && index <= sql.length) return index;
  }

  const lineCol = /line (\d+) column (\d+)/i.exec(error.message);
  if (!lineCol) return null;
  const line = Number(lineCol[1]);
  const column = Number(lineCol[2]);
  let current = 1;
  let index = 0;
  while (index < sql.length && current < line) {
    if (sql[index] === "\n") current += 1;
    index += 1;
  }
  return Math.min(sql.length, index + Math.max(0, column - 1));
}

function joinParts(head: string, tail: string): string {
  if (!head) return tail;
  if (!tail) return head;
  if (/^[ \t]*[^\s\w]/.test(tail)) {
    const base = head.replace(/[ \t]*$/, "").replace(/\n$/, "");
    const gap = /^[ \t]/.test(tail) ? "" : " ";
    return `${base}${gap}${tail.replace(/^[ \t]+/, " ")}`;
  }
  const left = head.replace(/[ \t]+$/, "").replace(/\n+$/, "\n");
  const right = tail.replace(/^\n+/, "");
  return left.endsWith("\n") ? `${left}${right}` : `${left}\n${right}`;
}

function polish(sql: string, settings: FormatterSettings): string {
  const cased = applyExtraOracleWords(sql, settings.letterCase);
  const collapsed = collapseSimpleParenGroups(collapseParenOrs(cased));
  const indented = indentInlineViews(collapsed, settings.tabWidth);
  const packed = packClauseLists(indented, settings.clauseItemsPerLine);
  const selected = formatSelectColumns(packed, settings.selectItemsPerLine);
  return packFromLists(selected, settings.fromItemsPerLine);
}

/** 블록 주석 안의 줄바꿈을 없애 한 줄로 붙인다. 문자열 안의 주석 모양은 그대로 둔다. */
function collapseBlockComments(sql: string): string {
  let out = "";
  let index = 0;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      const chunk = sql.slice(index, skipped);
      out += sql.startsWith("/*", index) ? chunk.replace(/\s+/g, " ") : chunk;
      index = skipped;
      continue;
    }

    out += sql[index];
    index += 1;
  }

  return out;
}

/** sql-formatter PL/SQL 토크나이저는 JDBC 자리표시 ? 를 모른다. 바인드로 바꿨다가 결과를 되돌린다. */
function maskQuestionMarks(sql: string): { sql: string; count: number } {
  let out = "";
  let index = 0;
  let count = 0;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      out += sql.slice(index, skipped);
      index = skipped;
      continue;
    }
    if (sql[index] === "?") {
      count += 1;
      out += `:sqlfmt_param_${count}`;
      index += 1;
      continue;
    }
    out += sql[index];
    index += 1;
  }

  return { sql: out, count };
}

function restoreQuestionMarks(sql: string, count: number): string {
  let out = sql;
  for (let number = 1; number <= count; number += 1) {
    out = out.replace(new RegExp(`:sqlfmt_param_${number}\\b`, "gi"), "?");
  }
  return out;
}

function collapseParenOrs(sql: string): string {
  let current = sql;

  for (let pass = 0; pass < 30; pass += 1) {
    const groups = parenGroups(current);
    const inners = groups.filter((group) => !groups.some((other) => other.open > group.open && other.close < group.close));
    const ordered = [...inners].sort((a, b) => b.open - a.open);
    let changed = false;

    for (const group of ordered) {
      const inner = current.slice(group.open + 1, group.close);
      const next = collapseLineStartOrs(inner);
      if (next === inner) continue;
      current = current.slice(0, group.open + 1) + next + current.slice(group.close);
      changed = true;
      break;
    }

    if (!changed) break;
  }

  return current;
}

function collapseSimpleParenGroups(sql: string): string {
  let current = sql;

  for (let pass = 0; pass < 40; pass += 1) {
    const groups = parenGroups(current);
    const inners = groups.filter((group) => !groups.some((other) => other.open > group.open && other.close < group.close));
    const ordered = [...inners].sort((a, b) => b.open - a.open);
    let changed = false;

    for (const group of ordered) {
      const inner = current.slice(group.open + 1, group.close);
      if (!shouldFlattenParen(inner)) continue;
      const flat = `(${tightenParenSpacing(flattenSqlWhitespace(inner))})`;
      const previous = current.slice(group.open, group.close + 1);
      if (flat === previous) continue;
      current = current.slice(0, group.open) + flat + current.slice(group.close + 1);
      changed = true;
      break;
    }

    if (!changed) break;
  }

  return current;
}

function shouldFlattenParen(inner: string): boolean {
  if (!inner.includes("\n")) return false;
  if (containsKeyword(inner, "SELECT") || containsKeyword(inner, "CASE")) return false;
  if (hasLineStartKeyword(inner, "AND")) return false;
  return true;
}

function collapseLineStartOrs(inner: string): string {
  if (!hasLineStartKeyword(inner, "OR") || hasLineStartKeyword(inner, "AND")) return inner;

  let out = "";
  let index = 0;
  let depth = 0;
  let atLineStart = true;

  while (index < inner.length) {
    const skipped = skipLiteral(inner, index);
    if (skipped > index) {
      out += inner.slice(index, skipped);
      atLineStart = false;
      index = skipped;
      continue;
    }

    const char = inner[index];
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;

    if (char === "\n") {
      atLineStart = true;
      out += char;
      index += 1;
      continue;
    }

    if (depth === 0 && atLineStart && /\s/.test(char)) {
      out += char;
      index += 1;
      continue;
    }

    if (depth === 0 && atLineStart && /^OR\b/i.test(inner.slice(index)) && /\S/.test(out)) {
      out = out.replace(/\s+$/, " ");
      out += inner.slice(index, index + 2);
      index += 2;
      atLineStart = false;
      continue;
    }

    atLineStart = false;
    out += char;
    index += 1;
  }

  return out;
}

function hasLineStartKeyword(sql: string, keyword: "AND" | "OR"): boolean {
  let index = 0;
  let depth = 0;
  let atLineStart = true;
  const pattern = new RegExp(`^${keyword}\\b`, "i");

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      atLineStart = false;
      index = skipped;
      continue;
    }

    const char = sql[index];
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;

    if (char === "\n") {
      atLineStart = true;
      index += 1;
      continue;
    }

    if (atLineStart && /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (depth === 0 && atLineStart && pattern.test(sql.slice(index))) return true;
    atLineStart = false;
    index += 1;
  }

  return false;
}

function parenGroups(sql: string): { open: number; close: number }[] {
  const groups: { open: number; close: number }[] = [];
  const stack: number[] = [];
  let index = 0;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }

    if (sql[index] === "(") stack.push(index);
    else if (sql[index] === ")" && stack.length > 0) {
      groups.push({ open: stack.pop() ?? index, close: index });
    }
    index += 1;
  }

  return groups;
}

function indentInlineViews(sql: string, tabWidth: number): string {
  const lines = sql.split("\n");
  const pad = " ".repeat(tabWidth);
  let index = 0;

  while (index < lines.length) {
    if (!/\(\s*$/.test(lines[index])) {
      index += 1;
      continue;
    }

    const close = findClosingLine(lines, index);
    const first = nextContentLine(lines, index + 1, close);
    if (close < 0 || first < 0 || !/^\s*(SELECT|WITH)\b/i.test(lines[first])) {
      index += 1;
      continue;
    }

    for (let line = index + 1; line < close; line += 1) {
      if (lines[line].trim()) lines[line] = pad + lines[line];
    }
    index += 1;
  }

  return lines.join("\n");
}

function findClosingLine(lines: string[], openLine: number): number {
  let depth = 1;

  for (let line = openLine + 1; line < lines.length; line += 1) {
    depth += parenDelta(lines[line]);
    if (depth <= 0) return line;
  }

  return -1;
}

function parenDelta(line: string): number {
  let delta = 0;
  let index = 0;

  while (index < line.length) {
    const skipped = skipLiteral(line, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }

    if (line[index] === "(") delta += 1;
    else if (line[index] === ")") delta -= 1;
    index += 1;
  }

  return delta;
}

function nextContentLine(lines: string[], start: number, end: number): number {
  for (let line = start; line < end; line += 1) {
    if (lines[line].trim()) return line;
  }
  return -1;
}

function packFromLists(sql: string, itemsPerLine: number): string {
  const clauses = fromStarts(sql);

  for (let cursor = clauses.length - 1; cursor >= 0; cursor -= 1) {
    const clause = clauses[cursor];
    const read = readFromItems(sql, clause.index + clause.keyword.length);
    if (read.items.length === 0) continue;

    const lineStart = sql.lastIndexOf("\n", clause.index - 1) + 1;
    const keywordColumn = clause.index - lineStart;
    const packed = packFromItems(keywordColumn, clause.keyword, read.items, itemsPerLine);
    sql = sql.slice(0, lineStart) + packed + sql.slice(read.end);
  }

  return sql;
}

function fromStarts(sql: string): { index: number; keyword: string }[] {
  const found: { index: number; keyword: string }[] = [];
  let index = 0;
  let atLineStart = true;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      atLineStart = sql.slice(index, skipped).endsWith("\n");
      index = skipped;
      continue;
    }

    const char = sql[index];
    if (char === "\n") {
      atLineStart = true;
      index += 1;
      continue;
    }

    if (atLineStart && /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (atLineStart && isKeywordAt(sql, index, "FROM")) found.push({ index, keyword: sql.slice(index, index + 4) });
    atLineStart = false;
    index += 1;
  }

  return found;
}

function readFromItems(sql: string, start: number): { items: { text: string; simple: boolean }[]; end: number } {
  let index = start;
  let depth = 0;
  let current = "";
  const items: { text: string; simple: boolean }[] = [];

  const push = () => {
    const trimmed = current.trim();
    if (!trimmed) {
      current = "";
      return;
    }
    const simple = !trimmed.includes("\n");
    items.push({ text: simple ? flattenSqlWhitespace(trimmed) : trimmed, simple });
    current = "";
  };

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
      if (depth === 0) break;
      depth -= 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ";" && depth === 0) break;
    if (char === "," && depth === 0) {
      push();
      index += 1;
      continue;
    }
    if (char === "\n" && depth === 0 && isNextClause(sql.slice(index + 1))) break;

    current += char;
    index += 1;
  }

  push();
  return { items, end: index };
}

function packFromItems(
  keywordColumn: number,
  keyword: string,
  items: { text: string; simple: boolean }[],
  perLine: number,
): string {
  const itemColumn = keywordColumn + keyword.length + 1;
  const size = Math.max(1, perLine);
  const lines: string[] = [];
  let bucket: string[] = [];

  const flush = (last: boolean) => {
    if (bucket.length === 0) return;
    const text = bucket.join(", ") + (last ? "" : ",");
    if (lines.length === 0) lines.push(`${" ".repeat(keywordColumn)}${keyword} ${text}`);
    else lines.push(`${" ".repeat(itemColumn)}${text}`);
    bucket = [];
  };

  items.forEach((item, index) => {
    const last = index === items.length - 1;
    if (!item.simple) {
      flush(false);
      const parts = item.text.split("\n");
      const head = `${lines.length === 0 ? `${" ".repeat(keywordColumn)}${keyword} ` : `${" ".repeat(itemColumn)}`}${parts[0].trim()}`;
      lines.push(head);
      for (const extra of parts.slice(1)) lines.push(extra.replace(/[ \t]+$/, ""));
      if (!last) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[ \t]+$/, "")},`;
      return;
    }

    bucket.push(item.text);
    if (bucket.length === size || last) flush(last);
  });

  return lines.join("\n");
}

function packClauseLists(sql: string, itemsPerLine: number): string {
  const clauses = clauseStarts(sql);

  for (let cursor = clauses.length - 1; cursor >= 0; cursor -= 1) {
    const clause = clauses[cursor];
    const read = readClauseItems(sql, clause.index + clause.keyword.length);
    if (read.items.length === 0) continue;

    const lineStart = sql.lastIndexOf("\n", clause.index - 1) + 1;
    const keywordColumn = clause.index - lineStart;
    const packed = packItems(keywordColumn, clause.keyword, read.items, itemsPerLine);
    sql = sql.slice(0, lineStart) + packed + sql.slice(read.end);
  }

  return sql;
}

function clauseStarts(sql: string): { index: number; keyword: string }[] {
  const found: { index: number; keyword: string }[] = [];
  let index = 0;
  let atLineStart = true;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      atLineStart = sql.slice(index, skipped).endsWith("\n");
      index = skipped;
      continue;
    }

    const char = sql[index];
    if (char === "\n") {
      atLineStart = true;
      index += 1;
      continue;
    }

    if (atLineStart && /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (atLineStart) {
      const match = /^(GROUP\s+BY|ORDER\s+BY)\b/i.exec(sql.slice(index));
      if (match) found.push({ index, keyword: match[0] });
    }
    atLineStart = false;
    index += 1;
  }

  return found;
}

function readClauseItems(sql: string, start: number): { items: string[]; end: number } {
  let index = start;
  let depth = 0;
  let current = "";
  const items: string[] = [];

  const push = () => {
    const item = flattenSqlWhitespace(current);
    if (item) items.push(item);
    current = "";
  };

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
      if (depth === 0) break;
      depth -= 1;
      current += char;
      index += 1;
      continue;
    }
    if (char === ";" && depth === 0) break;
    if (char === "," && depth === 0) {
      push();
      index += 1;
      continue;
    }
    if (char === "\n" && depth === 0 && isNextClause(sql.slice(index + 1))) break;

    current += char;
    index += 1;
  }

  push();
  return { items, end: index };
}

function isNextClause(afterNewline: string): boolean {
  return /^\s*(SELECT|FROM|WHERE|HAVING|GROUP\s+BY|ORDER\s+BY|UNION|MINUS|INTERSECT|CONNECT\s+BY|START\s+WITH|FETCH|OFFSET|LIMIT|WINDOW|WHEN|RETURNING|QUALIFY|UPDATE|INSERT|VALUES)\b/i.test(
    afterNewline,
  ) || /^\s*\)/.test(afterNewline);
}

function packItems(keywordColumn: number, keyword: string, items: string[], perLine: number): string {
  const itemColumn = keywordColumn + keyword.length + 1;
  const lines: string[] = [];
  const size = Math.max(1, perLine);

  for (let offset = 0; offset < items.length; offset += size) {
    const chunk = items.slice(offset, offset + size);
    const more = offset + size < items.length;
    const text = chunk.join(", ") + (more ? "," : "");
    if (offset === 0) lines.push(`${" ".repeat(keywordColumn)}${keyword} ${text}`);
    else lines.push(`${" ".repeat(itemColumn)}${text}`);
  }

  return lines.join("\n");
}

function formatSelectColumns(sql: string, perLine: number): string {
  const spans = findSelectLists(sql).sort((left, right) => right.start - left.start);

  for (const span of spans) {
    const next = reformatSelectList(sql.slice(span.start, span.end), lineColumn(sql, span.start), perLine);
    const delta = next.length - (span.end - span.start);
    sql = sql.slice(0, span.start) + next + sql.slice(span.end);
    for (const other of spans) {
      if (other.end > span.start) other.end += delta;
    }
  }

  return sql;
}

function findSelectLists(sql: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let index = 0;
  let depth = 0;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }

    if (sql[index] === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (sql[index] === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    if (isKeywordAt(sql, index, "SELECT")) {
      const listStart = skipSelectModifiers(sql, index + "SELECT".length);
      spans.push({ start: listStart, end: findSelectListEnd(sql, listStart, depth) });
      index = listStart;
      continue;
    }

    index += 1;
  }

  return spans;
}

function skipSelectModifiers(sql: string, index: number): number {
  let cursor = index;

  while (cursor < sql.length) {
    while (cursor < sql.length && /\s/.test(sql[cursor])) cursor += 1;
    const modifier = ["DISTINCT", "UNIQUE", "ALL"].find((word) => isKeywordAt(sql, cursor, word));
    if (!modifier) break;
    cursor += modifier.length;
  }

  return cursor;
}

function findSelectListEnd(sql: string, start: number, selectDepth: number): number {
  let index = start;
  let depth = selectDepth;

  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }

    if (sql[index] === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (sql[index] === ")") {
      if (depth === selectDepth) return index;
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    if (depth === selectDepth && isClauseStart(sql, index)) return index;

    index += 1;
  }

  return sql.length;
}

function isClauseStart(sql: string, index: number): boolean {
  const phrases = [
    ["FROM"],
    ["WHERE"],
    ["GROUP", "BY"],
    ["HAVING"],
    ["ORDER", "BY"],
    ["UNION"],
    ["MINUS"],
    ["INTERSECT"],
    ["INTO"],
    ["FETCH"],
    ["CONNECT", "BY"],
  ];

  return phrases.some((phrase) => matchesPhrase(sql, index, phrase));
}

function matchesPhrase(sql: string, index: number, phrase: string[]): boolean {
  let cursor = index;

  for (let wordIndex = 0; wordIndex < phrase.length; wordIndex += 1) {
    if (wordIndex > 0) {
      if (!/\s/.test(sql[cursor] ?? "")) return false;
      while (/\s/.test(sql[cursor] ?? "")) cursor += 1;
    }
    const word = phrase[wordIndex];
    if (!isKeywordAt(sql, cursor, word)) return false;
    cursor += word.length;
  }

  return true;
}

type SelectPiece = { kind: "plain" | "block"; text: string };

function reformatSelectList(list: string, startColumn: number, perLine: number): string {
  const parts = splitCommaItems(list);
  const pieces: SelectPiece[] = [];
  let trailing = "";

  parts.forEach((item, index) => {
    const lead = item.match(/^\s*/)?.[0] ?? "";
    const trail = item.match(/\s*$/)?.[0] ?? "";
    const bodyEnd = Math.max(lead.length, item.length - trail.length);
    const body = item.slice(lead.length, bodyEnd);
    if (index === parts.length - 1) trailing = trail;
    if (!body) return;

    if (containsKeyword(body, "CASE")) {
      const prepared = containsKeyword(body, "SELECT") ? compactSubqueryCalls(body) : flattenSqlWhitespace(body);
      pieces.push({ kind: "block", text: expandCases(prepared, startColumn) });
      return;
    }

    if (containsKeyword(body, "SELECT")) {
      pieces.push({ kind: "block", text: body });
      return;
    }

    pieces.push({ kind: "plain", text: tightenParenSpacing(flattenSqlWhitespace(body)) });
  });

  const rows: string[][] = [];
  let bucket: string[] = [];
  const size = Math.max(1, perLine);
  const flush = () => {
    if (bucket.length === 0) return;
    rows.push(bucket);
    bucket = [];
  };

  for (const piece of pieces) {
    if (piece.kind === "block") {
      flush();
      rows.push([piece.text]);
      continue;
    }
    bucket.push(piece.text);
    if (bucket.length >= size) flush();
  }
  flush();

  const rendered = rows.map((row, rowIndex) => {
    const [first, ...rest] = row.join(", ").split("\n");
    const head = rowIndex === 0 ? first : `${" ".repeat(startColumn)}${first}`;
    return [head, ...rest].join("\n");
  });

  return rendered.join(",\n") + trailing;
}

function splitCommaItems(text: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let index = 0;

  while (index < text.length) {
    const skipped = skipLiteral(text, index);
    if (skipped > index) {
      current += text.slice(index, skipped);
      index = skipped;
      continue;
    }

    if (text[index] === "(") depth += 1;
    else if (text[index] === ")" && depth > 0) depth -= 1;
    else if (text[index] === "," && depth === 0) {
      items.push(current);
      current = "";
      index += 1;
      continue;
    }

    current += text[index];
    index += 1;
  }

  items.push(current);
  return items;
}

function expandCases(text: string, startColumn: number): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const skipped = skipLiteral(text, index);
    if (skipped > index) {
      out += text.slice(index, skipped);
      index = skipped;
      continue;
    }

    if (isKeywordAt(text, index, "CASE")) {
      const parsed = parseCase(text, index);
      if (!parsed || parsed.whens.length === 0) {
        out += text[index];
        index += 1;
        continue;
      }
      out += renderCase(parsed, currentColumn(out, startColumn));
      index = parsed.end;
      continue;
    }

    out += text[index];
    index += 1;
  }

  return out;
}

type CaseWhen = { whenKw: string; cond: string; thenKw: string; result: string };
type ParsedCase = {
  caseKeyword: string;
  endKeyword: string;
  operand: string;
  whens: CaseWhen[];
  elseKw: string;
  elseResult: string;
  end: number;
};

function parseCase(text: string, caseIndex: number): ParsedCase | null {
  let index = caseIndex + "CASE".length;
  let paren = 0;
  let caseDepth = 1;
  let endIndex = -1;

  while (index < text.length) {
    const skipped = skipLiteral(text, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }

    if (text[index] === "(") paren += 1;
    else if (text[index] === ")" && paren > 0) paren -= 1;
    else if (paren === 0 && isKeywordAt(text, index, "CASE")) {
      caseDepth += 1;
      index += "CASE".length;
      continue;
    } else if (paren === 0 && isKeywordAt(text, index, "END")) {
      caseDepth -= 1;
      if (caseDepth === 0) {
        endIndex = index;
        break;
      }
      index += "END".length;
      continue;
    }

    index += 1;
  }

  if (endIndex < 0) return null;

  const body = splitCaseBody(text.slice(caseIndex + "CASE".length, endIndex));
  return {
    caseKeyword: text.slice(caseIndex, caseIndex + "CASE".length),
    endKeyword: text.slice(endIndex, endIndex + "END".length),
    operand: body.operand,
    whens: body.whens,
    elseKw: body.elseKw,
    elseResult: body.elseResult,
    end: endIndex + "END".length,
  };
}

function splitCaseBody(body: string): { operand: string; whens: CaseWhen[]; elseKw: string; elseResult: string } {
  let index = 0;
  let paren = 0;
  let caseDepth = 0;
  let operand = "";
  let elseKw = "";
  let elseResult = "";
  let mode: "operand" | "cond" | "result" | "else" = "operand";
  let current: CaseWhen | null = null;
  const whens: CaseWhen[] = [];

  const append = (chunk: string) => {
    if (mode === "operand") operand += chunk;
    else if (mode === "cond" && current) current.cond += chunk;
    else if (mode === "result" && current) current.result += chunk;
    else elseResult += chunk;
  };

  while (index < body.length) {
    const skipped = skipLiteral(body, index);
    if (skipped > index) {
      append(body.slice(index, skipped));
      index = skipped;
      continue;
    }

    if (body[index] === "(") {
      paren += 1;
      append(body[index]);
      index += 1;
      continue;
    }
    if (body[index] === ")" && paren > 0) {
      paren -= 1;
      append(body[index]);
      index += 1;
      continue;
    }
    if (paren === 0 && isKeywordAt(body, index, "CASE")) {
      caseDepth += 1;
      append(body.slice(index, index + "CASE".length));
      index += "CASE".length;
      continue;
    }
    if (paren === 0 && caseDepth > 0 && isKeywordAt(body, index, "END")) {
      caseDepth -= 1;
      append(body.slice(index, index + "END".length));
      index += "END".length;
      continue;
    }
    if (paren === 0 && caseDepth === 0 && isKeywordAt(body, index, "WHEN")) {
      if (current) whens.push(current);
      current = { whenKw: body.slice(index, index + "WHEN".length), cond: "", thenKw: "THEN", result: "" };
      mode = "cond";
      index += "WHEN".length;
      continue;
    }
    if (paren === 0 && caseDepth === 0 && mode === "cond" && isKeywordAt(body, index, "THEN")) {
      if (current) current.thenKw = body.slice(index, index + "THEN".length);
      mode = "result";
      index += "THEN".length;
      continue;
    }
    if (paren === 0 && caseDepth === 0 && isKeywordAt(body, index, "ELSE")) {
      if (current) {
        whens.push(current);
        current = null;
      }
      elseKw = body.slice(index, index + "ELSE".length);
      mode = "else";
      index += "ELSE".length;
      continue;
    }

    append(body[index]);
    index += 1;
  }

  if (current) whens.push(current);
  return { operand: operand.trim(), whens, elseKw, elseResult: elseResult.trim() };
}

function renderCase(parsed: ParsedCase, caseColumn: number): string {
  const operand = parsed.operand ? ` ${flattenSqlWhitespace(parsed.operand)}` : "";
  const beforeWhen = `${parsed.caseKeyword}${operand} `;
  const whenColumn = caseColumn + beforeWhen.length;
  const whenPad = " ".repeat(whenColumn);
  const lines: string[] = [];

  parsed.whens.forEach((when, index) => {
    const cond = layoutCasePart(when.cond, index === 0 ? caseColumn + beforeWhen.length + when.whenKw.length + 1 : whenColumn + when.whenKw.length + 1);
    const stem = `${index === 0 ? beforeWhen : whenPad}${when.whenKw} ${cond} ${when.thenKw} `;
    const resultColumn = currentColumn(stem, index === 0 ? caseColumn : 0);
    const result = layoutCasePart(when.result, resultColumn);
    lines.push(`${stem}${result}`);
  });

  if (parsed.elseKw) {
    const stem = `${whenPad}${parsed.elseKw} `;
    const result = layoutCasePart(parsed.elseResult, stem.length);
    lines.push(`${stem}${result}`);
  }

  if (lines.length > 0 && lines[lines.length - 1].includes("\n")) {
    lines[lines.length - 1] += ` ${parsed.endKeyword}`;
  } else {
    lines.push(`${" ".repeat(caseColumn)}${parsed.endKeyword}`);
  }
  return lines.join("\n");
}

function layoutCasePart(text: string, column: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.includes("\n") || containsKeyword(trimmed, "SELECT")) return trimmed;
  return expandCases(flattenSqlWhitespace(trimmed), column);
}

/** DECODE( (SELECT ...), 1, 'Y', 'N' )처럼 서브쿼리와 짧은 인자가 섞이면 짧은 인자를 서브쿼리 끝에 붙인다. */
function compactSubqueryCalls(sql: string): string {
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
    const name = !/[A-Za-z0-9_$#]/.test(previous) ? /^[A-Za-z][A-Za-z0-9_$#]*/.exec(sql.slice(index))?.[0] : undefined;
    if (name) {
      const open = skipSpaces(sql, index + name.length);
      if (sql[open] === "(") {
        const close = findMatchingParen(sql, open);
        const inner = sql.slice(open + 1, close);
        const rendered = renderMixedCall(inner);
        if (rendered) {
          out += name + rendered;
          index = close + 1;
          continue;
        }
      }
    }

    out += sql[index];
    index += 1;
  }

  return out;
}

function renderMixedCall(inner: string): string | null {
  const args = splitCommaItems(inner).map((item) => item.trim()).filter(Boolean);
  if (args.length < 2 || !args.some((arg) => containsKeyword(arg, "SELECT"))) return null;

  const lead: string[] = [];
  let cursor = 0;
  while (cursor < args.length && !containsKeyword(args[cursor], "SELECT")) {
    lead.push(flattenSqlWhitespace(args[cursor]));
    cursor += 1;
  }

  let body = "(";
  if (lead.length) body += `${lead.join(",")},`;
  while (cursor < args.length) {
    const trailing: string[] = [];
    let next = cursor + 1;
    while (next < args.length && !containsKeyword(args[next], "SELECT")) {
      trailing.push(flattenSqlWhitespace(args[next]));
      next += 1;
    }
    body += formatSubqueryArgument(args[cursor], trailing);
    cursor = next;
  }

  const selectIndent = /\n([ \t]*)SELECT\b/i.exec(body)?.[1] ?? "";
  return `${body}\n${selectIndent})`;
}

function formatSubqueryArgument(arg: string, trailing: string[]): string {
  const wrapped = unwrapParens(arg.trim());
  let inner = (wrapped ?? arg.trim()).replace(/\s+$/, "");
  if (!inner.startsWith("\n")) inner = `\n${inner}`;
  const tail = trailing.length ? `,${trailing.join(",")}` : "";
  return ` (${inner} )${tail}`;
}

function unwrapParens(text: string): string | null {
  if (!text.startsWith("(")) return null;
  const close = findMatchingParen(text, 0);
  if (close !== text.length - 1) return null;
  return text.slice(1, close);
}

function skipSpaces(sql: string, index: number): number {
  let cursor = index;
  while (cursor < sql.length && /[ \t\r\n]/.test(sql[cursor])) cursor += 1;
  return cursor;
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

function containsKeyword(sql: string, word: string): boolean {
  let index = 0;
  while (index < sql.length) {
    const skipped = skipLiteral(sql, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (isKeywordAt(sql, index, word)) return true;
    index += 1;
  }
  return false;
}

function isKeywordAt(sql: string, index: number, word: string): boolean {
  if (sql.slice(index, index + word.length).toUpperCase() !== word) return false;
  const before = index > 0 ? sql[index - 1] : "";
  const after = sql[index + word.length] ?? "";
  return !/[A-Za-z0-9_$#]/.test(before) && !/[A-Za-z0-9_$#]/.test(after);
}

function lineColumn(sql: string, index: number): number {
  const newline = sql.lastIndexOf("\n", index - 1);
  return index - newline - 1;
}

function currentColumn(text: string, startColumn: number): number {
  const newline = text.lastIndexOf("\n");
  if (newline < 0) return startColumn + text.length;
  return text.length - newline - 1;
}

function tightenParenSpacing(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const skipped = skipLiteral(text, index);
    if (skipped > index) {
      out += text.slice(index, skipped);
      index = skipped;
      continue;
    }

    if (text[index] === "(") {
      out += "(";
      index += 1;
      while (text[index] === " ") index += 1;
      continue;
    }

    if (text[index] === ")") {
      while (out.endsWith(" ")) out = out.slice(0, -1);
      out += ")";
      index += 1;
      continue;
    }

    out += text[index];
    index += 1;
  }

  return out;
}

function flattenSqlWhitespace(text: string): string {
  let out = "";
  let index = 0;
  let pendingSpace = false;

  while (index < text.length) {
    const skipped = skipLiteral(text, index);
    if (skipped > index) {
      if (pendingSpace && out.length > 0) out += " ";
      pendingSpace = false;
      out += text.slice(index, skipped);
      index = skipped;
      continue;
    }

    if (/\s/.test(text[index])) {
      pendingSpace = true;
      index += 1;
      continue;
    }

    if (pendingSpace && out.length > 0) out += " ";
    pendingSpace = false;
    out += text[index];
    index += 1;
  }

  return out.trim();
}

function applyExtraOracleWords(sql: string, keywordCase: KeywordCase): string {
  if (keywordCase === "preserve") return sql;

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
    if (/[A-Za-z]/.test(sql[index])) {
      const word = /^[A-Za-z][A-Za-z0-9_$#]*/.exec(sql.slice(index))?.[0] ?? sql[index];
      const bound = previous === ":" || previous === "&";
      if (!bound && extraOracleWords.has(word.toUpperCase())) {
        out += keywordCase === "upper" ? word.toUpperCase() : word.toLowerCase();
      } else {
        out += word;
      }
      index += word.length;
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
  if ((sql[index] === "n" || sql[index] === "N") && sql[index + 1] === "'") {
    return skipQuote(sql, index + 1, "'");
  }
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
