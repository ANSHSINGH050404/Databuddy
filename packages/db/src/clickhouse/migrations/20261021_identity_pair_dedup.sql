-- Collapses the identity pair maps to one row per (client, key, profile).
-- The plain MergeTree targets kept a row per identified event: 6.3M rows for
-- 127k distinct anonymous pairs and 4.2M for 226k session pairs, and because
-- both maps fire on every events and custom_events insert they were the single
-- largest source of merge work on the cluster (node-01 rewrote 9.9M pair rows
-- in one eight-minute window). AggregatingMergeTree keeps the first and last
-- time each pair was seen; readers group by the pair, so unmerged duplicates
-- are harmless. Applied to production by recreating the tables, backfilling,
-- swapping in one RENAME and replaying the gap; see
-- 20261021_identity_pair_dedup.md.

CREATE TABLE IF NOT EXISTS analytics.identity_anon_pairs_v4 ON CLUSTER databuddy_cluster
(
	`client_id` String,
	`anonymous_id` String,
	`identity_time` SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
	`last_seen` SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
	`profile_id` String
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/analytics_identity_anon_pairs_v4', '{replica}')
ORDER BY (client_id, anonymous_id, profile_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS analytics.identity_session_pairs_v4 ON CLUSTER databuddy_cluster
(
	`client_id` String,
	`session_id` String,
	`identity_time` SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
	`last_seen` SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
	`profile_id` String
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/analytics_identity_session_pairs_v4', '{replica}')
ORDER BY (client_id, session_id, profile_id)
SETTINGS index_granularity = 8192;

INSERT INTO analytics.identity_anon_pairs_v4 (client_id, anonymous_id, identity_time, last_seen, profile_id)
SELECT client_id, anonymous_id, min(identity_time), max(identity_time), profile_id
FROM analytics.identity_anon_pairs
GROUP BY client_id, anonymous_id, profile_id;

INSERT INTO analytics.identity_session_pairs_v4 (client_id, session_id, identity_time, last_seen, profile_id)
SELECT client_id, session_id, min(identity_time), max(identity_time), profile_id
FROM analytics.identity_session_pairs
GROUP BY client_id, session_id, profile_id;

DROP TABLE IF EXISTS analytics.identity_anon_pairs_events_mv ON CLUSTER databuddy_cluster SYNC;
DROP TABLE IF EXISTS analytics.identity_anon_pairs_custom_mv ON CLUSTER databuddy_cluster SYNC;
DROP TABLE IF EXISTS analytics.identity_session_pairs_events_mv ON CLUSTER databuddy_cluster SYNC;
DROP TABLE IF EXISTS analytics.identity_session_pairs_custom_mv ON CLUSTER databuddy_cluster SYNC;

RENAME TABLE
	analytics.identity_anon_pairs TO analytics.identity_anon_pairs_v3_old,
	analytics.identity_anon_pairs_v4 TO analytics.identity_anon_pairs,
	analytics.identity_session_pairs TO analytics.identity_session_pairs_v3_old,
	analytics.identity_session_pairs_v4 TO analytics.identity_session_pairs
	ON CLUSTER databuddy_cluster;

-- The four maps, as in schema/analytics/identity/*_mv.sql, with the definer the
-- live cluster uses so ingest users keep writing through them.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.identity_anon_pairs_events_mv ON CLUSTER databuddy_cluster TO analytics.identity_anon_pairs
(
	`client_id` String,
	`anonymous_id` String,
	`identity_time` DateTime64(3, 'UTC'),
	`last_seen` DateTime64(3, 'UTC'),
	`profile_id` String
)
DEFINER = mv_definer SQL SECURITY DEFINER
AS SELECT client_id, anonymous_id, min(time) AS identity_time, max(time) AS last_seen, profile_id
FROM analytics.events
WHERE (profile_id != '') AND (anonymous_id != '')
GROUP BY client_id, anonymous_id, profile_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.identity_anon_pairs_custom_mv ON CLUSTER databuddy_cluster TO analytics.identity_anon_pairs
(
	`client_id` String,
	`anonymous_id` String,
	`identity_time` DateTime64(3, 'UTC'),
	`last_seen` DateTime64(3, 'UTC'),
	`profile_id` String
)
DEFINER = mv_definer SQL SECURITY DEFINER
AS SELECT
	arrayJoin(arrayDistinct([owner_id, if((website_id != '') AND (website_id != owner_id), website_id, owner_id)])) AS client_id,
	ifNull(anonymous_id, '') AS anonymous_id,
	min(timestamp) AS identity_time,
	max(timestamp) AS last_seen,
	profile_id
FROM analytics.custom_events
WHERE (profile_id != '') AND (ifNull(anonymous_id, '') != '')
GROUP BY client_id, anonymous_id, profile_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.identity_session_pairs_events_mv ON CLUSTER databuddy_cluster TO analytics.identity_session_pairs
(
	`client_id` String,
	`session_id` String,
	`identity_time` DateTime64(3, 'UTC'),
	`last_seen` DateTime64(3, 'UTC'),
	`profile_id` String
)
DEFINER = mv_definer SQL SECURITY DEFINER
AS SELECT client_id, session_id, min(time) AS identity_time, max(time) AS last_seen, profile_id
FROM analytics.events
WHERE (profile_id != '') AND (session_id != '')
GROUP BY client_id, session_id, profile_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.identity_session_pairs_custom_mv ON CLUSTER databuddy_cluster TO analytics.identity_session_pairs
(
	`client_id` String,
	`session_id` String,
	`identity_time` DateTime64(3, 'UTC'),
	`last_seen` DateTime64(3, 'UTC'),
	`profile_id` String
)
DEFINER = mv_definer SQL SECURITY DEFINER
AS SELECT
	arrayJoin(arrayDistinct([owner_id, if((website_id != '') AND (website_id != owner_id), website_id, owner_id)])) AS client_id,
	ifNull(session_id, '') AS session_id,
	min(timestamp) AS identity_time,
	max(timestamp) AS last_seen,
	profile_id
FROM analytics.custom_events
WHERE (profile_id != '') AND (ifNull(session_id, '') != '')
GROUP BY client_id, session_id, profile_id;

-- Replay the window with no map attached. Re-inserting a pair is harmless:
-- merges fold it into the existing row and readers group by the pair.
INSERT INTO analytics.identity_anon_pairs (client_id, anonymous_id, identity_time, last_seen, profile_id)
SELECT client_id, anonymous_id, min(time), max(time), profile_id FROM analytics.events
WHERE profile_id != '' AND anonymous_id != '' AND time >= now() - INTERVAL 3 HOUR
GROUP BY client_id, anonymous_id, profile_id;

INSERT INTO analytics.identity_session_pairs (client_id, session_id, identity_time, last_seen, profile_id)
SELECT client_id, session_id, min(time), max(time), profile_id FROM analytics.events
WHERE profile_id != '' AND session_id != '' AND time >= now() - INTERVAL 3 HOUR
GROUP BY client_id, session_id, profile_id;

INSERT INTO analytics.identity_anon_pairs (client_id, anonymous_id, identity_time, last_seen, profile_id)
SELECT
	arrayJoin(arrayDistinct([owner_id, if((website_id != '') AND (website_id != owner_id), website_id, owner_id)])) AS client_id,
	ifNull(anonymous_id, '') AS anonymous_id,
	min(timestamp), max(timestamp), profile_id
FROM analytics.custom_events
WHERE profile_id != '' AND ifNull(anonymous_id, '') != '' AND timestamp >= now() - INTERVAL 3 HOUR
GROUP BY client_id, anonymous_id, profile_id;

INSERT INTO analytics.identity_session_pairs (client_id, session_id, identity_time, last_seen, profile_id)
SELECT
	arrayJoin(arrayDistinct([owner_id, if((website_id != '') AND (website_id != owner_id), website_id, owner_id)])) AS client_id,
	ifNull(session_id, '') AS session_id,
	min(timestamp), max(timestamp), profile_id
FROM analytics.custom_events
WHERE profile_id != '' AND ifNull(session_id, '') != '' AND timestamp >= now() - INTERVAL 3 HOUR
GROUP BY client_id, session_id, profile_id;
