import type { LetterCase } from "@/lib/formatSql";

type Token = { kind: "word" | "punct" | "other"; text: string };

const RESERVED = new Set([
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
  "WITH",
  "AS",
  "ON",
  "USING",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "NATURAL",
  "AND",
  "OR",
  "PIVOT",
  "UNPIVOT",
  "LATERAL",
  "CONNECT",
  "START",
  "SET",
  "VALUES",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
]);

export const SKELETON_INDENT = 8;

/** 컬럼·조건은 빼고 SELECT/FROM/WHERE 같은 뼈대와 테이블 이름만 남긴다. */
export function skeletonSql(sql: string, letterCase: LetterCase = "upper"): string {
  const parser = new SkeletonParser(tokenize(sql), letterCase);
  return parser.parse().replace(/[ \t]+\n/g, "\n").trim();
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      tokens.push({ kind: "other", text: "''" });
      continue;
    }
    if (char === '"') {
      const end = sql.indexOf('"', index + 1);
      const text = sql.slice(index + 1, end === -1 ? sql.length : end);
      index = end === -1 ? sql.length : end + 1;
      tokens.push({ kind: "word", text });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(sql.slice(index))?.[0] ?? char;
      index += word.length;
      tokens.push({ kind: "word", text: word });
      continue;
    }
    if (char === "(" || char === ")" || char === "," || char === ";" || char === ".") {
      tokens.push({ kind: "punct", text: char });
      index += 1;
      continue;
    }
    tokens.push({ kind: "other", text: char });
    index += 1;
  }

  return tokens;
}

class SkeletonParser {
  private index = 0;
  private readonly lines: string[] = [];

  constructor(
    private readonly tokens: Token[],
    private readonly letterCase: LetterCase,
  ) {}

  parse(): string {
    while (this.index < this.tokens.length) {
      if (this.word() === "WITH") this.parseWith(0);
      else if (this.word() === "SELECT" || this.opensQuery(this.index)) this.parseQuery(0);
      else this.index += 1;
    }
    return this.lines.join("\n");
  }

  private parseWith(depth: number) {
    this.index += 1;
    let first = true;

    while (this.index < this.tokens.length) {
      const name = this.tokens[this.index];
      if (!name || name.kind !== "word" || RESERVED.has(name.text.toUpperCase())) break;
      this.index += 1;
      if (this.tokens[this.index]?.text === "(" && !this.opensQuery(this.index)) this.skipBalanced();
      if (this.word() === "AS") this.index += 1;
      if (this.tokens[this.index]?.text !== "(") break;
      this.index += 1;
      this.lines.push(first ? `WITH ${this.show(name.text)} AS (` : `${this.show(name.text)} AS (`);
      first = false;
      this.parseQuery(depth + 1);
      if (this.tokens[this.index]?.text === ")") this.index += 1;
      this.lines.push(`${this.indent(depth)})`);
      if (this.tokens[this.index]?.text === ",") {
        this.commaLast();
        this.index += 1;
        continue;
      }
      break;
    }

    this.parseQuery(depth);
  }

  private parseQuery(depth: number) {
    if (this.word() === "WITH") {
      this.parseWith(depth);
      return;
    }

    while (this.index < this.tokens.length) {
      if (this.tokens[this.index].text === ")") return;
      const clause = this.clauseAt(this.index);
      if (!clause) {
        if (this.opensQuery(this.index)) {
          this.index += 1;
          this.parseQuery(depth);
          if (this.tokens[this.index]?.text === ")") this.index += 1;
          continue;
        }
        this.index += 1;
        continue;
      }

      if (clause.text === "SELECT") {
        this.lines.push(this.pad(depth, "SELECT"));
        this.index += clause.size;
        this.skipUntil(() => this.clauseAt(this.index) !== null);
        continue;
      }
      if (clause.text === "FROM") {
        this.index += clause.size;
        this.parseFrom(depth);
        continue;
      }
      if (
        clause.text === "WHERE" ||
        clause.text === "HAVING" ||
        clause.text === "GROUP BY" ||
        clause.text === "ORDER BY" ||
        clause.text === "CONNECT BY" ||
        clause.text === "START WITH"
      ) {
        this.lines.push(this.pad(depth, clause.text));
        this.index += clause.size;
        this.skipUntil(() => this.clauseAt(this.index) !== null);
        continue;
      }
      if (clause.text === "UNION" || clause.text === "UNION ALL" || clause.text === "MINUS" || clause.text === "INTERSECT") {
        this.lines.push(this.pad(depth, clause.text));
        this.index += clause.size;
        continue;
      }
      this.index += clause.size;
    }
  }

  private parseFrom(depth: number) {
    const fromLine = this.pad(depth, "FROM");
    this.lines.push(fromLine);
    let started = false;
    let itemColumn = fromLine.length + 1;

    const placeTable = (name: string) => {
      const shown = this.show(name);
      if (!started) {
        this.lines[this.lines.length - 1] += ` ${shown}`;
        itemColumn = this.lines[this.lines.length - 1].length - shown.length;
        started = true;
        return;
      }
      this.lines.push(`${" ".repeat(itemColumn)}${shown}`);
    };

    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      if (token.text === ")" || token.text === ";") return;
      if (this.clauseAt(this.index)) return;
      if (token.text === ",") {
        this.commaLast();
        this.index += 1;
        continue;
      }

      const join = this.matchJoin(this.index);
      if (join) {
        this.index = join.next;
        const base = this.pad(depth, join.text);
        if (this.opensQuery(this.index)) {
          this.lines.push(`${base} (`);
          const parenColumn = this.lines[this.lines.length - 1].length - 1;
          this.index += 1;
          this.parseQuery(depth + 1);
          if (this.tokens[this.index]?.text === ")") this.index += 1;
          this.skipAlias();
          this.lines.push(`${" ".repeat(parenColumn)})`);
          itemColumn = parenColumn;
        } else {
          const table = this.readTable();
          this.lines.push(table ? `${base} ${this.show(table.name)}` : base);
          if (table) this.index = table.next;
          itemColumn = base.length + 1;
        }
        started = true;
        if (this.word() === "ON" || this.word() === "USING") {
          this.index += 1;
          this.skipUntil(() => this.clauseAt(this.index) !== null || this.matchJoin(this.index) !== null || this.tokens[this.index]?.text === ",");
        }
        continue;
      }

      if (this.opensQuery(this.index)) {
        if (!started) this.lines[this.lines.length - 1] += " (";
        else this.lines.push(`${" ".repeat(itemColumn)}(`);
        const parenColumn = this.lines[this.lines.length - 1].length - 1;
        this.index += 1;
        this.parseQuery(depth + 1);
        if (this.tokens[this.index]?.text === ")") this.index += 1;
        this.skipAlias();
        this.lines.push(`${" ".repeat(parenColumn)})`);
        itemColumn = parenColumn;
        started = true;
        continue;
      }

      if (this.word() === "PIVOT" || this.word() === "UNPIVOT" || this.word() === "LATERAL") {
        this.index += 1;
        if (this.tokens[this.index]?.text === "(") this.skipBalanced();
        continue;
      }

      const table = this.readTable();
      if (table) {
        placeTable(table.name);
        this.index = table.next;
        continue;
      }
      if (token.text === "(") {
        this.skipBalanced();
        continue;
      }
      this.index += 1;
    }
  }

  private skipUntil(stop: () => boolean) {
    let depth = 0;
    while (this.index < this.tokens.length) {
      const text = this.tokens[this.index].text;
      if (depth === 0 && (text === ")" || text === ";" || stop())) return;
      if (text === "(") {
        depth += 1;
        this.index += 1;
        continue;
      }
      if (text === ")") {
        depth -= 1;
        this.index += 1;
        continue;
      }
      this.index += 1;
    }
  }

  private skipBalanced() {
    if (this.tokens[this.index]?.text !== "(") return;
    let depth = 0;
    while (this.index < this.tokens.length) {
      const text = this.tokens[this.index].text;
      if (text === "(") depth += 1;
      if (text === ")") {
        depth -= 1;
        this.index += 1;
        if (depth === 0) return;
        continue;
      }
      this.index += 1;
    }
  }

  private skipAlias() {
    if (this.word() === "AS") this.index += 1;
    const alias = this.word();
    if (alias && !RESERVED.has(alias)) this.index += 1;
  }

  private readTable(): { name: string; next: number } | null {
    const token = this.tokens[this.index];
    if (!token || token.kind !== "word" || RESERVED.has(token.text.toUpperCase())) return null;
    let name = token.text;
    let next = this.index + 1;
    if (this.tokens[next]?.text === "." && this.tokens[next + 1]?.kind === "word") {
      name += `.${this.tokens[next + 1].text}`;
      next += 2;
    }
    if (this.tokens[next]?.kind === "word" && this.tokens[next].text.toUpperCase() === "AS") next += 1;
    const alias = this.tokens[next];
    if (alias?.kind === "word" && !RESERVED.has(alias.text.toUpperCase())) next += 1;
    return { name, next };
  }

  private matchJoin(index: number): { text: string; next: number } | null {
    const allowed = new Set(["NATURAL", "INNER", "CROSS", "LEFT", "RIGHT", "FULL", "OUTER", "JOIN"]);
    const parts: string[] = [];
    let cursor = index;
    while (cursor < this.tokens.length) {
      const word = this.tokens[cursor]?.kind === "word" ? this.tokens[cursor].text.toUpperCase() : "";
      if (!allowed.has(word)) break;
      parts.push(word);
      cursor += 1;
      if (word === "JOIN") return { text: parts.join(" "), next: cursor };
    }
    return null;
  }

  private opensQuery(index: number): boolean {
    if (this.tokens[index]?.text !== "(") return false;
    let cursor = index + 1;
    while (this.tokens[cursor]?.text === "(") cursor += 1;
    const word = this.tokens[cursor]?.kind === "word" ? this.tokens[cursor].text.toUpperCase() : "";
    return word === "SELECT" || word === "WITH";
  }

  private clauseAt(index: number): { text: string; size: number } | null {
    const word = this.tokens[index]?.kind === "word" ? this.tokens[index].text.toUpperCase() : "";
    const next = this.tokens[index + 1]?.kind === "word" ? this.tokens[index + 1].text.toUpperCase() : "";
    if (!word) return null;
    if (word === "GROUP" && next === "BY") return { text: "GROUP BY", size: 2 };
    if (word === "ORDER" && next === "BY") return { text: "ORDER BY", size: 2 };
    if (word === "UNION" && next === "ALL") return { text: "UNION ALL", size: 2 };
    if (word === "CONNECT" && next === "BY") return { text: "CONNECT BY", size: 2 };
    if (word === "START" && next === "WITH") return { text: "START WITH", size: 2 };
    if (["SELECT", "FROM", "WHERE", "HAVING", "UNION", "MINUS", "INTERSECT"].includes(word)) {
      return { text: word, size: 1 };
    }
    return null;
  }

  private word(): string {
    const token = this.tokens[this.index];
    return token?.kind === "word" ? token.text.toUpperCase() : "";
  }

  private commaLast() {
    if (this.lines.length === 0) return;
    this.lines[this.lines.length - 1] = `${this.lines[this.lines.length - 1].replace(/\s+$/, "")},`;
  }

  private indent(depth: number): string {
    return " ".repeat(Math.max(0, depth) * SKELETON_INDENT);
  }

  private pad(depth: number, keyword: string): string {
    return `${this.indent(depth)}${this.show(keyword)}`;
  }

  private show(text: string): string {
    if (this.letterCase === "lower") return text.toLowerCase();
    if (this.letterCase === "preserve") return text;
    return text.toUpperCase();
  }
}
