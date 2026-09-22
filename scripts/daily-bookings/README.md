# Midnight booking report

The active Codex scheduled task runs at 00:00 Asia/Kolkata and sends only to
`simsar280108@gmail.com`. This is a local Codex task: the computer and app must
be running. Pushing these scripts does not register a backend/server cron job.

The attachment contains two tabs, grouped by therapist:
- **Daily bookings:** active slots for the IST day just starting.
- **Completed sessions:** sessions marked completed with the previous day's
  recorded `completion_date`. Legacy rows with no completion date use their
  scheduled date. The recorded date can be entered/backdated by staff; it is
  not the timestamp when someone clicked Complete. Scheduled dates are shown
  separately on this tab.

The email body contains only dates, session totals, therapist totals and an
attachment note. It contains no slot preview or client information.

Use the Node executable and package directory returned by Codex's workspace
dependency loader. Set `ARTIFACT_NODE_MODULES` to its bundled `node_modules`
directory. The backend's installed dependencies and `.env` supply database
and SMTP access. No credentials or generated operational data are committed.

```sh
ARTIFACT_NODE_MODULES=/path/to/bundled/node_modules /path/to/bundled/node scripts/daily-bookings/run-daily.cjs --dry-run
```

Omit `--dry-run` to email the current day's report. Before authoring from a
Codex task, run the spreadsheet skill's operation-start marker once.
`REPORT_OUTPUT_DIR` may select an output location; the default
`.daily-booking-reports/` is ignored by Git. The runner fixes `REPORT_DATE` to
the current IST date so it cannot accidentally send yesterday's report.

Per-date receipts prevent repeated sends. An exclusive run lock prevents
overlap. SMTP attempt records remain if delivery is uncertain: inspect mail
delivery and receipts before manually clearing an attempt or stale lock.
Sending is not retried automatically, to avoid duplicate reports.
