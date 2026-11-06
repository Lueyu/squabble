import Papa from 'papaparse';
/** The first worksheet is previewed explicitly; no workbook content writes the ledger. */
export async function readTransactionMatrix(file: Pick<File, 'name' | 'size' | 'text' | 'arrayBuffer'>): Promise<string[][]> {
  if (file.size <= 0 || file.size > 8 * 1024 * 1024) throw new Error('FILE_SIZE_LIMIT');
  if (file.name.toLowerCase().endsWith('.xlsx')) {
    const ExcelJS = await import('exceljs'), workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.actualRowCount < 2 || sheet.actualRowCount > 501) throw new Error('ROW_COUNT_LIMIT');
    const grid: string[][] = [];
    sheet.eachRow(row => grid.push(Array.from({ length: Math.min(50, sheet.columnCount) }, (_, index) => {
      const cell = row.getCell(index + 1);
      return cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : cell.text;
    })));
    return grid;
  }
  const parsed = Papa.parse<string[]>(await file.text(), { skipEmptyLines: true });
  if (parsed.errors.length) throw new Error('CSV_PARSE_FAILED');
  if (parsed.data.length < 2 || parsed.data.length > 501) throw new Error('ROW_COUNT_LIMIT');
  return parsed.data;
}
