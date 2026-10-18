import { TraitFilterError } from "@databuddy/services/identity";
import { captureError } from "../../lib/tracing";
import { tool } from "ai";
import { z } from "zod";
import { getWebsiteDomain } from "../../lib/website-utils";
import {
	executeQuery,
	publicQueryErrorMessage,
	getQueryBuilder,
	QueryBuilders,
	queryPlanGateError,
	SANITIZED_QUERY_ERROR,
	WEBSITE_QUERY_TYPES,
} from "../../query";
import { DatePresets, resolveDatePreset } from "../../lib/date-presets";
import type { CompiledQuery, QueryRequest } from "../../query/types";
import { agentDataInputSchema } from "../mcp/agent-query-schema";
import {
	capRowArrays,
	keepsNewestRows,
	MCP_RESULT_ROW_LIMIT,
	queryItemError,
	resolveQueryOrdering,
} from "../mcp/mcp-utils";
import { normalizeClickHouseDateTime } from "../../query/date-utils";
import {
	getAppContext,
	resolveToolWebsite,
	toolDateRangeError,
} from "./utils/context";

const queryItemSchema = agentDataInputSchema.shape.queries.element
	.extend({
		type: z.enum(WEBSITE_QUERY_TYPES),
		websiteId: z
			.string()
			.nullish()
			.transform((value) => value ?? undefined)
			.describe("Target website id; null uses the workspace default."),
		timezone: z
			.string()
			.nullish()
			.transform((value) => value ?? undefined)
			.describe("IANA timezone; null uses the conversation timezone."),
	})
	.refine(({ from, to, preset }) => {
		if (preset && (from !== undefined || to !== undefined)) {
			return false;
		}
		return (
			Boolean(from) === Boolean(to) &&
			!(
				from &&
				to &&
				normalizeClickHouseDateTime(from) >
					normalizeClickHouseDateTime(to, { endOfDay: true })
			)
		);
	}, "Use a preset with from/to null, or both dates with preset null in chronological order.");

type QueryItem = z.infer<typeof queryItemSchema>;

interface QueryItemResult {
	data: Record<string, unknown>[];
	definition?: string;
	error?: string;
	filters?: QueryItem["filters"];
	from?: string;
	query?: CompiledQuery;
	returnedRows?: number;
	rowCount: number;
	summary?: string;
	timezone?: string;
	to?: string;
	truncated?: boolean;
	type: string;
	warning?: string;
	websiteId?: string;
}

function describeFilter(f: NonNullable<QueryItem["filters"]>[number]): string {
	const value = Array.isArray(f.value) ? f.value.join(",") : f.value;
	const op = f.op === "eq" ? "=" : f.op === "ne" ? "!=" : ` ${f.op} `;
	return `${f.field}${op}${value}`;
}

function buildResultSummary(
	type: string,
	from: string,
	to: string,
	filters: QueryItem["filters"]
): string {
	const meta = getQueryBuilder(type)?.meta;
	const title = meta?.title ?? type;
	const range = from === to ? from : `${from} → ${to}`;
	const filterPart = filters?.length
		? `filters: ${filters.map(describeFilter).join(" AND ")}`
		: "no filters applied";
	return `${title} · ${range} · ${filterPart}`;
}

const MAX_DISPLAY_PARAM_VALUES = 10;
const MS_PER_DAY = 86_400_000;

function displayQuery({ sql, params }: CompiledQuery): CompiledQuery {
	return {
		sql,
		params: Object.fromEntries(
			Object.entries(params).map(([name, value]) => [
				name,
				Array.isArray(value) && value.length > MAX_DISPLAY_PARAM_VALUES
					? `${value.length} values`
					: value,
			])
		),
	};
}

export function getDataModelOutput({
	output,
}: {
	output: { results: Record<string, QueryItemResult> };
}) {
	const entries = Object.entries(output.results);
	if (entries.length > 0 && entries.every(([, result]) => result.error)) {
		return {
			type: "error-json" as const,
			value: {
				results: Object.fromEntries(
					entries.map(([key, result]) => [
						key,
						{
							type: result.type,
							websiteId: result.websiteId ?? null,
							error: result.error ?? "Query failed",
						},
					])
				),
			},
		};
	}
	return {
		type: "text" as const,
		value: JSON.stringify({
			results: Object.fromEntries(
				Object.entries(output.results).map(
					([key, { query: _query, data, ...result }]) => [
						key,
						result.error
							? {
									type: result.type,
									websiteId: result.websiteId,
									error: result.error,
								}
							: { ...result, data: data.map(capRowArrays) },
					]
				)
			),
		}),
	};
}

function describeQueryError(error: unknown): string {
	if (error instanceof TraitFilterError) {
		return error.message;
	}
	const message = publicQueryErrorMessage(error);
	if (message === SANITIZED_QUERY_ERROR) {
		captureError(error, { tool: "get_data", step: "execute_query" });
	}
	return message;
}

function resolveDates(
	item: QueryItem,
	timeZone: string,
	currentDateTime?: string
): { from: string; to: string } {
	if (item.from && item.to) {
		return { from: item.from, to: item.to };
	}
	const reference = currentDateTime ? new Date(currentDateTime) : new Date();
	return resolveDatePreset(
		item.preset ?? "last_30d",
		timeZone,
		Number.isNaN(reference.getTime()) ? new Date() : reference
	);
}

export const getDataTool = tool({
	description: `Run analytics query builders for explicit data questions. Batch 1-10 queries per call; split larger requests into multiple calls yourself. limit must be 1-1000 or null, never 10000. Valid presets are exactly ${Object.keys(DatePresets).join(", ")}. last_3_weeks means 21 inclusive calendar days through today. For a different period such as the last 21 days, compute inclusive from/to dates in the context timezone (today minus 20 days through today) and set preset:null. Never send dates and a preset together. Use only builder names from the schema; discover_query_types if the builder is unknown. For event totals or an event-name inventory, query custom_events with timeUnit:null; it does not produce time buckets. For daily event counts use custom_events_trends (one combined series) or custom_events_trends_by_event (separate series per event), timeUnit:"day" and orderBy:null. For example, compare events with {"queries":[{"type":"custom_events_trends_by_event","preset":"last_30d","from":null,"to":null,"timeUnit":"day","orderBy":null,"filters":[{"field":"event_name","op":"in","value":["add_to_cart","cart_view"]}],"limit":1000,"websiteId":null,"timezone":null}]}. Keep the requested event names and period; do not use the example names or default period for a different request. discover_query_types is not needed for these known builders. If a call rejects the date shape, repair it yourself: with a preset both from and to must be null; with explicit dates preset must be null. The user already supplied the period, so do not ask them to choose it again. With no supplied period use {"queries":[{"type":"custom_events","preset":"last_30d","from":null,"to":null,"timeUnit":null,"orderBy":null,"filters":null,"limit":100,"websiteId":null,"timezone":null}]}. Event names come from this result, not from asking the user to remember them. Omitted dates default to last_30d in the context timezone. Read the returned definition for population and percentage semantics. Each query may target a specific website via websiteId; omit to use the workspace default. Filters select rows: never supply target or having. discover_query_types lists allowed and required filters. Results include at most ${MCP_RESULT_ROW_LIMIT} rows; rowCount is the number of query rows, not the whole population. Query limits may exclude more rows even when truncated is false. Never infer absence, totals, or completeness from a ranked list; query the exact subject or use an aggregate builder.`,
	inputSchema: z.object({
		queries: z
			.array(queryItemSchema)
			.min(1)
			.max(10)
			.describe(
				"One to ten explicit analytics query builder requests needed to answer the user's latest data question."
			),
	}),
	execute: async ({ queries }, options) => {
		const ctx = getAppContext(options);
		const showQueries = ctx.source === "dashboard";

		const results = await Promise.all(
			queries.map(async (item): Promise<QueryItemResult> => {
				let websiteId: string;
				let resolvedDomain: string | undefined;
				try {
					const resolved = resolveToolWebsite(ctx, item.websiteId);
					websiteId = resolved.websiteId;
					resolvedDomain = resolved.domain;
				} catch (error) {
					return {
						type: item.type,
						websiteId: item.websiteId,
						data: [],
						rowCount: 0,
						error:
							error instanceof Error ? error.message : "Website not resolved",
					};
				}

				try {
					const domain = resolvedDomain || (await getWebsiteDomain(websiteId));
					const timezone = item.timezone ?? ctx.timezone ?? "UTC";
					const { from, to } = resolveDates(
						item,
						timezone,
						ctx.currentDateTime
					);
					const config = QueryBuilders[item.type];
					const ordering = resolveQueryOrdering(
						item.type,
						config,
						item.orderBy
					);
					const days =
						(Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) /
						MS_PER_DAY;
					const blocked =
						toolDateRangeError(from, to, ctx, timezone) ??
						queryItemError(
							item.type,
							config,
							{ ...item, orderBy: ordering.orderBy },
							days
						) ??
						(await queryPlanGateError([item.type], { websiteId }));
					if (blocked) {
						return {
							type: item.type,
							websiteId,
							data: [],
							rowCount: 0,
							error: blocked,
						};
					}
					const keepNewest = keepsNewestRows(config, ordering.orderBy);
					const req: QueryRequest = {
						projectId: websiteId,
						type: item.type,
						from,
						to,
						timeUnit: item.timeUnit,
						filters: item.filters,
						orderBy: ordering.orderBy,
						limit: keepNewest ? undefined : item.limit,
						timezone,
					};

					const executed: { query?: CompiledQuery } = {};
					const data = await executeQuery(
						req,
						domain,
						timezone,
						options.abortSignal,
						showQueries
							? (query) => {
									executed.query = displayQuery(query);
								}
							: undefined
					);
					const rowLimit = Math.min(
						item.limit ?? MCP_RESULT_ROW_LIMIT,
						MCP_RESULT_ROW_LIMIT
					);
					const rows = keepNewest
						? data.slice(-rowLimit)
						: data.slice(0, rowLimit);
					return {
						type: item.type,
						definition: config.meta?.description,
						warning: ordering.warning,
						websiteId,
						filters: item.filters ?? [],
						from,
						to,
						timezone,
						summary: buildResultSummary(item.type, from, to, item.filters),
						data: rows,
						query: executed.query,
						returnedRows: rows.length,
						rowCount: data.length,
						truncated: rows.length < data.length,
					};
				} catch (error) {
					return {
						type: item.type,
						websiteId,
						data: [],
						rowCount: 0,
						error: describeQueryError(error),
					};
				}
			})
		);

		const resultMap: Record<string, QueryItemResult> = {};
		for (const r of results) {
			const base = r.websiteId ? `${r.type}@${r.websiteId}` : r.type;
			let key = resultMap[r.type] ? base : r.type;
			let n = 2;
			while (resultMap[key]) {
				key = `${base}#${n++}`;
			}
			resultMap[key] = r;
		}

		return { results: resultMap };
	},
});
