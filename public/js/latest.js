// Latest call wins: one call of `run` at a time. A call made while one is
// running waits, and a newer call replaces it; a replaced call resolves to
// SUPERSEDED without running. Keeps Discover to one BGG search in flight.

export const SUPERSEDED = Symbol("superseded");

export function latestOnly(run) {
  let running = false;
  let waiting = null; // { args, resolve, reject }

  const start = ({ args, resolve, reject }) => {
    running = true;
    Promise.resolve()
      .then(() => run(...args))
      .then(resolve, reject)
      .finally(() => {
        running = false;
        const next = waiting;
        waiting = null;
        if (next) start(next);
      });
  };

  const call = (...args) =>
    new Promise((resolve, reject) => {
      if (!running) return start({ args, resolve, reject });
      waiting?.resolve(SUPERSEDED);
      waiting = { args, resolve, reject };
    });

  /** Forget the waiting call, if any; it resolves to SUPERSEDED. */
  call.drop = () => {
    waiting?.resolve(SUPERSEDED);
    waiting = null;
  };

  return call;
}
