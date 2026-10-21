CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.identity_anon_pairs_custom_mv TO analytics.identity_anon_pairs
(
	`client_id` String,
	`anonymous_id` String,
	`identity_time` DateTime64(3, 'UTC'),
	`last_seen` DateTime64(3, 'UTC'),
	`profile_id` String
)
AS SELECT
	arrayJoin(arrayDistinct([owner_id, if((website_id != '') AND (website_id != owner_id), website_id, owner_id)])) AS client_id,
	ifNull(anonymous_id, '') AS anonymous_id,
	min(timestamp) AS identity_time,
	max(timestamp) AS last_seen,
	profile_id
FROM analytics.custom_events
WHERE (profile_id != '') AND (ifNull(anonymous_id, '') != '')
GROUP BY client_id, anonymous_id, profile_id
