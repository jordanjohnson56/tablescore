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

- BGG's API terms require the "Powered by BGG" logo, linked to BoardGameGeek, on public-facing apps. It sits in the footer of every view (`public/img/`, light and dark variants). Keep it if you change the layout.
- **Add → search** finds a game on BGG and adds it with its details.
- **Settings → Sync from BGG** pulls your collection (status, plays, your BGG rating, images, player counts), then fetches weight and best player counts in batches of 20. Requests are spaced 5 s apart. A sync never changes your rubric scores, notes or flags, or a name you've edited.
- BGG's API is read-only, so ratings can't be pushed back. When your score differs from your BGG rating, the game is tagged **BGG** and its page shows the number to enter. **Copy & open BGG** copies the score and opens the game on BGG. **I've rated it** records that rating locally so the tag clears without a sync, and the next sync replaces it with whatever BGG actually has. From the **Update BGG** filter, **I've rated it** moves on to the next game that needs rating.

## Claude predictions

Tablescore can ask Claude to predict your score for a game you haven't scored. Set `ANTHROPIC_API_KEY` in `.env` (from console.anthropic.com; usage is billed to that account, and Max plans include monthly API credits). Without a key the feature is off.

**Add → search** shows **Predict** next to each BGG result, and an unscored game's page has a **Predict my score** button. The prediction page shows each criterion, the rationale, a note on two-player play and the sources, with **Add to list** and **Add to watchlist** for a game that isn't in your list yet. Write your **taste profile** under **Settings → Claude predictions**; the same card shows how far off past predictions were once you've scored those games.

- Claude sees the rubric (criteria, bands, weights, stretch), your **taste profile** (free text under Settings), every game you've scored with its seven criterion scores, plays, BGG weight and player counts, and your old ratings for games not yet rescored, labeled as the weaker signal they are. Watched games and the game being predicted are left out.
- For the game itself it gets BGG's details (description, mechanics, categories, designers, and the base game for an expansion, with your score for it if you have one), plus up to 5 web searches. A game with no BGG ID is predicted from its name and the web.
- It returns a score for each criterion, a confidence, a short rationale naming the games it compared against, a note on how the game plays at two, an avoid-theme flag and the pages it relied on. The final score is worked out by the app with your current weights, like any other score.
- A prediction runs as a job on the server (one at a time, usually 20–60 s), so closing the app doesn't lose it. Every prediction is kept. A game you've scored can't be predicted any more; instead, its page and Settings compare your score with the last prediction made before you first scored it (also at `GET /api/predictions/accuracy`).
- A watched game takes Claude's prediction as its predicted score only when it has none of its own. Adding a predicted game from BGG carries over the avoid-theme flag.
- The model is `claude-opus-5-5`. Set `CLAUDE_MODEL=claude-sonnet-5-5` in `.env` for faster, cheaper predictions. Each prediction's token and search counts are stored with it.

## Watchlist

The **Watchlist** tab follows crowdfunded games you aren't backing, so you can wait for delivery and reviews before buying a used copy. Mark a game as Watching with **Watch instead of score** on Add, or from the Watch section of any game's page. Each watched game has a campaign URL, platform, campaign end date, estimated delivery month, a **predicted score** (kept apart from real rubric scores) and a **target price**.

A watched game moves through these **watch stages**, only when you change them: Campaign live → Awaiting delivery → Delivered → Reviews out → Buy or Pass. Buy and Pass are **Decided** and sit in a collapsed section. The watch stage is separate from status, so a BGG sync never touches it.

Watched games stay out of the main list, Summary and Claude export. **Settings → Include watched games in the list and Claude export** shows them in the list and the export, labeled *predicted*. Summary statistics never use predicted scores.

### Export to the private repo

A monthly cloud routine checks on watched games. It can't reach this server, so it reads a JSON export you commit to a separate private repo (see `docs/adr/0001-watchlist-routine-reads-a-private-repo.md`). The export holds every watched game, Decided ones flagged with `decided: true`, in Watchlist order, plus your weights and stretch factor and an `exportedAt` timestamp. Get it from **Settings → Export watchlist**, from `GET /api/watchlist`, or write it straight into a clone of the private repo:

```sh
npm run export-watchlist -- ~/watchlist-repo/watchlist.json
# With Docker, write it to data/ and copy it over:
#   docker compose run --rm tablescore node server/export-watchlist.js /data/watchlist.json
#   cp data/watchlist.json ~/watchlist-repo/
cd ~/watchlist-repo && git add watchlist.json && git commit -m "Watchlist $(date +%F)" && git push
```

### Import watched games

To seed watched games without typing them on your phone, put them in a JSON file and import it. The file is an array of games in the export's game shape, or a whole watchlist export. Each game needs a `name` and a `watchStage` (`campaign`, `awaiting`, `delivered`, `reviews`, `buy` or `pass`). The other fields (`bggId`, `campaignUrl`, `platform`, `campaignEnd`, `deliveryEst`, `predictedScore`, `targetPrice`, `targetCurrency`, `notes`) are optional, and `decided` is ignored.

```json
[
  { "name": "Example Quest", "watchStage": "campaign", "platform": "kickstarter",
    "campaignUrl": "https://www.kickstarter.com/projects/example/example-quest",
    "campaignEnd": "2026-11-30", "deliveryEst": "2027-10", "predictedScore": 7.5,
    "targetPrice": 40, "targetCurrency": "USD", "notes": "" }
]
```

```sh
npm run import-watchlist -- data/watchlist-seed.json
# With Docker:
#   docker compose run --rm tablescore node server/import-watchlist.js /data/watchlist-seed.json
```

A game already in the database is skipped and listed as skipped, never overwritten. It matches when the BGG IDs are equal or the names match ignoring case, so a game you added by hand without a BGG ID isn't duplicated and running the import twice is harmless. If any game is invalid (no name, an unknown stage, a bad date or price), the import names it and writes nothing. Keep personal seed files under `data/`, which git ignores.

## Data and backups

Everything lives in `data/tablescore.db`. On start and every 24 h, the server writes `data/backups/tablescore-YYYY-MM-DD.db` and keeps the newest `BACKUP_KEEP` (default 14). Copying `data/` somewhere else is your off-box backup. **Settings → Export JSON** downloads everything, and **Copy scores for Claude** puts a plain-text summary on the clipboard for asking about recommendations.

## Develop

```sh
npm ci
npm test                     # rubric math, BGG parsing (fixtures), API, import, backups
DATA_DIR=./data PORT=8080 npm start
```

Layout: `server/` (Express API, SQLite store, BGG client, sync, xlsx import, watchlist export) and `public/` (static app; `public/js/rubric.js` holds the criteria text and score math).
