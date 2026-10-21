CREATE TABLE IF NOT EXISTS analytics.identity_session_pairs
(
	`client_id` String,
	`session_id` String,
	`identity_time` SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
	`last_seen` SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
	`profile_id` String
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/analytics_identity_session_pairs_v4', '{replica}')
ORDER BY (client_id, session_id, profile_id)
SETTINGS index_granularity = 8192
