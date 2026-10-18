import { setTimeout as sleep } from "node:timers/promises";
import { and, db, eq, isNull, shutdownPostgres, user } from "@databuddy/db";
import {
	addToMailingList,
	isMailingListEligible,
	MailingListError,
	removeFromMailingList,
	type UsersMailingList,
	usersMailingList,
} from "../mailing-list";

const REQUEST_INTERVAL_MS = 350;
const RATE_LIMIT_BACKOFF_MS = 2000;
const MAX_ATTEMPTS = 4;
const CONCURRENCY = 3;

async function paced<T>(request: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		await sleep(REQUEST_INTERVAL_MS);
		try {
			return await request();
		} catch (error) {
			const rateLimited =
				error instanceof MailingListError &&
				error.code === "rate_limit_exceeded";
			if (!rateLimited || attempt === MAX_ATTEMPTS) {
				throw error;
			}
			await sleep(RATE_LIMIT_BACKOFF_MS * attempt);
		}
	}
}

async function inParallel<T>(
	items: T[],
	work: (item: T) => Promise<void>
): Promise<void> {
	const queue = items.values();
	const worker = async () => {
		for (const item of queue) {
			await work(item);
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function listSegmentEmails({
	resend,
	segmentId,
}: UsersMailingList): Promise<Set<string>> {
	const emails = new Set<string>();
	let after: string | undefined;
	for (;;) {
		const page = await paced(async () => {
			const result = await resend.contacts.list({
				segmentId,
				limit: 100,
				after,
			});
			if (result.error) {
				throw new MailingListError(result.error);
			}
			return result.data;
		});
		for (const contact of page.data) {
			emails.add(contact.email.toLowerCase());
		}
		const last = page.data.at(-1);
		if (!(page.has_more && last)) {
			return emails;
		}
		after = last.id;
	}
}

async function loadEligibleUsers() {
	const rows = await db
		.select({
			email: user.email,
			emailVerified: user.emailVerified,
			firstName: user.firstName,
			lastName: user.lastName,
			name: user.name,
		})
		.from(user)
		.where(
			and(
				eq(user.emailVerified, true),
				eq(user.status, "ACTIVE"),
				isNull(user.deletedAt)
			)
		);
	return new Map(
		rows
			.filter(isMailingListEligible)
			.map((row) => [row.email.toLowerCase(), row])
	);
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");
	const list = usersMailingList();
	if (!list) {
		throw new Error("RESEND_API_KEY and RESEND_USERS_SEGMENT_ID must be set");
	}

	try {
		const [users, members] = await Promise.all([
			loadEligibleUsers(),
			listSegmentEmails(list),
		]);
		const toAdd = [...users.entries()].filter(([email]) => !members.has(email));
		const toRemove = [...members].filter((email) => !users.has(email));
		console.log(
			`eligible users: ${users.size}, segment members: ${members.size}, to add: ${toAdd.length}, to remove: ${toRemove.length}`
		);
		if (dryRun) {
			return;
		}

		const failures = new Map<string, number>();
		const recordFailure = (error: unknown) => {
			const code = error instanceof MailingListError ? error.code : "unknown";
			failures.set(code, (failures.get(code) ?? 0) + 1);
		};

		let processed = 0;
		await inParallel(toAdd, async ([, row]) => {
			await paced(() => addToMailingList(list, row)).catch(recordFailure);
			processed++;
			if (processed % 250 === 0) {
				console.log(`added ${processed}/${toAdd.length}`);
			}
		});
		await inParallel(toRemove, (email) =>
			paced(() => removeFromMailingList(list, email)).catch(recordFailure)
		);

		console.log(
			failures.size === 0
				? "sync complete"
				: `sync finished with failures: ${JSON.stringify(Object.fromEntries(failures))}`
		);
		if (failures.size > 0) {
			process.exitCode = 1;
		}
	} finally {
		await shutdownPostgres();
	}
}

if (import.meta.main) {
	await main();
}
