# Monthly partitions for the span tables

`web_vitals_spans`, `error_spans`, `ai_traffic_spans` and `link_visits` were
partitioned by `toDate(timestamp)`. At their volume (2 GiB, 45 MiB, 24 MiB and
under 1 MiB) that produced hundreds of partitions of kilobyte parts: on
2026-10-21 `error_spans` had 596 active parts across 495 partitions averaging
77 KiB, `web_vitals_spans` 594 parts across 330 partitions, and
`ai_traffic_spans` 348 parts across 270 partitions. Every insert that spanned a
day boundary created a part per day, each part cascaded through its own merge
chain, and Vector already carried a `throw_on_max_partitions_per_insert_block=0`
workaround for batches that touched more than 100 daily partitions. All four
now use `toYYYYMM(timestamp)`, matching `events` and the other tables.

## Applied to production

Per table, in this order:

1. Create `<table>_v2` from the reference schema under a new Keeper path
   (`analytics_<table>_v2`).
2. Copy every row with an explicit column list, so a column-order difference
   between the live table and the reference cannot misalign the copy.
3. Swap in one `RENAME` (`<table>` to `<table>_daily_old`, `_v2` to `<table>`).
   Grants and the purge's `ALTER DELETE` follow the name.
4. Reconcile rows that arrived in the old table during the copy as an exact
   multiset difference over the last two days (`GROUP BY` every column with
   `+1` for old and `-1` for new, replay `sum > 0` copies). A hash `NOT IN`
   would have dropped legitimately identical rows; `ai_traffic_spans` had 221k
   exact duplicate rows in the previous week.
5. Verify `count()` and `sum(cityHash64(*))` agree between `_daily_old` and the
   new table, then check `system.replicas` on all three nodes.

The `_daily_old` tables are retained for rollback and can be dropped once the
new ones have a few days of clean operation.
