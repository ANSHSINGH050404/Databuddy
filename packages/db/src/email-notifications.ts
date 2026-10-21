import { createHmac, timingSafeEqual } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import {
	type EmailAlertMode,
	type OrganizationEmailNotificationSettings,
	organization,
	type TrackingAlertBlockReason,
} from "./drizzle/schema/auth";

export interface EmailNotificationSettings {
	aiAgents: {
		weeklyDigest: boolean;
	};
	billing: {
		usageWarnings: boolean;
	};
	trackingHealth: {
		cooldownMinutes: number;
		ignoredOrigins: string[];
		ignoredReasons: TrackingAlertBlockReason[];
		mode: EmailAlertMode;
	};
	uptime: {
		downEmails: boolean;
		recoveryEmails: boolean;
	};
}

export type EmailNotificationSettingsPatch = {
	[Section in keyof EmailNotificationSettings]?: Partial<
		EmailNotificationSettings[Section]
	>;
};

export function mergeEmailNotificationSettings(
	patch: EmailNotificationSettingsPatch
): SQL {
	const column = organization.emailNotifications;
	const sections = Object.entries(patch).filter(([, fields]) => fields);
	return sql`${column} || jsonb_build_object(${sql.join(
		sections.map(
			([section, fields]) =>
				sql`${section}::text, coalesce(${column} -> ${section}, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb`
		),
		sql`, `
	)})`;
}

export const DEFAULT_EMAIL_NOTIFICATION_SETTINGS = {
	aiAgents: {
		weeklyDigest: true,
	},
	billing: {
		usageWarnings: true,
	},
	trackingHealth: {
		cooldownMinutes: 360,
		ignoredOrigins: [],
		ignoredReasons: [],
		mode: "critical_only",
	},
	uptime: {
		downEmails: true,
		recoveryEmails: true,
	},
} satisfies EmailNotificationSettings;

function uniqueStrings(values: string[] | undefined): string[] {
	return [...new Set(values ?? [])];
}

function uniqueReasons(
	values: TrackingAlertBlockReason[] | undefined
): TrackingAlertBlockReason[] {
	return [...new Set(values ?? [])];
}

function clampCooldown(minutes: number | undefined): number {
	if (!Number.isFinite(minutes)) {
		return DEFAULT_EMAIL_NOTIFICATION_SETTINGS.trackingHealth.cooldownMinutes;
	}
	return Math.min(Math.max(Math.round(minutes ?? 360), 15), 7 * 24 * 60);
}

export function normalizeEmailNotificationSettings(
	settings: OrganizationEmailNotificationSettings | null | undefined
): EmailNotificationSettings {
	const current = settings ?? {};
	return {
		aiAgents: {
			...DEFAULT_EMAIL_NOTIFICATION_SETTINGS.aiAgents,
			...current.aiAgents,
		},
		billing: {
			...DEFAULT_EMAIL_NOTIFICATION_SETTINGS.billing,
			...current.billing,
		},
		trackingHealth: {
			...DEFAULT_EMAIL_NOTIFICATION_SETTINGS.trackingHealth,
			...current.trackingHealth,
			cooldownMinutes: clampCooldown(current.trackingHealth?.cooldownMinutes),
			ignoredOrigins: uniqueStrings(current.trackingHealth?.ignoredOrigins),
			ignoredReasons: uniqueReasons(current.trackingHealth?.ignoredReasons),
		},
		uptime: {
			...DEFAULT_EMAIL_NOTIFICATION_SETTINGS.uptime,
			...current.uptime,
		},
	};
}

export const EMAIL_UNSUBSCRIBE_TOPICS = {
	"ai-digest": { aiAgents: { weeklyDigest: false } },
	"tracking-health": { trackingHealth: { mode: "off" } },
	"usage-warnings": { billing: { usageWarnings: false } },
} as const satisfies Record<string, EmailNotificationSettingsPatch>;

export type EmailUnsubscribeTopic = keyof typeof EMAIL_UNSUBSCRIBE_TOPICS;

export function emailUnsubscribeToken(
	topic: EmailUnsubscribeTopic,
	organizationId: string,
	secret: string
): string {
	return createHmac("sha256", secret)
		.update(`${topic}-unsubscribe:${organizationId}`)
		.digest("base64url");
}

export function aiDigestUnsubscribeToken(
	organizationId: string,
	secret: string
): string {
	return emailUnsubscribeToken("ai-digest", organizationId, secret);
}

export function isEmailUnsubscribeToken(
	topic: EmailUnsubscribeTopic,
	organizationId: string,
	token: string,
	secret: string
): boolean {
	const expected = Buffer.from(
		emailUnsubscribeToken(topic, organizationId, secret)
	);
	const actual = Buffer.from(token);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface EmailUnsubscribeLinks {
	headers: Record<string, string>;
	settingsUrl: string;
	unsubscribeUrl: string | null;
}

export function emailUnsubscribeLinks(input: {
	apiUrl: string;
	dashboardUrl: string;
	organizationId: string;
	secret: string | undefined;
	topic: EmailUnsubscribeTopic;
}): EmailUnsubscribeLinks {
	const settings = new URL("/settings/notifications", input.dashboardUrl);
	settings.searchParams.set("organization", input.organizationId);
	const settingsUrl = settings.toString();

	const url = new URL(
		`/public/v1/email-unsubscribe/${input.topic}`,
		input.apiUrl
	);
	if (!input.secret || url.protocol !== "https:") {
		return {
			headers: { "List-Unsubscribe": `<${settingsUrl}>` },
			settingsUrl,
			unsubscribeUrl: null,
		};
	}
	url.searchParams.set("organization", input.organizationId);
	url.searchParams.set(
		"token",
		emailUnsubscribeToken(input.topic, input.organizationId, input.secret)
	);
	const unsubscribeUrl = url.toString();
	return {
		headers: {
			"List-Unsubscribe": `<${unsubscribeUrl}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
		settingsUrl,
		unsubscribeUrl,
	};
}
