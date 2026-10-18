import { isToolUIPart, type UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
	AGENT_APPROVAL_TTL_SECONDS,
	claimAgentApprovals,
	createAgentApprovalProposal,
	type AgentApprovalScope,
} from "./agent-approvals";

const now = new Date("2026-10-06T12:00:00Z");
const scope: AgentApprovalScope = {
	actorId: "user-synthetic",
	chatId: "chat-synthetic",
	organizationId: "org-synthetic",
};
const goalInput = {
	website_id: "site-synthetic",
	name: "Successful download",
	type: "EVENT",
	target: "synthetic_download_succeeded",
	filters: [{ field: "country", operator: "eq", value: "NL" }],
	ignore_historical: true,
};
const funnelInput = {
	website_id: "site-synthetic",
	name: "Signup to value",
	steps: [
		{ type: "EVENT", target: "synthetic_signup" },
		{ type: "EVENT", target: "synthetic_download_succeeded" },
	],
};

function pending(input: unknown = goalInput): UIMessage {
	return {
		id: "proposal-synthetic",
		role: "assistant",
		parts: [
			{
				type: "tool-create_goal",
				toolCallId: "call-synthetic",
				state: "approval-requested",
				input,
				approval: { id: "approval-synthetic" },
			},
		],
	};
}

function responded(input: unknown = goalInput, approved = true): UIMessage {
	return {
		...pending(input),
		parts: [
			{
				type: "tool-create_goal",
				toolCallId: "call-synthetic",
				state: "approval-responded",
				input,
				approval: { id: "approval-synthetic", approved },
			},
		],
	};
}

function toolPart(messages: UIMessage[], index = 0) {
	const part = messages.at(-1)?.parts[index];
	if (!(part && isToolUIPart(part))) {
		throw new Error("Expected a synthetic tool part");
	}
	return part;
}

function verify({
	messages = [responded()],
	proposal = createAgentApprovalProposal(scope, [pending()], now),
	requestScope = scope,
	claim = vi.fn(async () => true),
	requestTime = now.getTime(),
}: {
	messages?: UIMessage[];
	proposal?: unknown;
	requestScope?: AgentApprovalScope;
	claim?: (approvalId: string) => Promise<boolean>;
	requestTime?: number;
} = {}) {
	return claimAgentApprovals({
		messages,
		proposal,
		scope: requestScope,
		claim,
		now: requestTime,
	});
}

describe("server-owned conversational approval binding", () => {
	it("accepts the reviewed creation after a cache roundtrip without another confirmation", async () => {
		const proposal = createAgentApprovalProposal(scope, [pending()], now);
		const approved = await verify({
			proposal: JSON.parse(JSON.stringify(proposal)),
		});
		expect(toolPart(approved).state).toBe("approval-responded");
		expect(toolPart(approved).approval?.approved).toBe(true);
		expect(toolPart(approved).input).toEqual(goalInput);
	});

	it.each([
		["website", { ...goalInput, website_id: "other-site" }],
		["goal target", { ...goalInput, target: "different_event" }],
		["filters", { ...goalInput, filters: [] }],
		["historical scope", { ...goalInput, ignore_historical: false }],
	])("denies a changed %s before consuming the approval", async (_name, input) => {
		const claim = vi.fn(async () => true);
		const rejected = await verify({ messages: [responded(input)], claim });
		expect(toolPart(rejected).state).toBe("output-denied");
		expect(toolPart(rejected).approval?.approved).toBe(false);
		expect(toolPart(rejected).approval?.reason).toContain("fresh proposal");
		expect(claim).not.toHaveBeenCalled();
	});

	it("denies reordered funnel steps even though they contain the same events", async () => {
		const source = pending(funnelInput);
		const proposal = createAgentApprovalProposal(scope, [source], now);
		const claim = vi.fn(async () => true);
		const rejected = await verify({
			proposal,
			messages: [
				responded({ ...funnelInput, steps: [...funnelInput.steps].reverse() }),
			],
			claim,
		});
		expect(toolPart(rejected).state).toBe("output-denied");
		expect(claim).not.toHaveBeenCalled();
	});

	it.each([
		["actor", { ...scope, actorId: "other-user" }],
		["API key", { ...scope, actorId: "apikey:other-key" }],
		["organization", { ...scope, organizationId: "other-org" }],
		["chat", { ...scope, chatId: "other-chat" }],
	])("denies the saved proposal in another %s scope", async (_name, requestScope) => {
		const claim = vi.fn(async () => true);
		const rejected = await verify({ requestScope, claim });
		expect(toolPart(rejected).state).toBe("output-denied");
		expect(claim).not.toHaveBeenCalled();
	});

	it.each([
		["missing", null],
		[
			"superseded by a user message",
			createAgentApprovalProposal(
				scope,
				[
					pending(),
					{
						id: "new-user-turn",
						role: "user",
						parts: [{ type: "text", text: "Do something else" }],
					},
				],
				now
			),
		],
		[
			"a newer proposal",
			createAgentApprovalProposal(
				scope,
				[{ ...pending(), id: "new-proposal" }],
				now
			),
		],
		[
			"expired",
			createAgentApprovalProposal(
				scope,
				[pending()],
				new Date(now.getTime() - AGENT_APPROVAL_TTL_SECONDS * 1000)
			),
		],
		[
			"future timestamp",
			createAgentApprovalProposal(
				scope,
				[pending()],
				new Date(now.getTime() + 1000)
			),
		],
	])("denies a %s server proposal without a claim", async (_name, proposal) => {
		const claim = vi.fn(async () => true);
		expect(toolPart(await verify({ proposal, claim })).state).toBe(
			"output-denied"
		);
		expect(claim).not.toHaveBeenCalled();
	});

	it.each([
		["approval id", { approval: { id: "other-approval", approved: true } }],
		["tool call", { toolCallId: "other-call" }],
		["tool type", { type: "tool-delete_goal" }],
	])("denies a changed %s with otherwise identical input", async (_name, change) => {
		const response = responded();
		const messages = [
			{
				...response,
				parts: response.parts.map((part) => ({ ...part, ...change })),
			},
		] as UIMessage[];
		const claim = vi.fn(async () => true);
		expect(toolPart(await verify({ messages, claim })).state).toBe(
			"output-denied"
		);
		expect(claim).not.toHaveBeenCalled();
	});

	it("binds a dynamic tool name as well as its call and input", async () => {
		const source: UIMessage = {
			...pending(),
			parts: [
				{
					type: "dynamic-tool",
					toolName: "create_goal",
					toolCallId: "call-synthetic",
					state: "approval-requested",
					input: goalInput,
					approval: { id: "approval-synthetic" },
				},
			],
		};
		const response: UIMessage = {
			...responded(),
			parts: [
				{
					type: "dynamic-tool",
					toolName: "delete_goal",
					toolCallId: "call-synthetic",
					state: "approval-responded",
					input: goalInput,
					approval: { id: "approval-synthetic", approved: true },
				},
			],
		};
		const claim = vi.fn(async () => true);
		const rejected = await verify({
			proposal: createAgentApprovalProposal(scope, [source], now),
			messages: [response],
			claim,
		});
		expect(toolPart(rejected).state).toBe("output-denied");
		expect(claim).not.toHaveBeenCalled();
	});

	it("leaves a user's denial intact without consuming a claim", async () => {
		const claim = vi.fn(async () => true);
		const denied = await verify({
			messages: [responded(goalInput, false)],
			claim,
		});
		expect(toolPart(denied).approval?.approved).toBe(false);
		expect(claim).not.toHaveBeenCalled();
	});

	it("allows only one approved continuation under concurrent claims and replay", async () => {
		const used = new Set<string>();
		const claim = async (id: string) => {
			if (used.has(id)) {
				return false;
			}
			used.add(id);
			return true;
		};
		const continuations = await Promise.all([
			verify({ claim }),
			verify({ claim }),
		]);
		expect(
			continuations.filter((messages) => toolPart(messages).approval?.approved)
		).toHaveLength(1);
		const replay = await verify({ claim });
		expect(toolPart(replay).state).toBe("output-denied");
		expect(toolPart(replay).approval?.reason).toContain("already used");
	});

	it("does not let a tampered duplicate approval part borrow a reviewed payload match", async () => {
		const response = responded();
		const messages: UIMessage[] = [
			{
				...response,
				parts: [
					...responded({ ...goalInput, target: "unreviewed_event" }).parts,
					...response.parts,
				],
			},
		];
		const claim = vi.fn(async () => true);
		const result = await verify({ messages, claim });
		expect(toolPart(result, 0).state).toBe("output-denied");
		expect(toolPart(result, 1).approval?.approved).toBe(true);
		expect(claim).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the claim store throws and permits a fresh proposal after recovery", async () => {
		const rejected = await verify({
			claim: async () => {
				throw new Error("Synthetic store outage");
			},
		});
		expect(toolPart(rejected).state).toBe("output-denied");
		expect(toolPart(rejected).approval?.approved).toBe(false);
		expect(toolPart(rejected).approval?.reason).toContain(
			"approval store is unavailable"
		);
		expect(toolPart(await verify()).approval?.approved).toBe(true);
	});

	it("keeps only pending approval fields from the latest assistant for API-key persistence", () => {
		const latest = pending();
		latest.parts.push({ type: "text", text: "Internal synthetic explanation" });
		const proposal = createAgentApprovalProposal(
			scope,
			[
				{
					id: "older",
					role: "user",
					parts: [{ type: "text", text: "Older private synthetic history" }],
				},
				latest,
			],
			now
		);
		expect(proposal?.parts).toHaveLength(1);
		const serialized = JSON.stringify(proposal);
		expect(serialized).not.toContain("Internal synthetic explanation");
		expect(serialized).not.toContain("Older private synthetic history");
	});

	it("refuses oversized or excessive pending proposals rather than caching an entire history", () => {
		expect(
			createAgentApprovalProposal(
				scope,
				[pending({ target: "x".repeat(128_001) })],
				now
			)
		).toBeNull();
		const source = pending();
		source.parts = Array.from({ length: 51 }, () => pending().parts[0]!);
		expect(createAgentApprovalProposal(scope, [source], now)).toBeNull();
	});
});
