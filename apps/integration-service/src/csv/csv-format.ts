/**
 * Minimal CSV reader/writer (RFC 4180): commas, double-quoted fields with
 * "" for a quote, commas and line breaks inside quotes, CRLF or LF line ends,
 * a UTF-8 BOM at the start (Excel adds one). Small enough not to need a library.
 */

export class CsvSyntaxError extends Error {}

/** Parses CSV text into rows of fields. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;

  const endField = () => {
    row.push(field);
    field = '';
    quotedField = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field !== '' || quotedField) throw new CsvSyntaxError(`Unexpected quote in line ${rows.length + 1}`);
      inQuotes = true;
      quotedField = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      endRow();
    } else {
      if (quotedField) throw new CsvSyntaxError(`Text after a closing quote in line ${rows.length + 1}`);
      field += c;
    }
  }
  if (inQuotes) throw new CsvSyntaxError('A quoted field is never closed');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Writes rows as CSV (CRLF, quoting only where needed).
 *
 * Cells starting with = + @ or a tab are prefixed with ' so a spreadsheet
 * shows them as text instead of running them as formulas ("CSV injection").
 * The errors file echoes back whatever was uploaded, so this matters.
 */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(formatCell).join(',')).join('\r\n') + '\r\n';
}

function formatCell(value: string): string {
  const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
