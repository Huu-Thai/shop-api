import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

/** Imports larger than this many data rows are refused (split the file). */
export const MAX_IMPORT_ROWS = 200_000;

export interface CsvRow {
  /** 1-based line of the record, the header being row 1. */
  row: number;
  /** Cells by header name (trimmed). */
  values: Record<string, string>;
}

/**
 * Parses a UTF-8 CSV (BOM tolerated, comma or semicolon separated) with a header row. Header names
 * are trimmed; `required` columns must be present and nothing outside `allowed` (exact names or
 * patterns such as `name[en-US]`) is accepted, so typos fail loudly instead of being ignored.
 */
export function parseCsv(
  buffer: Buffer,
  spec: { required: readonly string[]; allowed: readonly (string | RegExp)[] },
): { header: string[]; rows: CsvRow[] } {
  const text = buffer.toString('utf8');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
      ? ';'
      : ',';
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      delimiter,
      skip_empty_lines: true,
      relax_quotes: false,
      trim: true,
    }) as string[][];
  } catch (e) {
    throw new BadRequestException(
      `The file is not valid CSV: ${(e as Error).message}`,
    );
  }
  if (!records.length) throw new BadRequestException('The file is empty');
  const header = records[0].map((h) => h.trim());
  const dupes = header.filter((h, i) => header.indexOf(h) !== i);
  if (dupes.length)
    throw new BadRequestException(`Duplicate columns: ${dupes.join(', ')}`);
  const missing = spec.required.filter((c) => !header.includes(c));
  if (missing.length)
    throw new BadRequestException(`Missing columns: ${missing.join(', ')}`);
  const unknown = header.filter(
    (h) =>
      !spec.allowed.some((a) => (typeof a === 'string' ? a === h : a.test(h))),
  );
  if (unknown.length)
    throw new BadRequestException(`Unknown columns: ${unknown.join(', ')}`);
  if (records.length - 1 > MAX_IMPORT_ROWS)
    throw new BadRequestException(
      `At most ${MAX_IMPORT_ROWS} rows per file; split it`,
    );
  const rows: CsvRow[] = [];
  for (let i = 1; i < records.length; i++) {
    const r = records[i];
    if (r.length !== header.length)
      throw new BadRequestException(
        `Row ${i + 1} has ${r.length} cells, the header has ${header.length}`,
      );
    rows.push({
      row: i + 1,
      values: Object.fromEntries(header.map((h, j) => [h, r[j]])),
    });
  }
  return { header, rows };
}

/**
 * A cell that a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR) is prefixed with
 * `'` (OWASP CSV injection), except plain numbers such as `-5` or `+84…`.
 */
export function safeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) return `'${s}`;
  return s;
}

/** Builds a CSV file in chunks (UTF-8 with BOM so spreadsheets read accents). */
export class CsvWriter {
  private readonly chunks: Buffer[] = [Buffer.from('﻿', 'utf8')];
  rows = 0;

  constructor(readonly header: readonly string[]) {
    this.chunks.push(Buffer.from(stringify([header as string[]]), 'utf8'));
  }

  add(records: readonly (readonly unknown[])[]): void {
    if (!records.length) return;
    this.chunks.push(
      Buffer.from(
        stringify(records.map((r) => r.map((c) => safeCell(c)))),
        'utf8',
      ),
    );
    this.rows += records.length;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Minor units → `25.00` (currency with `minorUnits` decimals). */
export function minorToDecimal(amount: bigint, minorUnits: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  if (minorUnits === 0) return `${neg ? '-' : ''}${abs}`;
  const s = abs.toString().padStart(minorUnits + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -minorUnits)}.${s.slice(-minorUnits)}`;
}

/** `25`, `25.5`, `25.00` → minor units; null when not a non-negative amount with ≤ minorUnits decimals. */
export function decimalToMinor(
  value: string,
  minorUnits: number,
): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > minorUnits) return null;
  return BigInt(m[1] + frac.padEnd(minorUnits, '0'));
}

/** Today's date for file names (`orders-2026-11-21.csv`). */
export const fileDate = (d = new Date()) => d.toISOString().slice(0, 10);
