import { join } from "node:path";
import { openDb } from "./db.js";
import { BggClient } from "./bgg.js";
import { createApp } from "./app.js";

const env = process.env;
const dataDir = env.DATA_DIR || "data";
const port = Number(env.PORT || 8080);
const host = env.HOST || "127.0.0.1";
const keep = Number(env.BACKUP_KEEP || 14);

const store = openDb(join(dataDir, "tablescore.db"));
const bgg = new BggClient({ token: env.BGG_TOKEN });
const app = createApp({ store, bgg, bggUsername: env.BGG_USERNAME });

function backup() {
  try {
    console.log(`backup written: ${store.backup(join(dataDir, "backups"), keep)}`);
  } catch (e) {
    console.error("backup failed:", e);
  }
}
backup();
setInterval(backup, 24 * 60 * 60 * 1000).unref();

app.listen(port, host, () => {
  console.log(`Tablescore listening on http://${host}:${port}`);
  if (!bgg.configured) console.log("BGG_TOKEN not set: BGG search and sync are disabled.");
});
