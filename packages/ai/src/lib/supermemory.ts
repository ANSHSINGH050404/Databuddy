import { config } from "@databuddy/env/app";
import { getMemoryClient } from "@databuddy/services/business-memory";
export { getMemoryClient } from "@databuddy/services/business-memory";
import type Supermemory from "supermemory";
import { fenceUntrusted } from "../ai/prompts/context";
import { stripHtmlTags } from "./sanitize";

const MAX_MEMORY_LENGTH = 2000;
const MAX_PROMPT_MEMORIES = 10;
const MEMORY_REQUEST_CLAUSE = /[^.!?;:,\n]+\??/g;
const MEMORY_REQUEST_FILLER =
	/^(?:(?:please|pls|plz|kindly|also|and|but|so|ok|okay|hey|hi|hello|btw|oh|now|just|thanks|thank you|databunny)\b\s*)+/;
const MEMORY_REQUEST_LEAD_IN =
	/^(?:(?:can|could|would|will) you|you (?:can|should|must|need to)|i (?:want|need) you to|i(?:'d| would) like you to|make sure (?:to|you)|be sure to)\s+(?:please\s+)?/;
const QUESTION_START =
	/^(?:what|how|why|when|where|who|whom|whose|which|is|are|am|was|were|will|would|does|did|can|could|should|has|have|had|do(?! not\b))\b/;
const REMEMBER_REQUESTS = [
	/^(?:remember|memori[sz]e)\b(?![\s-]*(?:me|when|what|how|why|where|who|which|whether|if)\b)/,
	/^(?:don't|dont|do not|never) forget\b/,
	/^(?:note (?:that|this|down)|make a note|take note)\b/,
	/^save (?:this|that|it)(?: for (?:later|next time|the future))?$/,
	/^(?:save|store|add|put|keep|commit|write)\b.*\b(?:to|in|into) (?:your |the )?memory\b/,
	/^(?:keep|bear) (?:(?:this|that|it) )?in mind\b/,
	/^my name(?: is|'s)\b/,
	/^(?:i|we)(?:'d| would)? prefer\b/,
	/^call me\b/,
	/\bfrom now on\b/,
];
const FORGET_REQUESTS = [
	/^(?:forget|unlearn)\b(?!\s+(?:about\s+)?it$)/,
	/^stop remembering\b/,
	/^(?:delete|remove|erase|clear|drop|wipe)\b.*\bmemor(?:y|ies)\b/,
	/\bmemor(?:y|ies)\b.*\b(?:is|are|was|were) (?:wrong|incorrect|outdated|stale|out of date|no longer (?:true|right|correct))\b/,
	/^(?:you|you've|you have) (?:remembered|saved|noted|stored)\b.*\b(?:wrong|incorrect|outdated)\b/,
];

export function isMemoryEnabled(): boolean {
	return Boolean(config.services.supermemoryApiKey);
}

export function sanitizeMemoryContent(
	value: string,
	maxLength = MAX_MEMORY_LENGTH
): string {
	return stripHtmlTags(value, maxLength);
}

function asksMemoryRequest(
	message: string,
	requests: readonly RegExp[]
): boolean {
	const clauses =
		message.toLowerCase().replaceAll("’", "'").match(MEMORY_REQUEST_CLAUSE) ??
		[];
	return clauses.some((part) => {
		const question = part.endsWith("?");
		const clause = part
			.replace("?", "")
			.trim()
			.replace(MEMORY_REQUEST_FILLER, "");
		const request = clause.replace(MEMORY_REQUEST_LEAD_IN, "");
		if ((question && request === clause) || QUESTION_START.test(request)) {
			return false;
		}
		return requests.some((pattern) => pattern.test(request));
	});
}

export function asksToRemember(message: string): boolean {
	return asksMemoryRequest(message, REMEMBER_REQUESTS);
}

export function asksToForget(message: string): boolean {
	return asksMemoryRequest(message, FORGET_REQUESTS);
}

function identityContainerTag(
	userId: string | null,
	apiKeyId: string | null
): string | null {
	if (userId) {
		return `user_${userId}`;
	}
	if (apiKeyId) {
		return `apikey_${apiKeyId}`;
	}
	return null;
}

function uniqueNonEmpty(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function recallFilters(
	websiteId?: string
): Supermemory.ProfileParams["filters"] {
	return {
		OR: [
			{ key: "category", value: "preference", filterType: "metadata" },
			...(websiteId
				? [
						{
							key: "websiteId",
							value: websiteId,
							filterType: "metadata" as const,
						},
					]
				: []),
		],
	};
}

export interface MemoryContext {
	dynamicProfile: string[];
	relevantMemories: string[];
	staticProfile: string[];
}

export interface MemorySearchResult {
	memory: string;
	similarity: number;
}

export type ForgetMemoryResult =
	| { status: "failed" }
	| { memory: string; status: "forgotten" }
	| { candidates: string[]; status: "not_found" };

export async function getMemoryContext(
	query: string,
	userId: string | null,
	apiKeyId: string | null,
	options?: { threshold?: number; websiteId?: string }
): Promise<MemoryContext> {
	const client = getMemoryClient();
	const containerTag = identityContainerTag(userId, apiKeyId);
	if (!(client && containerTag)) {
		return { staticProfile: [], dynamicProfile: [], relevantMemories: [] };
	}

	try {
		const profile = await client.profile({
			containerTag,
			filters: recallFilters(options?.websiteId),
			q: query,
			threshold: options?.threshold ?? 0.25,
		});

		const searchResults = (profile.searchResults?.results ?? []) as Array<{
			memory?: string;
			chunk?: string;
		}>;

		return {
			staticProfile: uniqueNonEmpty(profile.profile.static),
			dynamicProfile: uniqueNonEmpty(profile.profile.dynamic),
			relevantMemories: uniqueNonEmpty(
				searchResults.map((r) => r.memory ?? r.chunk ?? "")
			),
		};
	} catch {
		return { staticProfile: [], dynamicProfile: [], relevantMemories: [] };
	}
}

export function storeConversation(
	conversation: Array<{ role: string; content: string }>,
	userId: string | null,
	apiKeyId: string | null,
	options?: {
		metadata?: Record<string, string>;
		websiteId?: string;
		conversationId?: string;
		domain?: string;
	}
): void {
	const client = getMemoryClient();
	const containerTag = identityContainerTag(userId, apiKeyId);
	if (!(client && containerTag)) {
		return;
	}

	client
		.add({
			content: conversation.map((m) => `${m.role}: ${m.content}`).join("\n"),
			containerTag,
			metadata: {
				...(options?.websiteId && { websiteId: options.websiteId }),
				...(options?.conversationId && {
					conversationId: options.conversationId,
				}),
				...options?.metadata,
			},
			entityContext: `Analytics conversation about ${options?.domain ?? "unknown"}. Extract user preferences, KPIs they track, alerts they care about, and recurring questions.`,
		})
		.catch(() => {});
}

export async function saveCuratedMemory(
	content: string,
	userId: string | null,
	apiKeyId: string | null,
	options?: {
		category?: string;
		websiteId?: string;
	}
): Promise<{ saved: boolean; status: "accepted" | "unavailable" | "failed" }> {
	const client = getMemoryClient();
	const containerTag = identityContainerTag(userId, apiKeyId);
	if (!(client && containerTag)) {
		return { saved: false, status: "unavailable" };
	}

	try {
		await client.add(
			{
				content: sanitizeMemoryContent(content),
				containerTag,
				metadata: {
					category: options?.category ?? "insight",
					type: "curated",
					...(options?.websiteId && { websiteId: options.websiteId }),
				},
				entityContext:
					"Curated user insight or preference. Store as a durable fact about this user.",
			},
			{ timeout: 4000, maxRetries: 0 }
		);
		return { saved: true, status: "accepted" };
	} catch {
		return { saved: false, status: "failed" };
	}
}

export async function searchMemories(
	query: string,
	userId: string | null,
	apiKeyId: string | null,
	options?: {
		limit?: number;
		threshold?: number;
		websiteId?: string;
	}
): Promise<MemorySearchResult[]> {
	const client = getMemoryClient();
	const containerTag = identityContainerTag(userId, apiKeyId);
	if (!(client && containerTag)) {
		return [];
	}

	try {
		const { results } = await client.search.memories({
			q: query,
			containerTag,
			searchMode: "hybrid",
			limit: options?.limit ?? 5,
			threshold: options?.threshold ?? 0.4,
			filters: recallFilters(options?.websiteId),
		});

		return results
			.flatMap((r) => {
				const memory = r.memory ?? r.chunk;
				return memory ? [{ memory, similarity: r.similarity }] : [];
			})
			.sort((a, b) => b.similarity - a.similarity);
	} catch {
		return [];
	}
}

export async function forgetMemory(
	memory: string,
	userId: string | null,
	apiKeyId: string | null
): Promise<ForgetMemoryResult> {
	const client = getMemoryClient();
	const containerTag = identityContainerTag(userId, apiKeyId);
	if (!(client && containerTag)) {
		return { candidates: [], status: "not_found" };
	}

	try {
		const { results } = await client.search.memories({
			q: memory,
			containerTag,
			searchMode: "memories",
			limit: 5,
			threshold: 0.3,
		});
		const candidates = results.flatMap((r) =>
			r.memory ? [{ id: r.id, memory: sanitizeMemoryContent(r.memory) }] : []
		);
		const target = sanitizeMemoryContent(memory).trim();
		const match = candidates.find(
			(candidate) => candidate.memory.trim() === target
		);
		if (!match) {
			return {
				candidates: candidates.map((candidate) => candidate.memory),
				status: "not_found",
			};
		}
		await client.memories.forget({ containerTag, id: match.id });
		return { memory: match.memory, status: "forgotten" };
	} catch {
		return { status: "failed" };
	}
}

export function formatMemoryForPrompt(ctx: MemoryContext): string {
	const parts: string[] = [];
	let included = 0;
	let omitted = 0;
	const sections: [string, string[]][] = [
		["User profile", ctx.staticProfile],
		["Recent context", ctx.dynamicProfile],
		["Relevant memories", ctx.relevantMemories],
	];
	for (const [label, values] of sections) {
		const memories: string[] = [];
		for (const value of values) {
			if (!value.trim()) {
				continue;
			}
			if (included >= MAX_PROMPT_MEMORIES || value.length > MAX_MEMORY_LENGTH) {
				omitted += 1;
				continue;
			}
			// Omit oversized records intact: cutting a definition can lose an exclusion.
			const sanitized = sanitizeMemoryContent(value);
			if (sanitized.trim()) {
				memories.push(sanitized);
				included += 1;
			}
		}
		if (memories.length) {
			parts.push(`${label}:\n${memories.join("\n")}`);
		}
	}
	if (omitted) {
		parts.push(
			`${omitted} memories omitted to fit the context budget. This is a partial recall, not evidence that other memories do not exist.`
		);
	}

	if (parts.length === 0) {
		return "";
	}

	return fenceUntrusted("user-memory", parts.join("\n\n"));
}
