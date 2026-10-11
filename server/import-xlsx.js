// One-time import from the rubric spreadsheet (v2 layout: Scores + Weights tabs).
// Usage: npm run import-xlsx -- "/path/to/Game Rating Rubric v2.xlsx" [--overwrite]
// Games already in the database are skipped unless --overwrite is given, in which
// case their scores, flags, notes and old rating are replaced from the sheet.
import ExcelJS from "exceljs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "./db.js";
import { checkFile } from "./files.js";
import { CRITERIA } from "../public/js/rubric.js";

const WEIGHT_KEYS = { Desire: "desire", Table: "table", Depth: "depth", Interaction: "interaction", Replay: "replay", Art: "art", Theme: "theme" };

export async function readWorkbook(file) {
  checkFile(file, "a spreadsheet");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const ws = wb.getWorksheet("Scores");
  if (!ws) throw new Error('No "Scores" tab in that workbook');
  const header = {};
  ws.getRow(1).eachCell((cell, col) => (header[String(cell.value).trim()] = col));
  const need = ["Game", "BGG ID", ...CRITERIA.map((c) => c.name)];
  const missing = need.filter((h) => !header[h]);
  if (missing.length) throw new Error(`Scores tab is missing columns: ${missing.join(", ")}`);

  const games = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const v = (h) => (header[h] ? cellValue(row.getCell(header[h]).value) : null);
    const name = v("Game");
    if (!name) return;
    games.push({
      name: String(name),
      bggId: num(v("BGG ID")),
      type: v("Type") || "Base",
      status: v("Status in collection") || "",
      plays: num(v("Plays")) ?? 0,
      oldRating: num(v("Old Rating")),
      bggRating: num(v("Old Rating")), // the rating on BGG at export time; sync refreshes it
      bggAvg: num(v("BGG Avg")),
      calibration: v("Calibration") === "Yes",
      avoidTheme: v("Avoid Theme?") === "Yes",
      notes: v("Notes") ? String(v("Notes")) : "",
      scores: Object.fromEntries(CRITERIA.map((c) => [c.key, num(v(c.name))])),
    });
  });

  let settings = null;
  const w = wb.getWorksheet("Weights");
  if (w) {
    const weights = {};
    for (let r = 4; r <= 10; r++) {
      const key = WEIGHT_KEYS[cellValue(w.getCell(r, 1).value)];
      if (key) weights[key] = num(cellValue(w.getCell(r, 3).value));
    }
    const stretch = num(cellValue(w.getCell("C14").value));
    if (CRITERIA.every((c) => typeof weights[c.key] === "number") && stretch) settings = { weights, stretch };
  }
  return { games, settings };
}

export function importInto(store, { games, settings }, { overwrite = false } = {}) {
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  store.transaction(() => {
    if (settings) store.setSettings(settings);
    for (const g of games) {
      const existing = g.bggId ? store.getByBggId(g.bggId) : null;
      if (!existing) {
        store.createGame(g);
        added++;
      } else if (overwrite) {
        const { scores, avoidTheme, calibration, notes } = g;
        store.updateGame(existing.id, { scores, avoidTheme, calibration, notes });
        store.db.prepare("UPDATE games SET old_rating = ? WHERE id = ?").run(g.oldRating, existing.id);
        replaced++;
      } else {
        skipped++;
      }
    }
  });
  return { added, replaced, skipped, settings: !!settings };
}

function cellValue(v) {
  if (v && typeof v === "object") {
    if ("result" in v) return v.result; // formula cell
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return v.text; // hyperlink
  }
  return v;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error('Usage: npm run import-xlsx -- "/path/to/Game Rating Rubric v2.xlsx" [--overwrite]');
    process.exit(1);
  }
  const store = openDb(join(process.env.DATA_DIR || "data", "tablescore.db"));
  let parsed;
  try {
    parsed = await readWorkbook(file);
  } catch (e) {
    console.error(`Import failed: ${e.message}`);
    process.exit(1);
  }
  const result = importInto(store, parsed, { overwrite: args.includes("--overwrite") });
  console.log(
    `Imported: ${result.added} added, ${result.replaced} replaced, ${result.skipped} already present` +
      (result.settings ? "; weights and stretch factor loaded." : "; weights not found, defaults kept."),
  );
}
