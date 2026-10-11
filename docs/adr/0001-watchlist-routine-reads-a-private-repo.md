# The watchlist routine reads a private repo, not the app

The monthly watchlist check runs as a cloud routine. Tablescore is reachable only on the user's tailnet and has no login, so the routine can't call its API. The app exports the watchlist as JSON, the user commits it to a separate private repo, and the routine reads it there. The routine keeps its own memory (the last stage and predicted score it reported) in that repo and never writes to the Tablescore database. The user applies its suggestions by hand.

## Considered Options

- **Expose a read-only endpoint through Tailscale Funnel with a token.** Rejected: it puts an app with no auth on the public internet.
- **Commit the watchlist to the tablescore repo.** Rejected: that repo is public and holds code only.
- **Let the routine own the watchlist.** Rejected: the app and the routine would drift apart with no source of truth.
