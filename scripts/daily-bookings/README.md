# Midnight booking report

The active Codex scheduled task runs at 00:00 Asia/Kolkata and sends only to
`simsar280108@gmail.com`. This is a local Codex task: the computer and app must
be running. Pushing these scripts does not register a backend/server cron job.

The attachment contains two tabs, grouped by therapist:
- **Daily bookings:** active slots for the IST day just starting.
- **Yesterday's sessions:** every slot *scheduled* on the previous IST day, with
  a Status column saying what each became (Completed, Cancelled, No show, or
  not marked yet) and a "held" count per therapist. Selecting by
  `scheduled_date` — not `completion_date` — is deliberate: a therapist who
  marks the 21st's session complete on the 22nd would otherwise move that
  session onto the 22nd's tab while the 22nd's own unmarked slots went missing.

The email body contains only dates, slot totals, held counts, therapist totals
and an attachment note. It contains no slot preview or client information.

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
overlap; a lock older than 15 minutes is treated as stale and taken over, so a
force-killed run cannot block every later night. SMTP attempt records remain
only if delivery is uncertain (they are removed once a receipt is written):
inspect mail delivery and receipts before clearing one manually. Sending is not
retried automatically, to avoid duplicate reports. Any failed step emails
`koottfordeveloper@gmail.com`; a night when the computer is asleep sends
nothing at all, alert included.
