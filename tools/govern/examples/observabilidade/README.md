# Observability example: Grafana insights in Slack

Part of [super-tools](../../../../README.md); the tool is [govern](../../README.md).

[grafana-watch.ts](grafana-watch.ts) reads Grafana through its datasource proxy with a service account token (Viewer).
A timer runs it. It posts to a Slack channel; nothing else is written anywhere.

- **Every 15 minutes (no arguments):**
  - It looks at three kinds of signal:
    - firing Alertmanager alerts (`Watchdog` and the other names in `GRAFANA_WATCH_IGNORE_ALERTS` are left out);
    - Prometheus targets with `up == 0`;
    - error spikes per app in Loki: lines that match `GRAFANA_WATCH_ERRORS` in the last 15 minutes, against the mean of
      the runs recorded in the 24 h before. A spike needs at least 50 errors and at least 3 times the mean. Until four
      runs are recorded, one query of the hour before seeds the mean.
  - Only changes are posted. New signals go in one message, with up to 3 sample log lines per app and up to 3
    insights. Signals that ended get a "normalizado" line.
  - The first run records what is already active and posts nothing.
- **`--digest` (once a day):** errors per app over the last 24 h against the 24 h before, the active alerts, the down
  targets and up to 3 insights.
  - Each watch run keeps its counts for 48 h, and the digest sums them. A 24 h Loki query with a line filter is too slow
    to ask: Grafana's proxy gives up after 30 s.
  - The message gives the coverage when fewer than 90% of the day's runs are recorded.

- **`--report` (every 2 hours):** a visual report of the last 2 h, uploaded to the channel as an image. It has:
  - the window (BRT) and a status: Crítico when a target is down or a critical alert fires; Atenção for an error spike,
    any alert, or errors above 1.5 times the 2 h before; Normal otherwise;
  - errors, apps in a spike, alerts and down targets;
  - errors per app against the 2 h before;
  - the last 24 h in 2 h columns;
  - the checked insights.

  [report.ts](report.ts) builds it as a scene-render document. `GRAFANA_WATCH_RENDER` renders it:
  [render-scene.sh](render-scene.sh) validates and renders it with the scene-render Docker image, with no network. The
  output must be a PNG. The PNG is uploaded through Slack's external upload: the bytes go only to `files.slack.com`,
  without the token. The summary and insights go as the image's comment. If rendering fails, the summary is posted as
  text and the run exits 1.

Insights come from `GRAFANA_WATCH_INSIGHT`. [insight-claude.sh](insight-claude.sh) uses Claude Code headless with no tools.
The model gets the facts, each with an id, and the sample lines. Its answer is checked before it is posted:

- there are 1 to 3 insights;
- each cites ids that exist;
- every number in the text is in the facts or the lines;
- there are no links.

A failed check drops the insights, and the reason goes to stderr.

Settings:

- Grafana: `GRAFANA_BASE_URL`, `GRAFANA_TOKEN`.
- Datasource uids: `GRAFANA_PROMETHEUS_UID`, `GRAFANA_LOKI_UID`, `GRAFANA_ALERTMANAGER_UID`.
- Slack: `SLACK_BOT_TOKEN`, `GRAFANA_WATCH_CHANNEL` (or `SLACK_SUPPORT_CHANNEL`).
- State and insights: `GRAFANA_WATCH_STATE`, `GRAFANA_WATCH_INSIGHT`.
- What to watch: `GRAFANA_WATCH_NAMESPACES` (default `prd`, a LogQL regex), `GRAFANA_WATCH_ERRORS`,
  `GRAFANA_WATCH_WINDOW_MIN`, `GRAFANA_WATCH_MIN_ERRORS`, `GRAFANA_WATCH_FACTOR`.

The default error filter is `\bERROR\b|Exception`. It is case-sensitive, so `INFO … Error details saved` lines are not
counted.

The bot needs `files:write` for the report.

Tests: `test/grafana-watch.test.ts`.
