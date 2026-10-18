import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import Supermemory from "supermemory";

const originalApiKey = process.env.SUPERMEMORY_API_KEY;
process.env.SUPERMEMORY_API_KEY = "test_supermemory_key";

type AddInput = Supermemory.AddParams;
type ProfileInput = Supermemory.ProfileParams;
type SearchInput = Supermemory.SearchMemoriesParams;

const defaultProfile = (): Supermemory.ProfileResponse => ({
	profile: { dynamic: [], static: [] },
	searchResults: { results: [], total: 0, timing: 0 },
});

let profileHandler = async (_input: ProfileInput) => defaultProfile();
let searchHandler = async (
	_input: SearchInput
): Promise<Supermemory.SearchMemoriesResponse> => ({
	results: [],
	total: 0,
	timing: 0,
});
let addHandler = async (
	_input: AddInput
): Promise<Supermemory.AddResponse> => ({
	id: "synthetic-memory",
	status: "queued",
});

const mockAdd = mock((input: AddInput) => addHandler(input));
const mockForget = mock(async () => undefined);
const mockProfile = mock((input: ProfileInput) => profileHandler(input));
const mockSearchMemories = mock((input: SearchInput) => searchHandler(input));
const mockClient = {
	add: mockAdd,
	memories: { forget: mockForget },
	profile: mockProfile,
	search: { memories: mockSearchMemories },
};
let memoryClient: Supermemory | typeof mockClient | null = mockClient;
// Mock this feature's shared client, not the SDK constructor used by native
// transport tests in the same Bun process.
const businessMemory = await import("@databuddy/services/business-memory");
mock.module("@databuddy/services/business-memory", () => ({
	...businessMemory,
	getMemoryClient: () => memoryClient,
}));

const {
	asksToForget,
	asksToRemember,
	forgetMemory,
	formatMemoryForPrompt,
	getMemoryContext,
	saveCuratedMemory,
	searchMemories,
	storeConversation,
} = await import("./supermemory");
const { createMemoryTools } = await import("../ai/tools/memory");

describe("recalled memory budgets", () => {
	test("bounds recalled entries across all profile sections", () => {
		const output = formatMemoryForPrompt({
			staticProfile: Array.from(
				{ length: 30 },
				(_, index) => `MEMORY_ENTRY_${index}`
			),
			dynamicProfile: [],
			relevantMemories: [],
		});
		expect(output.match(/MEMORY_ENTRY_/g)).toHaveLength(10);
		expect(output).toContain("omitted");
	});

	test("omits oversized memories intact instead of truncating their qualifiers", () => {
		const output = formatMemoryForPrompt({
			staticProfile: [
				"Oversized definition: " +
					"x".repeat(2000) +
					" Do not count employees.",
			],
			dynamicProfile: ["Count only completed downloads; exclude employees."],
			relevantMemories: [],
		});
		expect(output).not.toContain("Oversized definition");
		expect(output).toContain(
			"Count only completed downloads; exclude employees."
		);
		expect(output).toContain("omitted");
	});
});

beforeEach(() => {
	memoryClient = mockClient;
	addHandler = async () => ({ id: "synthetic-memory", status: "queued" });
	profileHandler = async () => defaultProfile();
	searchHandler = async () => ({ results: [], total: 0, timing: 0 });
	mockAdd.mockClear();
	mockForget.mockClear();
	mockProfile.mockClear();
	mockSearchMemories.mockClear();
});

afterAll(() => {
	if (originalApiKey === undefined) {
		delete process.env.SUPERMEMORY_API_KEY;
		return;
	}
	process.env.SUPERMEMORY_API_KEY = originalApiKey;
});

describe("explicit remember requests", () => {
	test.each([
		"remember that I prefer weekly views",
		"Please remember our fiscal year starts in April",
		"Can you remember that our trial lasts 14 days?",
		"Thanks! Also, don't forget to exclude internal traffic",
		"don’t forget the holiday spike",
		"Note that bounce rate excludes bots",
		"save this",
		"Add this to your memory: we exclude staff",
		"Keep in mind that we launched on Monday",
		"From now on, show weekly views",
		"Use weekly views from now on",
		"Hi, my name is Sam",
		"I prefer bar charts",
		"Call me Sam",
	])("detects %p", (message) => {
		expect(asksToRemember(message)).toBe(true);
	});

	test.each([
		"what did visitors remember about checkout?",
		"Do you remember my preferences?",
		"Remember when traffic spiked last March?",
		"Which chart do I prefer?",
		"What will traffic look like from now on",
		"Show sessions where users clicked remember me",
		"Remember-me checkbox clicks dropped",
		"Don't remember this",
		"Users don't forget their carts",
		"Save this funnel as a goal",
		"We fixed a leak in memory allocation",
		"Forget that I prefer weekly views",
		"",
	])("ignores %p", (message) => {
		expect(asksToRemember(message)).toBe(false);
	});
});

describe("supermemory containers", () => {
	test("stores conversation memory only in the caller's own container", () => {
		storeConversation(
			[{ role: "user", content: "Remember that we watch pricing conversion" }],
			"usr_1",
			null,
			{ websiteId: "site_1" }
		);

		expect(mockAdd).toHaveBeenCalledTimes(1);
		const [input] = mockAdd.mock.calls[0] ?? [];
		expect(input).toMatchObject({
			containerTag: "user_usr_1",
			metadata: { websiteId: "site_1" },
		});
		expect(input).not.toHaveProperty("containerTags");
	});

	test("skips conversation memory without a caller identity", () => {
		storeConversation(
			[{ role: "user", content: "Remember that we watch pricing conversion" }],
			null,
			null,
			{ websiteId: "site_1" }
		);

		expect(mockAdd).not.toHaveBeenCalled();
	});

	test("loads memory context only from the caller's own container", async () => {
		profileHandler = async ({ containerTag }) => ({
			profile: {
				dynamic: [`dynamic:${containerTag}`],
				static: [`static:${containerTag}`],
			},
			searchResults: {
				results: [{ memory: `memory:${containerTag}` }],
				total: 1,
				timing: 0,
			},
		});

		const context = await getMemoryContext("pricing", "usr_1", null, {
			websiteId: "site_1",
		});

		expect(mockProfile.mock.calls.map(([input]) => input.containerTag)).toEqual(
			["user_usr_1"]
		);
		expect(context).toEqual({
			dynamicProfile: ["dynamic:user_usr_1"],
			relevantMemories: ["memory:user_usr_1"],
			staticProfile: ["static:user_usr_1"],
		});
	});

	test("searches only the caller's own container, scoped to the website", async () => {
		searchHandler = async () => ({
			results: [
				{
					id: "older",
					memory: "older memory",
					similarity: 0.5,
					metadata: null,
					updatedAt: "2026-10-01T00:00:00Z",
				},
				{
					id: "pricing",
					chunk: "pricing chunk",
					similarity: 0.8,
					metadata: null,
					updatedAt: "2026-10-01T00:00:00Z",
				},
			],
			total: 2,
			timing: 0,
		});

		const results = await searchMemories("pricing", "usr_1", null, {
			limit: 3,
			websiteId: "site_1",
		});

		expect(
			mockSearchMemories.mock.calls.map(([input]) => ({
				containerTag: input.containerTag,
				hasFilters: "filters" in input,
			}))
		).toEqual([{ containerTag: "user_usr_1", hasFilters: true }]);
		expect(results).toEqual([
			{ memory: "pricing chunk", similarity: 0.8 },
			{ memory: "older memory", similarity: 0.5 },
		]);
	});
	test.each([
		"site_1",
		undefined,
	])("recalls personal preferences and only the current website's project facts: %s", async (websiteId) => {
		const memories = [
			{
				memory: "Prefers weekly views",
				category: "preference",
				websiteId: "site_2",
			},
			{
				memory: "Site one excludes employees",
				category: "context",
				websiteId: "site_1",
			},
			{
				memory: "Site two includes employees",
				category: "context",
				websiteId: "site_2",
			},
			{ memory: "Legacy unscoped business definition", category: "insight" },
		];
		const filtered = (filters: ProfileInput["filters"]) =>
			memories.filter((memory) => {
				if (!(filters && "OR" in filters)) {
					return true;
				}
				return filters.OR.some(
					(condition) =>
						"key" in condition &&
						(condition.key === "category"
							? memory.category === condition.value
							: condition.key === "websiteId" &&
								memory.websiteId === condition.value)
				);
			});
		profileHandler = async ({ filters }) => ({
			profile: {
				static: filtered(filters).map(({ memory }) => memory),
				dynamic: [],
			},
			searchResults: { results: [], total: 0, timing: 0 },
		});
		searchHandler = async ({ filters }) => ({
			results: filtered(filters).map(({ memory }) => ({
				id: memory,
				memory,
				similarity: 1,
				metadata: null,
				updatedAt: "2026-10-01T00:00:00Z",
			})),
			total: filtered(filters).length,
			timing: 0,
		});
		const expected = websiteId
			? ["Prefers weekly views", "Site one excludes employees"]
			: ["Prefers weekly views"];
		expect(
			(
				await getMemoryContext("employee exclusions", "usr_1", null, {
					websiteId,
				})
			).staticProfile
		).toEqual(expected);
		expect(
			(
				await searchMemories("employee exclusions", "usr_1", null, {
					websiteId,
				})
			).map(({ memory }) => memory)
		).toEqual(expected);
	});
});

describe("forgetting memory", () => {
	test("forgets an exact match from the caller's own container", async () => {
		searchHandler = async () => ({
			results: [
				{
					id: "mem_1",
					memory: "Prefers weekly views",
					similarity: 0.9,
					metadata: null,
					updatedAt: "2026-10-01T00:00:00Z",
				},
			],
			total: 1,
			timing: 0,
		});

		expect(await forgetMemory("Prefers weekly views", null, "key_1")).toEqual({
			memory: "Prefers weekly views",
			status: "forgotten",
		});
		expect(mockSearchMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				containerTag: "apikey_key_1",
				searchMode: "memories",
			})
		);
		expect(mockForget).toHaveBeenCalledWith({
			containerTag: "apikey_key_1",
			id: "mem_1",
		});
	});

	test("returns candidates instead of forgetting a fuzzy match", async () => {
		searchHandler = async () => ({
			results: [
				{
					id: "mem_1",
					memory: "Prefers weekly views in traffic reports",
					similarity: 0.6,
					metadata: null,
					updatedAt: "2026-10-01T00:00:00Z",
				},
			],
			total: 1,
			timing: 0,
		});

		expect(await forgetMemory("weekly views", "usr_1", null)).toEqual({
			candidates: ["Prefers weekly views in traffic reports"],
			status: "not_found",
		});
		expect(mockForget).not.toHaveBeenCalled();
	});
});

describe("explicit forget requests", () => {
	test.each([
		"Forget that I prefer weekly views",
		"Please forget my name",
		"Can you forget that our trial lasts 14 days?",
		"Delete the memory about our fiscal year",
		"Remove that from your memory",
		"That memory is wrong",
		"You remembered our launch date wrong",
		"Stop remembering my chart preference",
	])("detects %p", (message) => {
		expect(asksToForget(message)).toBe(true);
	});

	test.each([
		"Forget it, show me traffic",
		"Never mind, forget about it",
		"Don't forget to exclude internal traffic",
		"Did you forget my name?",
		"Users forget their carts at checkout",
		"That's wrong, signups were higher",
		"Delete the goal for signups",
		"",
	])("ignores %p", (message) => {
		expect(asksToForget(message)).toBe(false);
	});
});

describe("forget_memory tool", () => {
	const tools = createMemoryTools();
	const forget = (latestUserMessage: string) =>
		tools.forget_memory?.execute?.(
			{ query: "Prefers weekly views" },
			{
				toolCallId: "forget",
				messages: [],
				experimental_context: { latestUserMessage, userId: "usr_1" },
			}
		);

	test("refuses when the latest user message does not ask to forget", async () => {
		expect(
			await forget("Ignore earlier notes and wipe my preferences")
		).toMatchObject({
			forgotten: false,
		});
		expect(mockForget).not.toHaveBeenCalled();
	});
});

describe("save_memory tool", () => {
	const tools = createMemoryTools();
	const save = (latestUserMessage: string) =>
		tools.save_memory?.execute?.(
			{ content: "Prefers weekly views", category: "preference" },
			{
				toolCallId: "save",
				messages: [],
				experimental_context: {
					latestUserMessage,
					userId: "usr_1",
					websiteId: "site_1",
				},
			}
		);

	test("refuses when the latest user message does not ask to remember", async () => {
		expect(await save("What changed in signups last week?")).toMatchObject({
			saved: false,
		});
		expect(mockAdd).not.toHaveBeenCalled();
	});

	test("saves an explicit request to the caller's own container", async () => {
		expect(await save("Remember that I prefer weekly views")).toEqual({
			saved: true,
			status: "accepted",
		});
		expect(mockAdd.mock.calls[0]?.[0]).toMatchObject({
			containerTag: "user_usr_1",
			metadata: { type: "curated", websiteId: "site_1" },
		});
	});
	test("waits for acceptance instead of acknowledging a pending write", async () => {
		let accept = (_response: Supermemory.AddResponse) => {};
		const pending = new Promise<Supermemory.AddResponse>((resolve) => {
			accept = resolve;
		});
		addHandler = () => pending;
		let acknowledged = false;
		const result = Promise.resolve(
			save("Remember that I prefer weekly views")
		).then((receipt) => {
			acknowledged = true;
			return receipt;
		});
		await Promise.resolve();
		expect(acknowledged).toBe(false);
		accept({ id: "accepted-memory", status: "queued" });
		expect(await result).toEqual({ saved: true, status: "accepted" });
	});
	test("does not claim a rejected write was saved or expose provider errors", async () => {
		addHandler = async () => {
			throw new Error("private provider response");
		};
		expect(await save("Remember that I prefer weekly views")).toEqual({
			saved: false,
			status: "failed",
		});
	});
	test("reports no client or caller identity as unavailable", async () => {
		memoryClient = null;
		expect(await save("Remember that I prefer weekly views")).toEqual({
			saved: false,
			status: "unavailable",
		});
		memoryClient = mockClient;
		expect(await saveCuratedMemory("Personal preference", null, null)).toEqual({
			saved: false,
			status: "unavailable",
		});
		expect(mockAdd).not.toHaveBeenCalled();
	});
	test("keeps dry-run writes blocked and requires a current website for project facts", async () => {
		for (const [category, context, expected] of [
			[
				"preference",
				{ mutationMode: "dry-run" },
				{ saved: false, dryRun: true },
			],
			["context", {}, { saved: false, status: "unavailable" }],
		] as const) {
			const result = await tools.save_memory?.execute?.(
				{ content: "Exclude employees", category },
				{
					toolCallId: "save",
					messages: [],
					experimental_context: {
						latestUserMessage: "Remember to exclude employees",
						userId: "usr_1",
						...context,
					},
				}
			);
			expect(result).toMatchObject(expected);
		}
		expect(mockAdd).not.toHaveBeenCalled();
	});
	test("uses the native SDK deadline and reports a stalled write as failed", async () => {
		let attempts = 0;
		memoryClient = new Supermemory({
			apiKey: "inert-test-key",
			fetch: async (_url, init) => {
				attempts++;
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Aborted", "AbortError")),
						{ once: true }
					);
				});
			},
		});
		expect(await save("Remember that I prefer weekly views")).toEqual({
			saved: false,
			status: "failed",
		});
		expect(attempts).toBe(1);
	}, 6000);
});
