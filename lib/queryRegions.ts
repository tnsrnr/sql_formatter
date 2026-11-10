/** 정렬된 쿼리에서 서브쿼리가 시작되는 괄호만 깊이로 센다. */
export function queryRegionDepths(sql: string): number[] {
  const events = queryParenEvents(sql);
  const lines = sql.split("\n");
  const depths: number[] = [];
  let cursor = 0;
  let depth = 0;
  let eventIndex = 0;

  for (const line of lines) {
    const end = cursor + line.length;
    let display = depth;
    let leading = true;
    let mark = cursor;
    while (eventIndex < events.length && events[eventIndex].index < end) {
      const event = events[eventIndex];
      eventIndex += 1;
      if (event.kind === "close" && leading && onlyNoise(sql, mark, event.index)) {
        depth = Math.max(0, depth - 1);
        display = depth;
        mark = event.index + 1;
        continue;
      }
      if (leading) {
        display = depth;
        leading = false;
      }
      if (event.kind === "close") depth = Math.max(0, depth - 1);
      else depth += 1;
    }
    depths.push(display);
    cursor = end + 1;
  }

  return depths;
}

type ParenEvent = { index: number; kind: "open" | "close" };

function queryParenEvents(sql: string): ParenEvent[] {
  const events: ParenEvent[] = [];
  const stack: boolean[] = [];
  let index = 0;

  while (index < sql.length) {
    const next = skipNoise(sql, index);
    if (next !== index) {
      index = next;
      continue;
    }
    const char = sql[index];
    if (char === "(") {
      const query = opensQuery(sql, index + 1);
      stack.push(query);
      if (query) events.push({ index, kind: "open" });
      index += 1;
      continue;
    }
    if (char === ")") {
      if (stack.pop()) events.push({ index, kind: "close" });
      index += 1;
      continue;
    }
    index += 1;
  }

  return events;
}

function onlyNoise(sql: string, from: number, to: number): boolean {
  let cursor = from;
  while (cursor < to) {
    const next = skipNoise(sql, cursor);
    if (next === cursor) return false;
    cursor = next;
  }
  return true;
}

function opensQuery(sql: string, index: number): boolean {
  let cursor = index;
  while (cursor < sql.length) {
    const next = skipNoise(sql, cursor);
    if (next === cursor) break;
    cursor = next;
  }
  return /^select\b/i.test(sql.slice(cursor)) || /^with\b/i.test(sql.slice(cursor));
}

function skipNoise(sql: string, index: number): number {
  if (sql.startsWith("--", index)) {
    const end = sql.indexOf("\n", index);
    return end === -1 ? sql.length : end;
  }
  if (sql.startsWith("/*", index)) {
    const end = sql.indexOf("*/", index + 2);
    return end === -1 ? sql.length : end + 2;
  }
  if (/\s/.test(sql[index] ?? "")) return index + 1;

  const quoted = qQuoteEnd(sql, index);
  if (quoted !== null) return quoted;
  if ((sql[index] === "n" || sql[index] === "N") && sql[index + 1] === "'") return skipQuote(sql, index + 1);
  if (sql[index] === "'") return skipQuote(sql, index);
  if (sql[index] === '"') return skipQuote(sql, index);
  return index;
}

function skipQuote(sql: string, index: number): number {
  const quote = sql[index];
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

function qQuoteEnd(sql: string, index: number): number | null {
  if (index > 0 && /[A-Za-z0-9_$#]/.test(sql[index - 1])) return null;
  let cursor = index;
  if (sql[cursor] === "n" || sql[cursor] === "N") {
    if (sql[cursor + 1] !== "q" && sql[cursor + 1] !== "Q") return null;
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
