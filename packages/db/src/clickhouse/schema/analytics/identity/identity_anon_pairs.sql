CREATE TABLE IF NOT EXISTS analytics.identity_anon_pairs
(
	`client_id` String,
	`anonymous_id` String,
	`identity_time` SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
	`last_seen` SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
	`profile_id` String
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/analytics_identity_anon_pairs_v4', '{replica}')
ORDER BY (client_id, anonymous_id, profile_id)
SETTINGS index_granularity = 8192
