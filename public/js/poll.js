/** One repeating poll that sections take turns owning. A stopped poll is always null, never a stale ID. */
export function sharedPoll(ms, timers = globalThis) {
  let id = null;
  let owner = null;
  const halt = () => {
    timers.clearInterval(id);
    id = null;
  };
  return {
    /** A newly drawn section takes over; the previous owner's poll stops. */
    claim(token) {
      halt();
      owner = token;
    },
    /** Starts polling for the current owner. No-op for a past owner or when already polling. */
    start(token, fn) {
      if (token === owner && id == null) id = timers.setInterval(fn, ms);
    },
    /** Stops polling. No-op for a past owner, so an old section cannot stop a newer one's poll. */
    stop(token) {
      if (token === owner) halt();
    },
    get active() {
      return id != null;
    },
  };
}
