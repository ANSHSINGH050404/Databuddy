import type { BlockedTrafficInsert } from "@databuddy/db/clickhouse/tables";
import { chQuery } from "@databuddy/db/clickhouse";
import {
	db,
	emailUnsubscribeLinks,
	normalizeEmailNotificationSettings,
	type EmailNotificationSettings,
} from "@databuddy/db";
import { config, dataUrl } from "@databuddy/env/app";
import { BlockedTrafficAlertEmail, render } from "@databuddy/email";
import { redis } from "@databuddy/redis";
import {
	getTrackingBlockOriginHost,
	isActionableTrackingBlockReason,
	isIgnoredTrackingBlockOrigin,
	matchesTrackingBlockIgnoredOrigin,
} from "@databuddy/shared/tracking-blocks";
import { captureError } from "@lib/tracing";
import { log } from "evlog";

let warnedEmailUnconfigured = false;
function warnBlockedTrafficEmailUnconfigured(): void {
	if (warnedEmailUnconfigured) {
		return;
	}
	warnedEmailUnconfigured = true;
	log.warn({
		message:
			"Blocked traffic email alerts disabled: RESEND_API_KEY is not configured",
	});
}

const ALERT_WINDOW_MINUTES = 15;
const BASELINE_MINUTES = 7 * 24 * 60;
const LAST_SEEN_LOOKBACK_DAYS = 8;
const MIN_SILENCE_MINUTES = 30;
const MIN_MISSING_PAGEVIEWS = 10;
const ZERO_TRACKING_BLOCK_THRESHOLD = 3;
const BLOCKED_SPIKE_THRESHOLD = 25;
const SPIKE_MULTIPLIER = 3;
const INCIDENT_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface BlockedTrafficAlertContext {
	organizationId?: string | null;
	ownerId?: string | null;
	websiteDomain?: string | null;
	websiteName?: string | null;
}

interface TrackingHealth {
	baselineEvents: number;
	lastSeen: number;
	silenceMinutes: number;
}

interface PreviousBlockedCountRow {
	previousBlocked: number;
}

export interface BlockedTrafficAlertDecision {
	kind: "blocked_spike" | "tracking_zero";
	severity: "critical" | "warning";
}

function getAlertOrigin(event: BlockedTrafficInsert): string {
	return event.origin?.trim() || "";
}

function getAlertOriginKey(event: BlockedTrafficInsert): string {
	return encodeURIComponent(getAlertOrigin(event) || "missing-origin");
}

function getBlockedTrafficSource(
	event: Pick<BlockedTrafficInsert, "origin" | "referrer">
): string | null {
	return event.origin || event.referrer || null;
}

export function matchesTrackingAlertIgnoredOrigin(
	source: string | null,
	patterns: string[]
): boolean {
	return matchesTrackingBlockIgnoredOrigin(source, patterns);
}

export function shouldIgnoreBlockedTrafficAlertEvent(
	event: Pick<
		BlockedTrafficInsert,
		"block_reason" | "client_id" | "origin" | "referrer"
	>
): boolean {
	if (
		!(event.client_id && isActionableTrackingBlockReason(event.block_reason))
	) {
		return true;
	}

	return isIgnoredTrackingBlockOrigin(getBlockedTrafficSource(event));
}

function buildRecommendedFix(event: BlockedTrafficInsert): string {
	const host = getTrackingBlockOriginHost(event.origin ?? null);
	if (event.block_reason === "origin_not_authorized") {
		return host
			? `Update the website domain to ${host}, or add ${host} under Security → Allowed Origins if this is an additional trusted domain.`
			: "Update the website domain or add the trusted origin under Security → Allowed Origins.";
	}

	if (event.block_reason === "origin_missing") {
		return "Browser requests must include an allowed Origin. For server-side events, use the /track API with an API key instead of the browser ingest endpoint.";
	}

	return "Update the website IP allowlist or remove the restriction if browser traffic should be accepted from dynamic client IPs.";
}

function buildDashboardUrl(clientId: string, reason: string): string {
	const section = reason === "origin_not_authorized" ? "general" : "security";
	return `${config.urls.dashboard}/websites/${clientId}/settings/${section}`;
}

async function incrementWindowCounter(
	event: BlockedTrafficInsert
): Promise<number> {
	const key = `blocked-traffic-alert:count:${event.client_id}:${event.block_reason}:${getAlertOriginKey(event)}`;
	const count = await redis.incr(key);
	if (count === 1) {
		await redis.expire(key, ALERT_WINDOW_MINUTES * 60);
	}
	return count;
}

async function getTrackingHealth(clientId: string): Promise<TrackingHealth> {
	const rows = await chQuery<TrackingHealth>(
		`WITH (
			SELECT max(time)
			FROM analytics.events
			PREWHERE client_id = {clientId:String}
			WHERE event_name = 'screen_view' AND time >= now() - INTERVAL ${LAST_SEEN_LOOKBACK_DAYS} DAY
		) AS last_seen
		SELECT
			toUInt64(toUnixTimestamp(last_seen)) AS lastSeen,
			dateDiff('minute', last_seen, now()) AS silenceMinutes,
			countIf(time > last_seen - INTERVAL ${BASELINE_MINUTES} MINUTE AND time <= last_seen) AS baselineEvents
		FROM analytics.events
		PREWHERE client_id = {clientId:String}
		WHERE event_name = 'screen_view' AND time >= now() - INTERVAL ${LAST_SEEN_LOOKBACK_DAYS * 2} DAY`,
		{ clientId }
	);
	const row = rows[0];
	return {
		baselineEvents: Number(row?.baselineEvents ?? 0),
		lastSeen: Number(row?.lastSeen ?? 0),
		silenceMinutes: Number(row?.silenceMinutes ?? 0),
	};
}

async function getPreviousBlockedCount(
	event: BlockedTrafficInsert
): Promise<number> {
	const rows = await chQuery<PreviousBlockedCountRow>(
		`SELECT count() AS previousBlocked
		FROM analytics.blocked_traffic
		PREWHERE timestamp >= now() - INTERVAL ${ALERT_WINDOW_MINUTES * 2} MINUTE
			AND timestamp < now() - INTERVAL ${ALERT_WINDOW_MINUTES} MINUTE
		WHERE client_id = {clientId:String}
			AND block_reason = {reason:String}
			AND ifNull(origin, '') = {origin:String}`,
		{
			clientId: event.client_id,
			origin: getAlertOrigin(event),
			reason: event.block_reason,
		}
	);
	return rows[0]?.previousBlocked ?? 0;
}

export function expectedMissingPageviews(input: {
	baselineEvents: number;
	silenceMinutes: number;
}): number {
	return (input.baselineEvents * input.silenceMinutes) / BASELINE_MINUTES;
}

export function decideBlockedTrafficAlert(input: {
	baselineEvents: number;
	count: number;
	previousBlocked: number;
	silenceMinutes: number;
}): BlockedTrafficAlertDecision | null {
	if (
		input.count >= ZERO_TRACKING_BLOCK_THRESHOLD &&
		input.silenceMinutes >= MIN_SILENCE_MINUTES &&
		expectedMissingPageviews(input) >= MIN_MISSING_PAGEVIEWS
	) {
		return { kind: "tracking_zero", severity: "critical" };
	}

	const spikeFloor = Math.max(
		BLOCKED_SPIKE_THRESHOLD,
		input.previousBlocked * SPIKE_MULTIPLIER
	);
	if (input.count >= spikeFloor) {
		return { kind: "blocked_spike", severity: "warning" };
	}

	return null;
}

export function shouldEvaluateBlockedTrafficAlert(
	windowBlockedCount: number
): boolean {
	return (
		windowBlockedCount === ZERO_TRACKING_BLOCK_THRESHOLD ||
		windowBlockedCount >= BLOCKED_SPIKE_THRESHOLD
	);
}

export function requireBlockedTrafficEmailApiKey(
	apiKey: string | undefined
): string {
	if (!apiKey) {
		throw new Error("Blocked traffic email delivery is not configured");
	}
	return apiKey;
}

export function blockedTrafficAlertKeys(input: {
	clientId: string;
	kind: BlockedTrafficAlertDecision["kind"];
	lastSeen: number;
}): { incident: string | null; site: string } {
	return {
		incident:
			input.kind === "tracking_zero"
				? `blocked-traffic-alert:incident:${input.clientId}:${input.lastSeen}`
				: null,
		site: `blocked-traffic-alert:site:${input.clientId}:${input.kind}`,
	};
}

async function reserveAlert(
	keys: ReturnType<typeof blockedTrafficAlertKeys>,
	settings: EmailNotificationSettings
): Promise<string[] | null> {
	if (keys.incident && (await redis.exists(keys.incident))) {
		return null;
	}
	const cooldownSeconds = settings.trackingHealth.cooldownMinutes * 60;
	if ((await redis.set(keys.site, "1", "EX", cooldownSeconds, "NX")) !== "OK") {
		return null;
	}
	if (!keys.incident) {
		return [keys.site];
	}
	if (
		(await redis.set(keys.incident, "1", "EX", INCIDENT_TTL_SECONDS, "NX")) !==
		"OK"
	) {
		await redis.del(keys.site);
		return null;
	}
	return [keys.site, keys.incident];
}

async function getOwnerEmail(ownerId: string): Promise<string | null> {
	const row = await db.query.user.findFirst({
		where: { id: ownerId },
		columns: { email: true },
	});
	if (!row?.email) {
		return null;
	}
	return row.email;
}

async function getOrganizationEmailSettings(
	organizationId: string | null | undefined
): Promise<EmailNotificationSettings> {
	if (!organizationId) {
		return normalizeEmailNotificationSettings(null);
	}

	const row = await db.query.organization.findFirst({
		where: { id: organizationId },
		columns: { emailNotifications: true },
	});
	return normalizeEmailNotificationSettings(row?.emailNotifications);
}

function isAlertMutedBySettings(input: {
	decision: BlockedTrafficAlertDecision;
	event: BlockedTrafficInsert;
	settings: EmailNotificationSettings;
}): boolean {
	const tracking = input.settings.trackingHealth;
	if (tracking.mode === "off") {
		return true;
	}
	if (
		tracking.mode === "critical_only" &&
		input.decision.kind !== "tracking_zero"
	) {
		return true;
	}
	if (
		tracking.ignoredReasons.some(
			(reason) => reason === input.event.block_reason
		)
	) {
		return true;
	}
	return matchesTrackingAlertIgnoredOrigin(
		getBlockedTrafficSource(input.event),
		tracking.ignoredOrigins
	);
}

async function sendAlertEmail(input: {
	context: BlockedTrafficAlertContext;
	decision: BlockedTrafficAlertDecision;
	event: BlockedTrafficInsert;
	trackingHealth: TrackingHealth;
	recipientEmail: string;
	previousBlocked: number;
	windowBlockedCount: number;
}): Promise<void> {
	const apiKey = requireBlockedTrafficEmailApiKey(config.services.resendApiKey);

	const siteLabel =
		input.context.websiteName ||
		input.context.websiteDomain ||
		input.event.client_id ||
		"your website";
	const subject =
		input.decision.kind === "tracking_zero"
			? `Tracking stopped for ${siteLabel}`
			: `Blocked tracking increased for ${siteLabel}`;
	const links = input.context.organizationId
		? emailUnsubscribeLinks({
				apiUrl: config.urls.api,
				dashboardUrl: config.urls.dashboard,
				organizationId: input.context.organizationId,
				secret: process.env.DATABUDDY_ENCRYPTION_KEY,
				topic: "tracking-health",
			})
		: null;

	const email = BlockedTrafficAlertEmail({
		baselineEvents: input.trackingHealth.baselineEvents,
		blockReason: input.event.block_reason,
		blockedCount: input.windowBlockedCount,
		dashboardUrl: buildDashboardUrl(
			input.event.client_id || "",
			input.event.block_reason
		),
		fix: buildRecommendedFix(input.event),
		origin: input.event.origin ?? null,
		preferences: links ?? undefined,
		previousBlockedCount: input.previousBlocked,
		severity: input.decision.severity,
		silenceMinutes: input.trackingHealth.silenceMinutes,
		siteLabel,
		windowMinutes: ALERT_WINDOW_MINUTES,
	});
	const [html, text] = await Promise.all([
		render(email),
		render(email, { plainText: true }),
	]);

	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: config.email.alertsFrom,
			to: input.recipientEmail,
			subject,
			html,
			text,
			...(links ? { headers: links.headers } : {}),
		}),
	});

	if (!response.ok) {
		throw new Error(`Resend blocked traffic alert failed: ${response.status}`);
	}
}

async function maybeSendBlockedTrafficAlertAsync(
	event: BlockedTrafficInsert,
	context: BlockedTrafficAlertContext = {}
): Promise<void> {
	if (shouldIgnoreBlockedTrafficAlertEvent(event)) {
		return;
	}
	if (!context.ownerId) {
		return;
	}
	if (!dataUrl("REDIS_URL")) {
		return;
	}

	const windowBlockedCount = await incrementWindowCounter(event);
	if (!shouldEvaluateBlockedTrafficAlert(windowBlockedCount)) {
		return;
	}

	const [trackingHealth, previousBlocked] = await Promise.all([
		getTrackingHealth(event.client_id || ""),
		getPreviousBlockedCount(event),
	]);
	const decision = decideBlockedTrafficAlert({
		baselineEvents: trackingHealth.baselineEvents,
		count: windowBlockedCount,
		previousBlocked,
		silenceMinutes: trackingHealth.silenceMinutes,
	});
	if (!decision) {
		return;
	}

	const settings = await getOrganizationEmailSettings(context.organizationId);
	if (isAlertMutedBySettings({ decision, event, settings })) {
		return;
	}

	const recipientEmail = await getOwnerEmail(context.ownerId);
	if (!recipientEmail) {
		return;
	}

	if (!config.services.resendApiKey) {
		warnBlockedTrafficEmailUnconfigured();
		return;
	}

	const reservedKeys = await reserveAlert(
		blockedTrafficAlertKeys({
			clientId: event.client_id || "",
			kind: decision.kind,
			lastSeen: trackingHealth.lastSeen,
		}),
		settings
	);
	if (!reservedKeys) {
		return;
	}

	try {
		await sendAlertEmail({
			context,
			decision,
			event,
			trackingHealth,
			recipientEmail,
			previousBlocked,
			windowBlockedCount,
		});
	} catch (error) {
		await redis.del(...reservedKeys).catch(() => undefined);
		throw error;
	}
}

export function queueBlockedTrafficAlert(
	event: BlockedTrafficInsert,
	context?: BlockedTrafficAlertContext
): void {
	maybeSendBlockedTrafficAlertAsync(event, context).catch((error) => {
		captureError(error, {
			message: "Failed to evaluate blocked traffic alert",
			...(event.client_id ? { clientId: event.client_id } : {}),
			blockReason: event.block_reason,
		});
	});
}
