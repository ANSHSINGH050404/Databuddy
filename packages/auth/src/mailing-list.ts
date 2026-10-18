import { config } from "@databuddy/env/app";
import { log } from "evlog";
import { type ErrorResponse, Resend } from "resend";

const DISPOSABLE_EMAIL_DOMAINS = new Set([
	"10minutemail.com",
	"guerrillamail.com",
	"mailinator.com",
	"sharklasers.com",
	"tempmail.cn",
	"tempmail.sbs",
	"yopmail.com",
]);

const NAME_PART_SPLIT_RE = /\s+/;

export interface MailingListUser {
	email: string;
	emailVerified: boolean;
	firstName?: string | null;
	lastName?: string | null;
	name: string;
}

export class MailingListError extends Error {
	readonly code: ErrorResponse["name"];

	constructor(error: ErrorResponse) {
		super(error.message);
		this.code = error.name;
	}
}

export function isMailingListEligible(user: MailingListUser): boolean {
	const domain = user.email.split("@").at(-1)?.toLowerCase();
	return (
		user.emailVerified &&
		Boolean(domain) &&
		!DISPOSABLE_EMAIL_DOMAINS.has(domain ?? "")
	);
}

export function usersMailingList() {
	const { resendApiKey, resendUsersSegmentId } = config.services;
	if (!(resendApiKey && resendUsersSegmentId)) {
		return null;
	}
	return { resend: new Resend(resendApiKey), segmentId: resendUsersSegmentId };
}

type UsersMailingList = NonNullable<ReturnType<typeof usersMailingList>>;

export async function addToMailingList(
	{ resend, segmentId }: UsersMailingList,
	user: MailingListUser
): Promise<void> {
	const added = await resend.contacts.segments.add({
		email: user.email,
		segmentId,
	});
	if (!added.error) {
		return;
	}
	if (added.error.name !== "not_found") {
		throw new MailingListError(added.error);
	}

	// Creating an existing contact resets its unsubscribe flag, so create only
	// after the segment add proves the contact does not exist.
	const [nameFirst, ...nameRest] = user.name.trim().split(NAME_PART_SPLIT_RE);
	const created = await resend.contacts.create({
		email: user.email,
		firstName: user.firstName?.trim() || nameFirst || undefined,
		lastName: user.lastName?.trim() || nameRest.join(" ") || undefined,
		segments: [{ id: segmentId }],
	});
	if (created.error) {
		throw new MailingListError(created.error);
	}
}

export async function removeFromMailingList(
	{ resend, segmentId }: UsersMailingList,
	email: string
): Promise<void> {
	const removed = await resend.contacts.segments.remove({ email, segmentId });
	if (removed.error && removed.error.name !== "not_found") {
		throw new MailingListError(removed.error);
	}
}

function logSyncFailure(action: string, error: unknown) {
	log.warn({
		service: "auth",
		mailing_list_sync_failed: action,
		error: error instanceof Error ? error.message : String(error),
	});
}

export function syncUserToMailingList(user: MailingListUser): void {
	const list = usersMailingList();
	if (!(list && isMailingListEligible(user))) {
		return;
	}
	addToMailingList(list, user).catch((error) => logSyncFailure("add", error));
}

export function dropUserFromMailingList(email: string): void {
	const list = usersMailingList();
	if (!list) {
		return;
	}
	removeFromMailingList(list, email).catch((error) =>
		logSyncFailure("remove", error)
	);
}
