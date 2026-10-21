-- Repartitions the four daily-partitioned span tables by month. Daily partitions
-- gave these low-volume tables hundreds of partitions of kilobyte parts (error_spans:
-- 596 parts across 495 partitions averaging 77 KiB), so every insert cascaded
-- through merges and every query opened hundreds of parts. Applied to production
-- by recreating each table under a new Keeper path, copying, swapping in one RENAME,
-- and reconciling the rows that arrived during the copy as an exact multiset
-- difference; see 20261021_monthly_partitions.md.

CREATE TABLE IF NOT EXISTS analytics.web_vitals_spans_v2 ON CLUSTER databuddy_cluster
(
	`client_id` String CODEC(ZSTD(1)),
	`anonymous_id` String CODEC(ZSTD(1)),
	`session_id` String CODEC(ZSTD(1)),
	`timestamp` DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
	`path` String CODEC(ZSTD(1)),
	`metric_name` LowCardinality(String) CODEC(ZSTD(1)),
	`metric_value` Float64 CODEC(Gorilla(8), ZSTD(1)),
	`delivery_id` String DEFAULT '' CODEC(ZSTD(1)),
	INDEX idx_session_id session_id TYPE bloom_filter(0.01) GRANULARITY 1,
	INDEX idx_metric_value metric_value TYPE minmax GRANULARITY 1
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/analytics_web_vitals_spans_v2', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (client_id, metric_name, path, timestamp)
SETTINGS index_granularity = 8192;

INSERT INTO analytics.web_vitals_spans_v2 (client_id, anonymous_id, session_id, timestamp, path, metric_name, metric_value, delivery_id)
SELECT client_id, anonymous_id, session_id, timestamp, path, metric_name, metric_value, delivery_id FROM analytics.web_vitals_spans SETTINGS max_execution_time = 0;

RENAME TABLE analytics.web_vitals_spans TO analytics.web_vitals_spans_daily_old, analytics.web_vitals_spans_v2 TO analytics.web_vitals_spans ON CLUSTER databuddy_cluster;

-- Rows that landed in the old table during the copy: exact multiset difference over
-- the last two days, so identical rows (same bot hit twice in one second) survive.
INSERT INTO analytics.web_vitals_spans (client_id, anonymous_id, session_id, timestamp, path, metric_name, metric_value, delivery_id)
SELECT client_id, anonymous_id, session_id, timestamp, path, metric_name, metric_value, delivery_id FROM (
	SELECT client_id, anonymous_id, session_id, timestamp, path, metric_name, metric_value, delivery_id, toUInt32(sum(src)) AS n FROM (
		SELECT client_id, anonymous_id, session_id, timestamp, path, metric_name, metric_value, delivery_id, 1 AS src FROM analytics.web_vitals_spans_daily_old WHERE timestamp >= now() - INTERVAL 2 DAY
		UNION ALL
		SELECT client_id, anonymous_id, session_id, timestamp, path, metric_name, metric_value, delivery_id, -1 AS src FROM analytics.web_vitals_spans WHERE timestamp >= now() - INTERVAL 2 DAY
	) GROUP BY client_id, anonymous_id, session_id, timestamp, path, metric_name, metric_value, delivery_id HAVING sum(src) > 0
) ARRAY JOIN range(n) AS r;

CREATE TABLE IF NOT EXISTS analytics.error_spans_v2 ON CLUSTER databuddy_cluster
(
	`client_id` String CODEC(ZSTD(1)),
	`anonymous_id` String CODEC(ZSTD(1)),
	`session_id` String CODEC(ZSTD(1)),
	`timestamp` DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
	`path` String CODEC(ZSTD(1)),
	`message` String CODEC(ZSTD(1)),
	`filename` Nullable(String) CODEC(ZSTD(1)),
	`lineno` Nullable(Int32) CODEC(ZSTD(1)),
	`colno` Nullable(Int32) CODEC(ZSTD(1)),
	`stack` Nullable(String) CODEC(ZSTD(1)),
	`error_type` LowCardinality(String) CODEC(ZSTD(1)),
	`delivery_id` String DEFAULT '' CODEC(ZSTD(1)),
	INDEX idx_session_id session_id TYPE bloom_filter(0.01) GRANULARITY 1,
	INDEX idx_error_type error_type TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/analytics_error_spans_v2', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (client_id, error_type, path, timestamp)
SETTINGS index_granularity = 8192;

INSERT INTO analytics.error_spans_v2 (client_id, anonymous_id, session_id, timestamp, path, message, filename, lineno, colno, stack, error_type, delivery_id)
SELECT client_id, anonymous_id, session_id, timestamp, path, message, filename, lineno, colno, stack, error_type, delivery_id FROM analytics.error_spans SETTINGS max_execution_time = 0;

RENAME TABLE analytics.error_spans TO analytics.error_spans_daily_old, analytics.error_spans_v2 TO analytics.error_spans ON CLUSTER databuddy_cluster;

-- Rows that landed in the old table during the copy: exact multiset difference over
-- the last two days, so identical rows (same bot hit twice in one second) survive.
INSERT INTO analytics.error_spans (client_id, anonymous_id, session_id, timestamp, path, message, filename, lineno, colno, stack, error_type, delivery_id)
SELECT client_id, anonymous_id, session_id, timestamp, path, message, filename, lineno, colno, stack, error_type, delivery_id FROM (
	SELECT client_id, anonymous_id, session_id, timestamp, path, message, filename, lineno, colno, stack, error_type, delivery_id, toUInt32(sum(src)) AS n FROM (
		SELECT client_id, anonymous_id, session_id, timestamp, path, message, filename, lineno, colno, stack, error_type, delivery_id, 1 AS src FROM analytics.error_spans_daily_old WHERE timestamp >= now() - INTERVAL 2 DAY
		UNION ALL
		SELECT client_id, anonymous_id, session_id, timestamp, path, message, filename, lineno, colno, stack, error_type, delivery_id, -1 AS src FROM analytics.error_spans WHERE timestamp >= now() - INTERVAL 2 DAY
	) GROUP BY client_id, anonymous_id, session_id, timestamp, path, message, filename, lineno, colno, stack, error_type, delivery_id HAVING sum(src) > 0
) ARRAY JOIN range(n) AS r;

CREATE TABLE IF NOT EXISTS analytics.ai_traffic_spans_v2 ON CLUSTER databuddy_cluster
(
	`client_id` String CODEC(ZSTD(1)),
	`timestamp` DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
	`bot_type` LowCardinality(String) CODEC(ZSTD(1)),
	`bot_name` String CODEC(ZSTD(1)),
	`user_agent` String CODEC(ZSTD(1)),
	`path` String CODEC(ZSTD(1)),
	`referrer` Nullable(String) CODEC(ZSTD(1)),
	`agent_id` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
	`agent_purpose` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
	`verification` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
	`source` LowCardinality(String) DEFAULT 'tracker' CODEC(ZSTD(1)),
	`format` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
	`host` LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
	`accept` String DEFAULT '' CODEC(ZSTD(1)),
	`status_code` UInt16 DEFAULT 0 CODEC(ZSTD(1)),
	INDEX idx_client_id client_id TYPE bloom_filter(0.01) GRANULARITY 1,
	INDEX idx_bot_type bot_type TYPE bloom_filter(0.01) GRANULARITY 1,
	INDEX idx_bot_name bot_name TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/analytics_ai_traffic_spans_v2', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (client_id, bot_type, timestamp)
SETTINGS index_granularity = 8192;

INSERT INTO analytics.ai_traffic_spans_v2 (client_id, timestamp, bot_type, bot_name, user_agent, path, referrer, agent_id, agent_purpose, verification, source, format, host, accept, status_code)
SELECT client_id, timestamp, bot_type, bot_name, user_agent, path, referrer, agent_id, agent_purpose, verification, source, format, host, accept, status_code FROM analytics.ai_traffic_spans SETTINGS max_execution_time = 0;

RENAME TABLE analytics.ai_traffic_spans TO analytics.ai_traffic_spans_daily_old, analytics.ai_traffic_spans_v2 TO analytics.ai_traffic_spans ON CLUSTER databuddy_cluster;

-- Rows that landed in the old table during the copy: exact multiset difference over
-- the last two days, so identical rows (same bot hit twice in one second) survive.
INSERT INTO analytics.ai_traffic_spans (client_id, timestamp, bot_type, bot_name, user_agent, path, referrer, agent_id, agent_purpose, verification, source, format, host, accept, status_code)
SELECT client_id, timestamp, bot_type, bot_name, user_agent, path, referrer, agent_id, agent_purpose, verification, source, format, host, accept, status_code FROM (
	SELECT client_id, timestamp, bot_type, bot_name, user_agent, path, referrer, agent_id, agent_purpose, verification, source, format, host, accept, status_code, toUInt32(sum(src)) AS n FROM (
		SELECT client_id, timestamp, bot_type, bot_name, user_agent, path, referrer, agent_id, agent_purpose, verification, source, format, host, accept, status_code, 1 AS src FROM analytics.ai_traffic_spans_daily_old WHERE timestamp >= now() - INTERVAL 2 DAY
		UNION ALL
		SELECT client_id, timestamp, bot_type, bot_name, user_agent, path, referrer, agent_id, agent_purpose, verification, source, format, host, accept, status_code, -1 AS src FROM analytics.ai_traffic_spans WHERE timestamp >= now() - INTERVAL 2 DAY
	) GROUP BY client_id, timestamp, bot_type, bot_name, user_agent, path, referrer, agent_id, agent_purpose, verification, source, format, host, accept, status_code HAVING sum(src) > 0
) ARRAY JOIN range(n) AS r;

CREATE TABLE IF NOT EXISTS analytics.link_visits_v2 ON CLUSTER databuddy_cluster
(
	`id` UUID CODEC(ZSTD(1)),
	`link_id` String CODEC(ZSTD(1)),
	`timestamp` DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
	`referrer` Nullable(String) CODEC(ZSTD(1)),
	`user_agent` Nullable(String) CODEC(ZSTD(1)),
	`ip_hash` String CODEC(ZSTD(1)),
	`country` Nullable(String) CODEC(ZSTD(1)),
	`region` Nullable(String) CODEC(ZSTD(1)),
	`city` Nullable(String) CODEC(ZSTD(1)),
	`browser_name` Nullable(String) CODEC(ZSTD(1)),
	`device_type` Nullable(String) CODEC(ZSTD(1)),
	INDEX idx_link_id link_id TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/analytics_link_visits_v2', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (link_id, timestamp)
SETTINGS index_granularity = 8192;

INSERT INTO analytics.link_visits_v2 (id, link_id, timestamp, referrer, user_agent, ip_hash, country, region, city, browser_name, device_type)
SELECT id, link_id, timestamp, referrer, user_agent, ip_hash, country, region, city, browser_name, device_type FROM analytics.link_visits SETTINGS max_execution_time = 0;

RENAME TABLE analytics.link_visits TO analytics.link_visits_daily_old, analytics.link_visits_v2 TO analytics.link_visits ON CLUSTER databuddy_cluster;

-- Rows that landed in the old table during the copy: exact multiset difference over
-- the last two days, so identical rows (same bot hit twice in one second) survive.
INSERT INTO analytics.link_visits (id, link_id, timestamp, referrer, user_agent, ip_hash, country, region, city, browser_name, device_type)
SELECT id, link_id, timestamp, referrer, user_agent, ip_hash, country, region, city, browser_name, device_type FROM (
	SELECT id, link_id, timestamp, referrer, user_agent, ip_hash, country, region, city, browser_name, device_type, toUInt32(sum(src)) AS n FROM (
		SELECT id, link_id, timestamp, referrer, user_agent, ip_hash, country, region, city, browser_name, device_type, 1 AS src FROM analytics.link_visits_daily_old WHERE timestamp >= now() - INTERVAL 2 DAY
		UNION ALL
		SELECT id, link_id, timestamp, referrer, user_agent, ip_hash, country, region, city, browser_name, device_type, -1 AS src FROM analytics.link_visits WHERE timestamp >= now() - INTERVAL 2 DAY
	) GROUP BY id, link_id, timestamp, referrer, user_agent, ip_hash, country, region, city, browser_name, device_type HAVING sum(src) > 0
) ARRAY JOIN range(n) AS r;
