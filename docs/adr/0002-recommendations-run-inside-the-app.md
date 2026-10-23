# Recommendations run inside the app on a timer, not as a cloud routine

The weekly recommendation run is an in-process scheduler in the Node server, like the daily backup. It checks every five minutes whether a run is due (04:00 server time, an interval after the last successful run's start) and runs it with the same Claude client and BGG token the manual predictions use. The last run time comes from the database, so a restart doesn't lose the schedule, and an overdue run waits for the next 04:00 rather than firing on boot.

## Considered Options

- **A cloud routine that calls the app.** Rejected for the reason in ADR 0001: the app sits on the tailnet with no login, so nothing outside can reach it.
- **A cloud routine that writes recommendations to the private repo for the app to import.** Rejected: it would need a second copy of the rubric prompt and the user's scores outside the app, and the user would have to import by hand each week.
- **A system cron job that calls the app's refresh endpoint.** Rejected: it adds host configuration the Docker setup doesn't have today, for no gain over a timer in the process that already runs all day.
