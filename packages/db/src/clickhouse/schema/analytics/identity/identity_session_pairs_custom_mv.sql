CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.identity_session_pairs_custom_mv TO analytics.identity_session_pairs
(
	`client_id` String,
	`session_id` String,
	`identity_time` DateTime64(3, 'UTC'),
	`last_seen` DateTime64(3, 'UTC'),
	`profile_id` String
)
AS SELECT
	arrayJoin(arrayDistinct([owner_id, if((website_id != '') AND (website_id != owner_id), website_id, owner_id)])) AS client_id,
	ifNull(session_id, '') AS session_id,
	min(timestamp) AS identity_time,
	max(timestamp) AS last_seen,
	profile_id
FROM analytics.custom_events
WHERE (profile_id != '') AND (ifNull(session_id, '') != '')
GROUP BY client_id, session_id, profile_id
