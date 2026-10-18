import { parseArgs } from "node:util";
import { shutdownPostgres } from "@databuddy/db";
import {
	completeRecovery,
	findRecoveryAccount,
	openRecovery,
	RecoveryRefused,
	type RecoveryRequest,
} from "../two-factor-recovery";

const USAGE = `Usage:
  bun run two-factor:recover open --email <email> --ticket <id> --operator <name> --domain <domain>
  bun run two-factor:recover complete --email <email> --ticket <id> --operator <name> --domain <domain>

Without a website (only when the account owns none):
  bun run two-factor:recover open --email <email> --ticket <id> --operator <name> --approved-by <second operator>
  bun run two-factor:recover complete --email <email> --ticket <id> --operator <name> --approved-by <second operator> --token <token from open>`;

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			email: { type: "string" },
			ticket: { type: "string" },
			operator: { type: "string" },
			domain: { type: "string" },
			"approved-by": { type: "string" },
			token: { type: "string" },
		},
	});
	const [command] = positionals;
	if (
		!(
			(command === "open" || command === "complete") &&
			values.email &&
			values.ticket &&
			values.operator &&
			(values.domain || values["approved-by"])
		)
	) {
		console.log(USAGE);
		process.exitCode = 1;
		return;
	}

	const account = await findRecoveryAccount(values.email);
	if (!account) {
		throw new RecoveryRefused("No account uses that email address.");
	}
	const request: RecoveryRequest = {
		account,
		approvedBy: values["approved-by"],
		domain: values.domain ?? null,
		operator: values.operator,
		ticket: values.ticket,
	};

	if (command === "open") {
		const opened = await openRecovery(request);
		console.log(
			opened.recordName
				? `Ask the owner to publish this TXT record:\n  ${opened.recordName}  "${opened.recordValue}"`
				: `Keep this token for the complete step:\n  ${opened.recordValue}`
		);
		console.log(
			`Run complete between ${opened.readyAt.toISOString()} and ${opened.expiresAt.toISOString()}.`
		);
		if (!opened.notified) {
			console.log("The owner could not be emailed about this request.");
		}
		return;
	}

	const { notified } = await completeRecovery({
		...request,
		token: values.token?.replace("databuddy-recovery=", ""),
	});
	console.log(
		"Two-factor authentication is off. Sessions, trusted devices, and connected app tokens were revoked."
	);
	if (!notified) {
		console.log(
			"The owner could not be emailed. Tell them directly that recovery is complete."
		);
	}
}

try {
	await main();
} catch (error) {
	console.error(
		error instanceof RecoveryRefused
			? `Refused: ${error.message}`
			: error instanceof Error
				? error.message
				: error
	);
	process.exitCode = 1;
} finally {
	await shutdownPostgres();
	process.exit();
}
