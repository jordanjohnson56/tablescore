// Minimal .xlsx reader: cell values only (numbers, strings, booleans, cached
// formula results). No styles, dates or writing; enough for the rubric import.
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name, path, leaf, isAttr) => !isAttr && ["sheet", "Relationship", "si", "r", "row", "c"].includes(name),
});

// Returns Map<sheet name, rows>, where rows[r][c] is the value at row r, column c (both 1-based).
export function readXlsx(buf) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buf), { filter: (f) => /\.(xml|rels)$/.test(f.name) });
  } catch {
    throw new Error("That file is not a valid .xlsx workbook");
  }
  const xml = (path) => (files[path] ? parser.parse(strFromU8(files[path])) : null);

  const workbook = xml("xl/workbook.xml");
  if (!workbook) throw new Error("That file is not a valid .xlsx workbook");
  const rels = Object.fromEntries(
    (xml("xl/_rels/workbook.xml.rels")?.Relationships?.Relationship ?? []).map((r) => [r.Id, r]),
  );
  const target = (t) => (t.startsWith("/") ? t.slice(1) : `xl/${t}`);
  const sstRel = Object.values(rels).find((r) => r.Type.endsWith("/sharedStrings"));
  const shared = (xml(sstRel ? target(sstRel.Target) : "xl/sharedStrings.xml")?.sst?.si ?? []).map(richText);

  const sheets = new Map();
  for (const s of workbook.workbook?.sheets?.sheet ?? []) {
    const rel = rels[s.id];
    if (rel) sheets.set(s.name, readSheet(xml(target(rel.Target)), shared));
  }
  return sheets;
}

function readSheet(doc, shared) {
  const rows = [];
  let r = 0;
  for (const row of doc?.worksheet?.sheetData?.row ?? []) {
    r = row.r ? Number(row.r) : r + 1;
    const cells = (rows[r] = []);
    let c = 0;
    for (const cell of row.c ?? []) {
      c = cell.r ? colNumber(cell.r) : c + 1;
      cells[c] = cellValue(cell, shared);
    }
  }
  return rows;
}

function cellValue(cell, shared) {
  const v = cell.v === undefined ? undefined : text(cell.v);
  switch (cell.t) {
    case "s":
      return shared[Number(v)] ?? null;
    case "inlineStr":
      return cell.is ? richText(cell.is) : null;
    case "str": // formula with a string result
    case "e": // error such as #N/A
      return v ?? null;
    case "b":
      return v === undefined ? null : v === "1";
    default:
      if (v === undefined || v === "") return null;
      return Number(v);
  }
}

// A shared or inline string: plain <t>, or rich-text runs <r><t>.
function richText(node) {
  if (node.t !== undefined) return text(node.t);
  return (node.r ?? []).map((run) => text(run.t)).join("");
}

function text(node) {
  if (node === undefined || node === null) return "";
  return typeof node === "object" ? String(node["#text"] ?? "") : String(node);
}

function colNumber(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/i)[0].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}
