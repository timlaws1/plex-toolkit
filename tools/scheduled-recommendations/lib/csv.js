/**
 * Parse RFC-style CSV into a header-keyed list of row objects.
 * @param {string} text
 */
export function parseCsvObjects(text) {
  const rows = parseCsvRows(String(text || '').replace(/^\uFEFF/, ''));
  if (rows.length === 0) return [];
  const headers = rows[0].map((cell) => cell.trim());
  const out = [];
  for (const row of rows.slice(1)) {
    if (row.every((cell) => !String(cell || '').trim())) continue;
    const obj = {};
    headers.forEach((header, index) => {
      if (!header) return;
      obj[header] = row[index] ?? '';
    });
    out.push(obj);
  }
  return out;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}
