import { isDeepStrictEqual } from "node:util";
import { isToolUIPart, type UIMessage } from "ai";
import { z } from "zod";

export const AGENT_APPROVAL_TTL_SECONDS = 86_400;
const MAX_PROPOSAL_BYTES = 128_000;

const scopeSchema = z.object({
	actorId: z.string(),
	chatId: z.string(),
	organizationId: z.string(),
});
export type AgentApprovalScope = z.infer<typeof scopeSchema>;

const pendingPartSchema = z.object({
	approval: z.object({ id: z.string().min(1) }),
	input: z.unknown().refine((input) => input !== undefined),
	state: z.literal("approval-requested"),
	toolCallId: z.string().min(1),
	toolName: z.string().optional(),
	type: z
		.string()
		.refine((type) => type === "dynamic-tool" || type.startsWith("tool-")),
});
const proposalSchema = z.object({
	capturedAt: z.number().finite(),
	messageId: z.string(),
	parts: z.array(pendingPartSchema).max(50),
	scope: scopeSchema,
});

export function createAgentApprovalProposal(
	scope: AgentApprovalScope,
	messages: unknown[],
	capturedAt: Date
) {
	const latest = z
		.object({
			id: z.string(),
			role: z.literal("assistant"),
			parts: z.array(z.unknown()),
		})
		.safeParse(messages.at(-1));
	if (!latest.success) {
		return null;
	}
	const parts = latest.data.parts.flatMap((part) => {
		const parsed = pendingPartSchema.safeParse(part);
		return parsed.success ? [parsed.data] : [];
	});
	const proposal = proposalSchema.safeParse({
		capturedAt: capturedAt.getTime(),
		messageId: latest.data.id,
		parts,
		scope,
	});
	if (!proposal.success || parts.length === 0) {
		return null;
	}
	return Buffer.byteLength(JSON.stringify(proposal.data)) <= MAX_PROPOSAL_BYTES
		? proposal.data
		: null;
}

export async function claimAgentApprovals({
	messages,
	proposal,
	scope,
	claim,
	now = Date.now(),
}: {
	messages: UIMessage[];
	proposal: unknown;
	scope: AgentApprovalScope;
	claim: (approvalId: string) => Promise<boolean>;
	now?: number;
}): Promise<UIMessage[]> {
	const latest = messages.at(-1);
	if (!latest || latest.role !== "assistant") {
		return messages;
	}
	const saved = proposalSchema.safeParse(proposal);
	const current =
		saved.success &&
		isDeepStrictEqual(saved.data.scope, scope) &&
		saved.data.messageId === latest.id &&
		saved.data.capturedAt <= now &&
		now - saved.data.capturedAt < AGENT_APPROVAL_TTL_SECONDS * 1000
			? saved.data
			: null;
	const parts = await Promise.all(
		latest.parts.map(async (part) => {
			if (
				!isToolUIPart(part) ||
				part.state !== "approval-responded" ||
				!part.approval.approved
			) {
				return part;
			}
			const deny = (reason: string): UIMessage["parts"][number] => ({
				...part,
				state: "output-denied",
				approval: { ...part.approval, approved: false, reason },
			});
			const reviewed = current?.parts.some(
				(savedPart) =>
					savedPart.approval.id === part.approval.id &&
					savedPart.toolCallId === part.toolCallId &&
					savedPart.type === part.type &&
					savedPart.toolName ===
						(part.type === "dynamic-tool" ? part.toolName : undefined) &&
					isDeepStrictEqual(savedPart.input, part.input)
			);
			if (!reviewed) {
				return deny(
					"This approval could not be verified against the current saved proposal. No action was run. Request a fresh proposal and review it again."
				);
			}
			try {
				return (await claim(part.approval.id))
					? part
					: deny(
							"This approval was already used. No action was run again. Check the existing result before requesting another proposal."
						);
			} catch {
				return deny(
					"The approval store is unavailable. No action was run. Request a fresh proposal when it is available and review it again."
				);
			}
		})
	);
	return [...messages.slice(0, -1), { ...latest, parts }];
}
