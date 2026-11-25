// Clean stop on SIGTERM or SIGINT: stop the timers, let requests in flight
// finish for up to `graceMs`, mark running work failed, close the database
// (which folds the WAL back into tablescore.db) and exit 0.
//
// A running prediction or Run is not waited for: it can take minutes. It is
// marked failed here, as the boot sweep would, and a scheduled Run is retried
// at its next time because the schedule comes from the database (ADR 0002).

export function createShutdown({ server, scheduler, store, timers = [], graceMs = 5000, exit = process.exit, log = console }) {
  let started = false;
  let finished = false;
  let force = null;
  let idle = null;

  // Sweep, close and exit in one synchronous stretch, so no prediction can
  // finish in between and write to a closed database.
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(force);
    clearInterval(idle);
    try {
      const predictions = store.failRunningPredictions();
      const runs = store.failRunningRecommendationRuns();
      if (predictions) log.log(`${predictions} running prediction(s) marked failed.`);
      if (runs) log.log("The running recommendation run was marked failed.");
      store.close();
    } catch (e) {
      log.error("shutdown: could not close the database cleanly:", e);
    }
    exit(0);
  }

  return function shutdown(signal) {
    if (started) return;
    started = true;
    log.log(`${signal} received, shutting down.`);
    scheduler.stop();
    for (const t of timers) clearInterval(t);
    server.close(finish);
    // server.close() only drops connections idle at that moment; a keep-alive
    // connection whose request finishes later would hold it open until the limit.
    idle = setInterval(() => server.closeIdleConnections(), 100);
    force = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, graceMs);
  };
}
