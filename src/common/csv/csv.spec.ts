import { IsInt, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { validateDto } from '../dto/validate-dto.js';
import { errorText } from '../utils/error-text.js';
import { BadRequestException } from '@nestjs/common';
import {
  CsvWriter,
  decimalToMinor,
  fileDate,
  MAX_IMPORT_ROWS,
  minorToDecimal,
  parseCsv,
  safeCell,
} from './csv.js';

const spec = {
  required: ['sku', 'price'],
  allowed: ['sku', 'price', 'min_qty', /^name\[[a-z-]+\]$/i],
};
const csv = (s: string) => Buffer.from(s, 'utf8');

describe('parseCsv', () => {
  it('reads a header and rows (BOM, quotes, CRLF), numbering rows from the header', () => {
    const r = parseCsv(
      csv(
        '﻿sku,price,name[en-US]\r\nTEE,"25.00","Tee, ""classic"""\r\n\r\nMUG,10,Mug\r\n',
      ),
      spec,
    );
    expect(r.header).toEqual(['sku', 'price', 'name[en-US]']);
    expect(r.rows).toEqual([
      {
        row: 2,
        values: { sku: 'TEE', price: '25.00', 'name[en-US]': 'Tee, "classic"' },
      },
      { row: 3, values: { sku: 'MUG', price: '10', 'name[en-US]': 'Mug' } },
    ]);
  });

  it('accepts semicolon-separated files (spreadsheets in many locales)', () => {
    expect(parseCsv(csv('sku;price\nTEE;25,5\n'), spec).rows[0].values).toEqual(
      { sku: 'TEE', price: '25,5' },
    );
  });

  it('rejects broken files with a clear message', () => {
    const bad: [string, string][] = [
      ['', 'The file is empty'],
      ['sku\nTEE\n', 'Missing columns: price'],
      ['sku,price,colour\nTEE,1,red\n', 'Unknown columns: colour'],
      ['sku,price,sku\nA,1,B\n', 'Duplicate columns: sku'],
      ['sku,price\nTEE\n', 'not valid CSV'],
      ['sku,price\n"TEE,1\n', 'not valid CSV'],
    ];
    for (const [text, msg] of bad)
      expect(() => parseCsv(csv(text), spec)).toThrow(msg);
    const many = 'sku,price\n' + 'A,1\n'.repeat(MAX_IMPORT_ROWS + 1);
    expect(() => parseCsv(csv(many), spec)).toThrow(
      `At most ${MAX_IMPORT_ROWS} rows`,
    );
  });
});

describe('CSV output', () => {
  it('neutralises spreadsheet formulas but keeps numbers', () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCell('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(safeCell('+84 90 123')).toBe(`'+84 90 123`);
    expect(safeCell('-5')).toBe('-5');
    expect(safeCell('+12.5')).toBe('+12.5');
    expect(safeCell(null)).toBe('');
    expect(safeCell(new Date('2026-11-21T00:00:00Z'))).toBe(
      '2026-11-21T00:00:00.000Z',
    );
    expect(safeCell({ a: 1 })).toBe('{"a":1}');
    expect(safeCell(true)).toBe('true');
  });

  it('writes UTF-8 with a BOM, header first', () => {
    const w = new CsvWriter(['sku', 'name']);
    w.add([]);
    w.add([
      ['TEE', 'Áo thun, "cổ điển"'],
      ['X', '=1+1'],
    ]);
    expect(w.rows).toBe(2);
    expect(w.toBuffer().toString('utf8')).toBe(
      '﻿sku,name\nTEE,"Áo thun, ""cổ điển"""\nX,\'=1+1\n',
    );
  });

  it('converts between minor units and decimals', () => {
    expect(minorToDecimal(2500n, 2)).toBe('25.00');
    expect(minorToDecimal(5n, 2)).toBe('0.05');
    expect(minorToDecimal(-150n, 2)).toBe('-1.50');
    expect(minorToDecimal(399000n, 0)).toBe('399000');
    expect(minorToDecimal(-3n, 0)).toBe('-3');
    expect(decimalToMinor('25', 2)).toBe(2500n);
    expect(decimalToMinor('25.5', 2)).toBe(2550n);
    expect(decimalToMinor(' 0.05 ', 2)).toBe(5n);
    expect(decimalToMinor('399000', 0)).toBe(399000n);
    for (const bad of ['25.001', '-1', '1,5', 'abc', '', '1e3'])
      expect(decimalToMinor(bad, 2)).toBeNull();
    expect(decimalToMinor('1.5', 0)).toBeNull();
    expect(fileDate(new Date('2026-11-21T23:00:00Z'))).toBe('2026-11-21');
  });
});

class Line {
  @IsString() sku: string;
  @IsInt() @Min(1) qty: number;
}
class Body {
  @IsString() name: string;
  @ValidateNested({ each: true }) @Type(() => Line) lines: Line[];
}

describe('validateDto and errorText', () => {
  it('validates like the API, nested properties included', async () => {
    expect(
      (await validateDto(Body, { name: 'x', lines: [{ sku: 'A', qty: 1 }] }))
        .errors,
    ).toEqual([]);
    const { errors } = await validateDto(Body, {
      name: 1,
      lines: [{ sku: 'A', qty: 0 }],
      extra: true,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'property extra should not exist',
        'name must be a string',
        'lines.0.qty must not be less than 1',
      ]),
    );
  });

  it('flattens HTTP and plain errors to one line', () => {
    expect(errorText(new BadRequestException(['a', 'b']))).toBe('a; b');
    expect(errorText(new BadRequestException('nope'))).toBe('nope');
    expect(errorText(new Error('boom'))).toBe('boom');
  });
});
