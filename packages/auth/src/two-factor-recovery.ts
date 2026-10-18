import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveCname, resolveTxt } from "node:dns/promises";
import { and, db, desc, eq, gt, inArray, isNull } from "@databuddy/db";
import {
	auditEvents,
	member,
	oauthAccessToken,
	oauthRefreshToken,
	session,
	twoFactor,
	user,
	websites,
} from "@databuddy/db/schema";
import { SecurityChangeEmail, securityChangeSubject } from "@databuddy/email";
import { config } from "@databuddy/env/app";
import { appendAuditEvent } from "@databuddy/services/audit";
import { auditActions } from "@databuddy/shared/audit";
import {
	auth,
	revokeTrustedDevices,
	sendAuthEmail,
	signOutEverywhere,
} from "./auth";

const HOUR_MS = 60 * 60 * 1000;
export const RECOVERY_WAITING_PERIOD_MS = 48 * HOUR_MS;
export const RECOVERY_EXPIRY_MS = 7 * 24 * HOUR_MS;
export const DOMAIN_SETTLED_MS = 30 * 24 * HOUR_MS;
export const RECOVERY_RECORD_PREFIX = "_databuddy-recovery";
const RECORD_VALUE_PREFIX = "databuddy-recovery=";
const DOMAIN_ACTIONS = [
	auditActions.WEBSITE_CREATED.action,
	auditActions.WEBSITE_UPDATED.action,
	auditActions.WEBSITE_TRANSFERRED.action,
];

export class RecoveryRefused extends Error {}

export interface RecoveryAccount {
	email: string;
	enrollmentId: string | null;
	ownedOrganizationIds: string[];
	twoFactorEnabled: boolean;
	userId: string;
}

export interface RecoveryRequest {
	account: RecoveryAccount;
	approvedBy?: string;
	domain: string | null;
	operator: string;
	ticket: string;
}

export type TxtResolver = (hostname: string) => Promise<string[][]>;
export type CnameResolver = (hostname: string) => Promise<string[]>;

const TRAILING_DOT = /\.$/;

export function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(TRAILING_DOT, "");
}

export function recoveryRecordName(domain: string): string {
	return `${RECOVERY_RECORD_PREFIX}.${normalizeDomain(domain)}`;
}

export async function findRecoveryAccount(
	email: string
): Promise<RecoveryAccount | null> {
	const found = await db.query.user.findFirst({
		where: { email: email.trim().toLowerCase() },
		columns: { id: true, email: true, twoFactorEnabled: true },
	});
	if (!found) {
		return null;
	}
	const enrollment = await db.query.twoFactor.findFirst({
		where: { userId: found.id },
		columns: { id: true },
	});
	const owned = await db
		.select({ organizationId: member.organizationId })
		.from(member)
		.where(and(eq(member.userId, found.id), eq(member.role, "owner")));
	return {
		email: found.email,
		enrollmentId: enrollment?.id ?? null,
		ownedOrganizationIds: owned.map(({ organizationId }) => organizationId),
		twoFactorEnabled: found.twoFactorEnabled === true,
		userId: found.id,
	};
}

async function sign(
	request: RecoveryRequest,
	issuedAt: number
): Promise<string> {
	const { secret } = await auth.$context;
	return createHmac("sha256", secret)
		.update(
			[
				"two-factor-recovery",
				request.account.userId,
				request.account.enrollmentId,
				request.ticket,
				request.domain ?? "no-website",
				issuedAt,
			].join(":")
		)
		.digest("hex")
		.slice(0, 32);
}

async function tokenFor(
	request: RecoveryRequest,
	issuedAt: number
): Promise<string> {
	return `${issuedAt.toString(36)}.${await sign(request, issuedAt)}`;
}

async function issuedAtOf(
	request: RecoveryRequest,
	token: string
): Promise<number | null> {
	const [issued, signature] = token.split(".");
	const issuedAt = Number.parseInt(issued ?? "", 36);
	if (!(signature && Number.isFinite(issuedAt))) {
		return null;
	}
	const expected = Buffer.from(await sign(request, issuedAt));
	const received = Buffer.from(signature);
	return expected.length === received.length &&
		timingSafeEqual(expected, received)
		? issuedAt
		: null;
}

// A co-member who can edit websites must not be able to point one at a domain
// they control, so only a domain this user set at least 30 days ago counts.
async function assertEligibleDomain(
	account: RecoveryAccount,
	domain: string,
	now: Date
): Promise<void> {
	if (account.ownedOrganizationIds.length === 0) {
		throw new RecoveryRefused("The account owns no organizations.");
	}
	const candidates = await db
		.select({
			id: websites.id,
			domain: websites.domain,
			createdAt: websites.createdAt,
		})
		.from(websites)
		.where(
			and(
				inArray(websites.organizationId, account.ownedOrganizationIds),
				isNull(websites.deletedAt)
			)
		);
	const website = candidates.find(
		(candidate) => normalizeDomain(candidate.domain) === normalizeDomain(domain)
	);
	if (!website) {
		throw new RecoveryRefused(
			"That domain is not a website in an organization this account owns."
		);
	}
	const settledBefore = new Date(now.getTime() - DOMAIN_SETTLED_MS);
	const [lastChange] = await db
		.select({
			actorId: auditEvents.actorId,
			actorType: auditEvents.actorType,
			createdAt: auditEvents.createdAt,
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.targetId, website.id),
				inArray(auditEvents.action, DOMAIN_ACTIONS)
			)
		)
		.orderBy(desc(auditEvents.createdAt))
		.limit(1);
	const setAt = lastChange?.createdAt ?? website.createdAt;
	if (setAt > settledBefore) {
		throw new RecoveryRefused(
			"That website's domain changed in the last 30 days, so it cannot prove ownership."
		);
	}
	if (
		lastChange &&
		!(lastChange.actorType === "user" && lastChange.actorId === account.userId)
	) {
		throw new RecoveryRefused(
			"Someone other than this account set that website's domain, so it cannot prove ownership."
		);
	}
}

async function assertRecoverable(
	request: RecoveryRequest,
	now: Date
): Promise<void> {
	const { account } = request;
	if (!(account.twoFactorEnabled && account.enrollmentId)) {
		throw new RecoveryRefused(
			"This account does not have two-factor authentication turned on."
		);
	}
	if (!(request.operator.trim() && request.ticket.trim())) {
		throw new RecoveryRefused(
			"Recovery needs an operator and a support ticket."
		);
	}
	const [live] = await db
		.select({ id: session.id })
		.from(session)
		.where(
			and(
				eq(session.userId, account.userId),
				gt(session.expiresAt, now.toISOString())
			)
		)
		.limit(1);
	if (live) {
		throw new RecoveryRefused(
			"The account is still signed in somewhere. The owner can turn two-factor off in Settings → Account instead, and signing in cancels any open request."
		);
	}
	if (request.domain) {
		await assertEligibleDomain(account, request.domain, now);
		return;
	}
	if (!request.approvedBy?.trim() || request.approvedBy === request.operator) {
		throw new RecoveryRefused(
			"Recovery without a website needs approval from a second operator."
		);
	}
	const [anyWebsite] = account.ownedOrganizationIds.length
		? await db
				.select({ id: websites.id })
				.from(websites)
				.where(
					and(
						inArray(websites.organizationId, account.ownedOrganizationIds),
						isNull(websites.deletedAt)
					)
				)
				.limit(1)
		: [];
	if (anyWebsite) {
		throw new RecoveryRefused(
			"The account owns websites, so recovery has to use one of them."
		);
	}
}

async function recordAudit(
	request: RecoveryRequest,
	action:
		| typeof auditActions.TWO_FACTOR_RECOVERY_REQUESTED
		| typeof auditActions.TWO_FACTOR_RECOVERED,
	outcome: "success" | "failure",
	reason: string,
	database: Parameters<typeof appendAuditEvent>[0] = db
): Promise<void> {
	for (const organizationId of request.account.ownedOrganizationIds) {
		await appendAuditEvent(database, organizationId, {
			action,
			actor: {
				type: "system",
				id: `support:${request.operator}`,
				displayName: request.operator,
			},
			outcome,
			reason,
			metadata: {
				ticket: request.ticket,
				domain: request.domain,
				approvedBy: request.approvedBy ?? null,
			},
			source: "better_auth",
			target: {
				id: request.account.userId,
				displayName: request.account.email,
			},
		});
	}
}

async function refuseWithAudit(
	request: RecoveryRequest,
	action:
		| typeof auditActions.TWO_FACTOR_RECOVERY_REQUESTED
		| typeof auditActions.TWO_FACTOR_RECOVERED,
	check: () => Promise<void>
): Promise<void> {
	try {
		await check();
	} catch (error) {
		if (error instanceof RecoveryRefused) {
			await recordAudit(request, action, "failure", error.message);
		}
		throw error;
	}
}

async function notify(
	email: string,
	change: "two_factor_recovery_requested" | "two_factor_recovered"
): Promise<boolean> {
	try {
		await sendAuthEmail({
			to: email,
			subject: securityChangeSubject(change),
			template: SecurityChangeEmail({
				change,
				settingsUrl: `${config.urls.dashboard}/settings/account`,
			}),
		});
		return true;
	} catch {
		return false;
	}
}

export async function openRecovery(
	request: RecoveryRequest,
	now = new Date()
): Promise<{
	notified: boolean;
	recordName: string | null;
	recordValue: string;
	readyAt: Date;
	expiresAt: Date;
}> {
	await refuseWithAudit(
		request,
		auditActions.TWO_FACTOR_RECOVERY_REQUESTED,
		() => assertRecoverable(request, now)
	);
	const issuedAt = now.getTime();
	await recordAudit(
		request,
		auditActions.TWO_FACTOR_RECOVERY_REQUESTED,
		"success",
		`ticket ${request.ticket}`
	);
	return {
		notified: await notify(
			request.account.email,
			"two_factor_recovery_requested"
		),
		recordName: request.domain ? recoveryRecordName(request.domain) : null,
		recordValue: `${RECORD_VALUE_PREFIX}${await tokenFor(request, issuedAt)}`,
		readyAt: new Date(issuedAt + RECOVERY_WAITING_PERIOD_MS),
		expiresAt: new Date(issuedAt + RECOVERY_EXPIRY_MS),
	};
}

async function publishedToken(
	domain: string,
	resolveText: TxtResolver,
	resolveAlias: CnameResolver
): Promise<string | null> {
	const name = recoveryRecordName(domain);
	const aliases = await resolveAlias(name).catch(() => []);
	if (aliases.length > 0) {
		throw new RecoveryRefused(
			`${name} is a CNAME. The TXT record must be published on the domain itself.`
		);
	}
	const records = await resolveText(name).catch(() => []);
	const values = records
		.map((chunks) => chunks.join(""))
		.filter((value) => value.startsWith(RECORD_VALUE_PREFIX));
	return values.length === 1
		? (values[0]?.slice(RECORD_VALUE_PREFIX.length) ?? null)
		: null;
}

export async function completeRecovery(
	request: RecoveryRequest & { token?: string },
	options: {
		now?: Date;
		resolveText?: TxtResolver;
		resolveAlias?: CnameResolver;
	} = {}
): Promise<{ notified: boolean }> {
	const now = options.now ?? new Date();
	await refuseWithAudit(
		request,
		auditActions.TWO_FACTOR_RECOVERED,
		async () => {
			await assertRecoverable(request, now);
			const token = request.domain
				? await publishedToken(
						request.domain,
						options.resolveText ?? resolveTxt,
						options.resolveAlias ?? resolveCname
					)
				: (request.token ?? null);
			const issuedAt = token ? await issuedAtOf(request, token) : null;
			if (issuedAt === null) {
				throw new RecoveryRefused(
					request.domain
						? `${recoveryRecordName(request.domain)} does not hold a valid record for this request.`
						: "That request token is not valid for this account and ticket."
				);
			}
			const age = now.getTime() - issuedAt;
			if (age < RECOVERY_WAITING_PERIOD_MS) {
				throw new RecoveryRefused(
					`The waiting period ends at ${new Date(issuedAt + RECOVERY_WAITING_PERIOD_MS).toISOString()}.`
				);
			}
			if (age > RECOVERY_EXPIRY_MS) {
				throw new RecoveryRefused("This request expired. Open a new one.");
			}
		}
	);

	const { account } = request;
	await db.transaction(async (tx) => {
		await tx.delete(twoFactor).where(eq(twoFactor.userId, account.userId));
		await tx
			.update(user)
			.set({ twoFactorEnabled: false })
			.where(eq(user.id, account.userId));
		await tx
			.delete(oauthRefreshToken)
			.where(eq(oauthRefreshToken.userId, account.userId));
		await tx
			.delete(oauthAccessToken)
			.where(eq(oauthAccessToken.userId, account.userId));
		await recordAudit(
			request,
			auditActions.TWO_FACTOR_RECOVERED,
			"success",
			request.domain
				? `ticket ${request.ticket}; proved control of ${normalizeDomain(request.domain)}`
				: `ticket ${request.ticket}; no website, approved by ${request.approvedBy}`,
			tx
		);
	});
	const { internalAdapter } = await auth.$context;
	await signOutEverywhere(internalAdapter, account.userId);
	await revokeTrustedDevices(account.userId);
	return { notified: await notify(account.email, "two_factor_recovered") };
}
