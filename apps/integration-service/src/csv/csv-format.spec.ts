import { CsvSyntaxError, parseCsv, toCsv } from './csv-format.js';

describe('parseCsv', () => {
  it('reads plain rows with LF or CRLF line ends', () => {
    expect(parseCsv('a,b\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('handles quotes, escaped quotes, commas and line breaks inside quotes', () => {
    expect(parseCsv('x,y\n"Smith, J","say ""hi""\nthere"\n')).toEqual([
      ['x', 'y'],
      ['Smith, J', 'say "hi"\nthere'],
    ]);
  });

  it('strips the BOM Excel adds and skips blank lines', () => {
    expect(parseCsv('﻿a,b\n\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n,,')).toEqual([['a', '', 'c'], ['', '', '']]);
  });

  it.each([
    ['unclosed quote', 'a\n"abc'],
    ['text after closing quote', 'a\n"abc"x'],
    ['quote in the middle of a field', 'a\nab"c'],
  ])('refuses broken CSV: %s', (_, text) => {
    expect(() => parseCsv(text)).toThrow(CsvSyntaxError);
  });
});

describe('toCsv', () => {
  it('quotes only where needed and round-trips', () => {
    const rows = [['a', 'b, c', 'say "hi"', 'line\nbreak']];
    const text = toCsv(rows);
    expect(text).toBe('a,"b, c","say ""hi""","line\nbreak"\r\n');
    expect(parseCsv(text)).toEqual(rows);
  });

  it('defuses spreadsheet formulas', () => {
    expect(toCsv([['=HYPERLINK("x")', '+1', '@SUM(A1)', '-5']])).toBe(`"'=HYPERLINK(""x"")",'+1,'@SUM(A1),-5\r\n`);
  });
});
