import { parseSuiteQl, SuiteQlSyntaxError } from './suiteql-parser.js';

describe('parseSuiteQl', () => {
  it('parses SELECT * FROM table', () => {
    expect(parseSuiteQl('SELECT * FROM customer')).toEqual({ columns: '*', from: 'customer', where: [] });
  });

  it('parses a column list, case-insensitive keywords', () => {
    expect(parseSuiteQl('select id, externalId from invoice')).toEqual({
      columns: ['id', 'externalId'],
      from: 'invoice',
      where: [],
    });
  });

  it('parses WHERE with AND, strings and numbers', () => {
    const q = parseSuiteQl("SELECT id FROM invoice WHERE status = 'open' AND total >= 100 AND amountRemaining > -0.5");
    expect(q.where).toEqual([
      { field: 'status', op: '=', value: 'open' },
      { field: 'total', op: '>=', value: 100 },
      { field: 'amountRemaining', op: '>', value: -0.5 },
    ]);
  });

  it('treats <> as !=', () => {
    expect(parseSuiteQl("SELECT id FROM invoice WHERE status <> 'open'").where[0]?.op).toBe('!=');
  });

  it("reads '' inside a string as one quote", () => {
    expect(parseSuiteQl("SELECT id FROM customer WHERE companyName = 'O''Brien'").where[0]?.value).toBe("O'Brien");
  });

  it('parses ORDER BY with and without direction', () => {
    expect(parseSuiteQl('SELECT id FROM invoice ORDER BY total DESC').orderBy).toEqual({
      field: 'total',
      direction: 'DESC',
    });
    expect(parseSuiteQl('SELECT id FROM invoice ORDER BY total').orderBy).toEqual({
      field: 'total',
      direction: 'ASC',
    });
  });

  it.each([
    ['DELETE FROM customer', /Expected SELECT/],
    ['SELECT FROM customer', /column name/],
    ['SELECT id customer', /Expected FROM/],
    ["SELECT id FROM invoice WHERE status = 'open' OR total > 1", /Unsupported syntax: 'OR'/],
    ['SELECT id FROM invoice WHERE status open', /comparison/],
    ['SELECT id FROM invoice WHERE total > status', /'string' or number/],
    ["SELECT id FROM invoice WHERE status = 'open", /Unterminated string/],
    ['SELECT id FROM customer; DROP TABLE customer', /Unexpected character ';'/],
    ['SELECT COUNT(*) FROM customer', /Unexpected character '\('/],
    ['SELECT id FROM invoice JOIN customer', /Unsupported syntax/],
    ['SELECT id FROM invoice ORDER total', /Expected BY/],
  ])('rejects %s', (query, message) => {
    expect(() => parseSuiteQl(query)).toThrow(SuiteQlSyntaxError);
    expect(() => parseSuiteQl(query)).toThrow(message);
  });
});
