import { describe, expect, test } from "bun:test";
import { asSchema, type ToolSet } from "ai";
import { createConfig } from "../agents/analytics";
import { createFunnelTools } from "./funnels";
import { createGoalTools } from "./goals";
import { createToolkit, type ToolIntegrations } from "./toolkit";

describe("connected agent tools", () => {
	test("drops unavailable integrations and keeps the full set when they are omitted", () => {
		const names = (integrations?: ToolIntegrations) =>
			Object.keys(
				createToolkit({
					capabilities: ["investigation"],
					integrations,
					organizationId: "org_1",
				})
			);
		const isIntegrationTool = (name: string) =>
			name.startsWith("github_") ||
			["scrape_page", "search_console", "search_website"].includes(name);
		const omitted = names();
		expect(omitted).toEqual(
			expect.arrayContaining([
				"github_commits",
				"github_repos",
				"scrape_page",
				"search_console",
				"search_website",
			])
		);
		expect(names({ github: true, scrape: true, searchConsole: true })).toEqual(
			omitted
		);
		expect(
			names({ github: false, scrape: false, searchConsole: false })
		).toEqual(omitted.filter((name) => !isIntegrationTool(name)));
	});
});

describe("dashboard write approvals", () => {
	test("creation uses one approval while existing confirmed tools retain preview approval", async () => {
		const { tools } = createConfig({
			chatId: "chat_1",
			organizationId: "org_1",
			timezone: "UTC",
			userId: "user_1",
		});
		const options = { toolCallId: "call_1", messages: [] };
		const needsApproval = async (
			definition: ToolSet[string],
			confirmed: boolean
		) =>
			typeof definition.needsApproval === "function"
				? await definition.needsApproval({ confirmed }, options)
				: (definition.needsApproval ?? false);
		const decisions: Array<{
			confirmed: boolean;
			name: string;
			preview: boolean;
		}> = [];
		const legacyCreations: ToolSet = {
			create_goal: createGoalTools().create_goal,
			create_funnel: createFunnelTools().create_funnel,
		};
		for (const [name, legacy] of Object.entries(legacyCreations)) {
			const creation = tools[name];
			if (!creation) {
				throw new Error(`Dashboard tool ${name} is missing`);
			}
			const [creationSchema, legacySchema] = await Promise.all([
				asSchema(creation.inputSchema).jsonSchema,
				asSchema(legacy.inputSchema).jsonSchema,
			]);
			expect(creationSchema.properties).not.toHaveProperty("confirmed");
			expect(legacySchema.properties).toHaveProperty("confirmed");
			expect(await needsApproval(creation, false)).toBe(true);
			expect(await needsApproval(creation, true)).toBe(true);
			expect(await needsApproval(legacy, false)).toBe(false);
			expect(await needsApproval(legacy, true)).toBe(true);
		}
		for (const [name, definition] of Object.entries(tools)) {
			const { properties } = await asSchema(definition.inputSchema).jsonSchema;
			if (properties && "confirmed" in properties) {
				decisions.push({
					name,
					confirmed: await needsApproval(definition, true),
					preview: await needsApproval(definition, false),
				});
			}
		}
		expect(decisions.map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"update_flag",
				"delete_link",
				"delete_annotation",
				"configure_investigations",
			])
		);
		expect(decisions).toEqual(
			decisions.map(({ name }) => ({ name, confirmed: true, preview: false }))
		);
	});
});
