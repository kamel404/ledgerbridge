/**
 * A deliberately small SuiteQL parser (SPEC §7.3). Supported grammar:
 *
 *   SELECT <columns | *> FROM <table>
 *   [WHERE <field> <op> <literal> [AND <field> <op> <literal> ...]]
 *   [ORDER BY <field> [ASC|DESC]]
 *
 *   op      = | != | <> | < | <= | > | >=
 *   literal 'text' (use '' for a quote inside) | 123 | -4.5
 *
 * Keywords are case-insensitive. Anything else (OR, JOIN, functions,
 * sub-queries, ...) is rejected with a SuiteQlSyntaxError.
 */

export type ComparisonOp = '=' | '!=' | '<' | '<=' | '>' | '>=';

export interface Condition {
  field: string;
  op: ComparisonOp;
  value: string | number;
}

export interface SuiteQlQuery {
  columns: '*' | string[];
  from: string;
  where: Condition[];
  orderBy?: { field: string; direction: 'ASC' | 'DESC' };
}

export class SuiteQlSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuiteQlSyntaxError';
  }
}

// ---------------------------------------------------------------------------
// Tokenizer: turns the text into a list of tokens
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'word'; text: string; pos: number }
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'op'; op: ComparisonOp; pos: number }
  | { kind: 'comma' | 'star' | 'end'; pos: number };

const KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'ORDER', 'BY', 'ASC', 'DESC']);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    const rest = input.slice(i);

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) {
      tokens.push({ kind: 'word', text: word[0], pos: i });
      i += word[0].length;
      continue;
    }

    const num = /^-?\d+(\.\d+)?/.exec(rest);
    if (num) {
      tokens.push({ kind: 'number', value: Number(num[0]), pos: i });
      i += num[0].length;
      continue;
    }

    if (ch === "'") {
      let value = '';
      let j = i + 1;
      for (;;) {
        if (j >= input.length) throw new SuiteQlSyntaxError(`Unterminated string starting at position ${i}`);
        if (input[j] === "'") {
          if (input[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          break;
        }
        value += input[j];
        j++;
      }
      tokens.push({ kind: 'string', value, pos: i });
      i = j + 1;
      continue;
    }

    const op = /^(<=|>=|!=|<>|=|<|>)/.exec(rest);
    if (op) {
      tokens.push({ kind: 'op', op: op[0] === '<>' ? '!=' : (op[0] as ComparisonOp), pos: i });
      i += op[0].length;
      continue;
    }

    if (ch === ',') {
      tokens.push({ kind: 'comma', pos: i });
      i++;
      continue;
    }
    if (ch === '*') {
      tokens.push({ kind: 'star', pos: i });
      i++;
      continue;
    }

    throw new SuiteQlSyntaxError(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ kind: 'end', pos: input.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser: reads the tokens in grammar order
// ---------------------------------------------------------------------------

export function parseSuiteQl(input: string): SuiteQlQuery {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;

  const isKeyword = (t: Token, kw: string): boolean => t.kind === 'word' && t.text.toUpperCase() === kw;

  const describe = (t: Token): string => {
    switch (t.kind) {
      case 'word':
        return `'${t.text}'`;
      case 'number':
        return String(t.value);
      case 'string':
        return `'${t.value}' (string)`;
      case 'op':
        return `'${t.op}'`;
      case 'comma':
        return "','";
      case 'star':
        return "'*'";
      case 'end':
        return 'end of query';
    }
  };

  const expectKeyword = (kw: string): void => {
    const t = next();
    if (!isKeyword(t, kw)) throw new SuiteQlSyntaxError(`Expected ${kw} but found ${describe(t)} at position ${t.pos}`);
  };

  const expectIdentifier = (what: string): string => {
    const t = next();
    if (t.kind !== 'word' || KEYWORDS.has(t.text.toUpperCase())) {
      throw new SuiteQlSyntaxError(`Expected ${what} but found ${describe(t)} at position ${t.pos}`);
    }
    return t.text;
  };

  // SELECT
  expectKeyword('SELECT');
  let columns: '*' | string[];
  if (peek().kind === 'star') {
    next();
    columns = '*';
  } else {
    columns = [expectIdentifier('a column name or *')];
    while (peek().kind === 'comma') {
      next();
      columns.push(expectIdentifier('a column name'));
    }
  }

  // FROM
  expectKeyword('FROM');
  const from = expectIdentifier('a table name');

  // WHERE
  const where: Condition[] = [];
  if (isKeyword(peek(), 'WHERE')) {
    next();
    do {
      const field = expectIdentifier('a field name');
      const opToken = next();
      if (opToken.kind !== 'op') {
        throw new SuiteQlSyntaxError(
          `Expected a comparison (=, !=, <, <=, >, >=) but found ${describe(opToken)} at position ${opToken.pos}`,
        );
      }
      const literal = next();
      if (literal.kind !== 'string' && literal.kind !== 'number') {
        throw new SuiteQlSyntaxError(
          `Expected a 'string' or number but found ${describe(literal)} at position ${literal.pos}`,
        );
      }
      where.push({ field, op: opToken.op, value: literal.value });
    } while (isKeyword(peek(), 'AND') && next());
  }

  // ORDER BY
  let orderBy: SuiteQlQuery['orderBy'];
  if (isKeyword(peek(), 'ORDER')) {
    next();
    expectKeyword('BY');
    const field = expectIdentifier('a field name');
    let direction: 'ASC' | 'DESC' = 'ASC';
    if (isKeyword(peek(), 'ASC') || isKeyword(peek(), 'DESC')) {
      direction = (next() as { text: string }).text.toUpperCase() as 'ASC' | 'DESC';
    }
    orderBy = { field, direction };
  }

  const end = next();
  if (end.kind !== 'end') {
    throw new SuiteQlSyntaxError(`Unsupported syntax: ${describe(end)} at position ${end.pos}`);
  }

  return { columns, from, where, ...(orderBy && { orderBy }) };
}
