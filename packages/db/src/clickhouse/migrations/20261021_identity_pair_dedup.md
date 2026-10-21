# Identity pair map deduplication

The pair maps recreated on 2026-08-31 were plain `ReplicatedMergeTree` targets
fed by four materialized views that emit one row per identified event. By
2026-10-21 `identity_anon_pairs` held 6.3M rows for 127k distinct
`(client_id, anonymous_id, profile_id)` pairs and `identity_session_pairs` 4.2M
rows for 226k pairs. Because both maps fire on every `events` and
`custom_events` insert, each tiny ingest part spawned pair parts that cascaded
through merges: in one eight-minute window node-01 merged away 286
`identity_anon_pairs` parts holding 9.9M rows, more than the whole table, and
the cluster as a whole rewrote about 2 billion rows a day to absorb 5 to 11
million inserted rows.

Both tables are now `ReplicatedAggregatingMergeTree` keyed on the pair, with
`identity_time` as `SimpleAggregateFunction(min, ...)` (first time the pair was
seen) and a new `last_seen` as `SimpleAggregateFunction(max, ...)`. The views
group by the pair inside each insert block and merges fold the rest.

## Reader semantics

`identityPairMapCte` used to select the raw rows whose `identity_time` fell in
the query window and ASOF-join events to the latest identification at or before
the event. It now groups by the pair, keeps pairs whose `[identity_time,
last_seen]` span touches the window, and ASOF-joins on the first time the pair
was seen. For a visitor identified repeatedly as the same profile this is a
superset of the old behaviour: events after the first identification resolve
to the profile even when the next identification inside the window came later.
For a visitor who alternates between two profiles the ASOF now picks the
profile whose first association is the most recent one at or before the event,
instead of the most recent repeat login. The deleted-owner purge scan reads
`last_seen` as the arrival column.

## Applied to production

1. Create both `_v4` tables, backfill them with `GROUP BY` from the live maps.
2. Drop the four views, swap the tables in one `RENAME`, recreate the views
   with the cluster's `mv_definer`, replay a 3 hour delta from `events` and
   `custom_events`.
3. Verify: distinct pair counts equal between old and new, `max(last_seen)`
   advances after the swap, `system.replicas` healthy on all three nodes.

The `_v3_old` tables are retained for rollback and can be dropped once the new
maps have a few days of clean operation.
