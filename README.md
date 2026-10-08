# Tablescore

A phone-friendly app for scoring board games with a personal rating rubric: seven weighted criteria, each scored 0–10, combined into one score on BGG's scale.

```
final = 5 + (weighted average − 5) × stretch, clamped to 0–10, one decimal
```

The default weights (Desire 40, Table Appeal 15, Depth 10, Interaction 10, Replayability 10, Art 10, Theme 5) and the stretch factor (1.25) are editable under Settings.

It runs as a small self-hosted server: Node 22 with its built-in SQLite and a plain HTML/JS front end. It's meant to be reached privately over Tailscale. This repo is code only. Your games, scores and BGG token stay on your machine in `data/` and `.env`, and both are git-ignored.

## Run it (Docker)

```sh
git clone https://github.com/jordanjohnson56/tablescore && cd tablescore
cp .env.example .env            # add BGG_TOKEN (and BGG_USERNAME if it isn't Theef)
mkdir -p data                   # owned by you; if your uid isn't 1000: sudo chown 1000:1000 data
docker compose up -d --build
tailscale serve --bg 8080       # HTTPS at https://<machine>.<tailnet>.ts.net
```

Open the `ts.net` URL on your phone, then use Share → Add to Home Screen (iOS) or Install app (Android). The container listens only on `127.0.0.1`, so it's reachable from this machine and through `tailscale serve`, not from the rest of your LAN. There's no login; your tailnet is the gate.

### Import the spreadsheet (once)

Copy the spreadsheet into `data/` (already mounted in the container at `/data`), then run the importer:

```sh
cp "/path/to/Game Rating Rubric v2.xlsx" data/rubric.xlsx
docker compose run --rm tablescore node server/import-xlsx.js /data/rubric.xlsx
```

This loads every game on the Scores tab (scores, old rating, calibration and avoid-theme flags, notes) and the weights and stretch factor from the Weights tab. Games already in the database are skipped. Add `--overwrite` to replace their scores from the sheet.

Then go to **Settings → Sync from BGG** to fill in thumbnails, player counts, play time, weight and your current BGG ratings.

## Run it without Docker

Requires Node 22.13 or newer.

```sh
npm ci
cp .env.example .env
npm run import-xlsx -- "/path/to/Game Rating Rubric v2.xlsx"
node --env-file=.env --disable-warning=ExperimentalWarning server/index.js
```

## BoardGameGeek

BGG's XML API needs a registered application token, sent as `Authorization: Bearer …`. Set it as `BGG_TOKEN` in `.env`. It's only used on the server and is never sent to the browser.

- **Add → search** finds a game on BGG and adds it with its details.
- **Settings → Sync from BGG** pulls your collection (status, plays, your BGG rating, images, player counts), then fetches weight and best player counts in batches of 20. Requests are spaced 5 s apart. A sync never changes your rubric scores, notes or flags, or a name you've edited.
- BGG's API is read-only, so ratings can't be pushed back. When your score differs from your BGG rating, the game is tagged **BGG** and shows the number to enter. Sync again afterwards to clear the tag.

## Data and backups

Everything lives in `data/tablescore.db`. On start and every 24 h, the server writes `data/backups/tablescore-YYYY-MM-DD.db` and keeps the newest `BACKUP_KEEP` (default 14). Copying `data/` somewhere else is your off-box backup. **Settings → Export JSON** downloads everything, and **Copy scores for Claude** puts a plain-text summary on the clipboard for asking about recommendations.

## Develop

```sh
npm ci
npm test                     # rubric math, BGG parsing (fixtures), API, import, backups
DATA_DIR=./data PORT=8080 npm start
```

Layout: `server/` (Express API, SQLite store, BGG client, sync, xlsx import) and `public/` (static app; `public/js/rubric.js` holds the criteria text and score math).
