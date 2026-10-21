CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.identity_session_pairs_events_mv TO analytics.identity_session_pairs
(
	`client_id` String,
	`session_id` String,
	`identity_time` DateTime64(3, 'UTC'),
	`last_seen` DateTime64(3, 'UTC'),
	`profile_id` String
)
AS SELECT
	client_id,
	session_id,
	min(time) AS identity_time,
	max(time) AS last_seen,
	profile_id
FROM analytics.events
WHERE (profile_id != '') AND (session_id != '')
GROUP BY client_id, session_id, profile_id
