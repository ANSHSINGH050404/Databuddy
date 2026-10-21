-- Compression pass on analytics.events, copying the codec pattern
-- web_vitals_spans already uses. Every column was default LZ4; the string
-- columns compressed about 4x and the three timestamp columns under 2x. Low
-- cardinality dimensions (3 event names, 74 browsers, 25 operating systems,
-- 7 device types, 470 countries, 397 timezones, 532 languages, 1.7k regions
-- over 30 days) become LowCardinality. Key columns only change codec; the
-- type changes run as mutations that rewrite just those columns. Existing
-- parts keep LZ4 for codec-only columns until they merge or an OPTIMIZE
-- rewrites the partition.
-- Replicated table: run on one node without ON CLUSTER; alter_sync = 2 waits
-- for every replica.

ALTER TABLE analytics.events
	MODIFY COLUMN client_id String CODEC(ZSTD(1)),
	MODIFY COLUMN event_name LowCardinality(String) CODEC(ZSTD(1)),
	MODIFY COLUMN anonymous_id String CODEC(ZSTD(1)),
	MODIFY COLUMN time DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
	MODIFY COLUMN session_id String CODEC(ZSTD(1)),
	MODIFY COLUMN referrer Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN url String CODEC(ZSTD(1)),
	MODIFY COLUMN path String CODEC(ZSTD(1)),
	MODIFY COLUMN title Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN ip String CODEC(ZSTD(1)),
	MODIFY COLUMN user_agent String CODEC(ZSTD(1)),
	MODIFY COLUMN browser_name LowCardinality(Nullable(String)) CODEC(ZSTD(1)),
	MODIFY COLUMN browser_version Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN os_name LowCardinality(Nullable(String)) CODEC(ZSTD(1)),
	MODIFY COLUMN os_version Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN device_type LowCardinality(Nullable(String)) CODEC(ZSTD(1)),
	MODIFY COLUMN device_brand Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN device_model Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN viewport_size Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN language LowCardinality(Nullable(String)) CODEC(ZSTD(1)),
	MODIFY COLUMN timezone LowCardinality(Nullable(String)) CODEC(ZSTD(1)),
	MODIFY COLUMN country LowCardinality(Nullable(String)) CODEC(ZSTD(1)),
	MODIFY COLUMN region LowCardinality(Nullable(String)) CODEC(ZSTD(1)),
	MODIFY COLUMN city Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN utm_source Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN utm_medium Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN utm_campaign Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN utm_term Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN utm_content Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN gclid Nullable(String) CODEC(ZSTD(1)),
	MODIFY COLUMN properties String CODEC(ZSTD(1)),
	MODIFY COLUMN created_at DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
	MODIFY COLUMN timestamp DateTime64(3) DEFAULT toDate(time) CODEC(Delta(8), ZSTD(1)),
	MODIFY COLUMN profile_id String DEFAULT '' CODEC(ZSTD(1))
SETTINGS alter_sync = 2, mutations_sync = 2;

-- Recompress the partitions that hold most of the data with the new codecs.
-- Each OPTIMIZE rewrites one partition; run them one at a time.
-- OPTIMIZE TABLE analytics.events PARTITION '202610' FINAL;
-- OPTIMIZE TABLE analytics.events PARTITION '202609' FINAL;
-- ... back to the first partition that is worth the write.
