import { analyticsCohortSchema } from "@databuddy/shared/analytics-filters";
import { insightMeasurementSchema } from "@databuddy/shared/insights";
import { successOutputSchema } from "../lib/schemas";
import { and, desc, eq, inArray, isNull, sql } from "@databuddy/db";
import { goals } from "@databuddy/db/schema";
import { createDrizzleCache, redis } from "@databuddy/redis";
import { GATED_FEATURES } from "@databuddy/shared/types/features";
import {
	analyticsDateRangeSchema,
	resolveAnalyticsDateRange,
} from "@databuddy/validation";
import { randomUUIDv7 } from "bun";
import { z } from "zod";
import { rpcError } from "../errors";
import {
	buildGoalAnalyticsResult,
	getTotalWebsiteUsers,
	processGoalAnalytics,
	processGoalsConversionCountsBatch,
} from "../lib/analytics-utils";
import { getErrorLogFields } from "@databuddy/shared/evlog-fields";
import { logger } from "../lib/logger";
import { invalidateGoalsCache } from "../lib/goals-cache";
import {
	getEffectiveStartDate,
	groupGoalsForBulkAnalytics,
} from "../lib/goals-bulk-analytics-grouping";
import { setTrackProperties } from "../middleware/track-mutation";
import { publicProcedure, trackedProcedure } from "../orpc";
import {
	withPublicWorkspace,
	withWebsiteRead,
	withWorkspace,
} from "../procedures/with-workspace";
import { requireFeatureWithLimit } from "../types/billing";
import {
	conversionAnalyticsOutputSchema,
	filterSchema,
	toAnalyticsSteps,
} from "./funnel-steps";
import { queueDefinitionChangeRechecks } from "./insights";
import { saveInsightRecommendation } from "../lib/insight-recommendations";

const ANALYTICS_CACHE_TTL = 180;
const BATCH_CHUNK_SIZE = 255;
const cache = createDrizzleCache({ redis, namespace: "goals" });

type Filter = z.infer<typeof filterSchema>;

const goalAnalyticsInputSchema = analyticsDateRangeSchema.safeExtend({
	cohort: analyticsCohortSchema.optional(),
	filters: z.array(filterSchema).optional(),
	goalId: z.string(),
	websiteId: z.string(),
});
const bulkGoalAnalyticsInputSchema = analyticsDateRangeSchema.safeExtend({
	filters: z.array(filterSchema).optional(),
	goalIds: z.array(z.string()).min(1),
	websiteId: z.string(),
});

const goalOutputSchema = z.object({
	id: z.string(),
	websiteId: z.string(),
	type: z.enum(["PAGE_VIEW", "EVENT", "CUSTOM"]),
	target: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	filters: z.array(filterSchema).nullable(),
	ignoreHistoricData: z.boolean(),
	isActive: z.boolean(),
	createdBy: z.string().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
	deletedAt: z.nullable(z.coerce.date()),
});

const goalAnalyticsResultSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), data: conversionAnalyticsOutputSchema }),
	z.object({ ok: z.literal(false), error: z.string() }),
]);

type GoalAnalyticsResult = z.infer<typeof goalAnalyticsResultSchema>;

export const goalsRouter = {
	list: publicProcedure
		.route({
			method: "POST",
			path: "/goals/list",
			tags: ["Goals"],
			summary: "List goals",
			description:
				"Returns all goals for a website. Requires website read permission.",
		})
		.input(z.object({ websiteId: z.string() }))
		.output(z.array(goalOutputSchema))
		.use(withWebsiteRead)
		.handler(async ({ context, input }) => {
			const rows = await context.db
				.select()
				.from(goals)
				.where(
					and(eq(goals.websiteId, input.websiteId), isNull(goals.deletedAt))
				)
				.orderBy(desc(goals.createdAt));

			if (context.workspace.tier === "demo") {
				return rows.map((row) => ({ ...row, createdBy: "" }));
			}
			return rows;
		}),

	getById: publicProcedure
		.route({
			method: "POST",
			path: "/goals/getById",
			tags: ["Goals"],
			summary: "Get goal",
			description:
				"Returns a single goal by id; website is resolved from the goal. Requires website read permission.",
		})
		.input(z.object({ id: z.string() }))
		.output(goalOutputSchema)
		.handler(async ({ context, input }) => {
			const [goal] = await context.db
				.select()
				.from(goals)
				.where(and(eq(goals.id, input.id), isNull(goals.deletedAt)))
				.limit(1);

			if (!goal) {
				throw rpcError.notFound("goal", input.id);
			}

			const workspace = await withPublicWorkspace(context, {
				websiteId: goal.websiteId,
				permissions: ["read"],
			}).catch(() => {
				throw rpcError.notFound("goal", input.id);
			});

			if (workspace.tier === "demo") {
				return { ...goal, createdBy: "" };
			}
			return goal;
		}),

	create: trackedProcedure
		.route({
			method: "POST",
			path: "/goals/create",
			tags: ["Goals"],
			summary: "Create goal",
			description:
				"Creates a new conversion goal. Requires goals feature and website update permission.",
		})
		.input(
			z.object({
				websiteId: z.string(),
				type: z.enum(["PAGE_VIEW", "EVENT", "CUSTOM"]),
				target: z.string().min(1),
				name: z.string().min(1).max(100),
				description: z.string().nullable().optional(),
				filters: z.array(filterSchema).optional(),
				ignoreHistoricData: z.boolean().optional(),
				recommendationId: z.string().min(1).optional(),
			})
		)
		.output(goalOutputSchema)
		.handler(async ({ context, input }) => {
			setTrackProperties({ type: input.type });
			const workspace = await withWorkspace(context, {
				websiteId: input.websiteId,
				permissions: ["update"],
				includePlan: true,
			});

			const createdBy = await workspace.getCreatedBy();
			const definitionValues = {
				type: input.type,
				target: input.target,
				name: input.name,
				description: input.description ?? null,
				filters: input.filters ?? null,
				ignoreHistoricData: input.ignoreHistoricData ?? false,
				isActive: true,
			};
			const { definition: newGoal, changed } = await saveInsightRecommendation(
				context,
				{
					organizationId: workspace.organizationId,
					websiteId: input.websiteId,
					recommendationId: input.recommendationId,
					reviewType: "create_goal",
					changes: definitionValues,
					loadDefinition: async (database, id) =>
						(
							await database
								.select()
								.from(goals)
								.where(
									and(
										eq(goals.id, id),
										eq(goals.websiteId, input.websiteId),
										isNull(goals.deletedAt)
									)
								)
								.limit(1)
								.for("update")
						)[0],
					write: async (database) => {
						const existingGoals = await database
							.select({ id: goals.id })
							.from(goals)
							.where(
								and(
									eq(goals.websiteId, input.websiteId),
									isNull(goals.deletedAt)
								)
							);
						requireFeatureWithLimit(
							workspace.plan,
							GATED_FEATURES.GOALS,
							existingGoals.length
						);
						const [goal] = await database
							.insert(goals)
							.values({
								id: randomUUIDv7(),
								websiteId: input.websiteId,
								...definitionValues,
								createdBy,
							})
							.returning();
						if (!goal) {
							throw rpcError.internal(
								"The goal could not be created. Try again in a moment."
							);
						}
						return goal;
					},
				}
			);
			if (changed) {
				await invalidateGoalsCache(input.websiteId);
			}

			return newGoal;
		}),

	update: trackedProcedure
		.route({
			method: "POST",
			path: "/goals/update",
			tags: ["Goals"],
			summary: "Update goal",
			description:
				"Updates an existing goal. Requires website update permission.",
		})
		.input(
			z.object({
				id: z.string(),
				type: z.enum(["PAGE_VIEW", "EVENT", "CUSTOM"]).optional(),
				target: z.string().min(1).optional(),
				name: z.string().min(1).max(100).optional(),
				description: z.string().nullable().optional(),
				filters: z.array(filterSchema).optional(),
				ignoreHistoricData: z.boolean().optional(),
				isActive: z.boolean().optional(),
				recommendationId: z.string().min(1).optional(),
			})
		)
		.output(goalOutputSchema)
		.handler(async ({ context, input }) => {
			const [existingGoal] = await context.db
				.select({ websiteId: goals.websiteId })
				.from(goals)
				.where(and(eq(goals.id, input.id), isNull(goals.deletedAt)))
				.limit(1);

			if (!existingGoal) {
				throw rpcError.notFound("goal", input.id);
			}

			const workspace = await withWorkspace(context, {
				websiteId: existingGoal.websiteId,
				permissions: ["update"],
			});

			const { id, recommendationId, ...updates } = input;
			const { definition: updatedGoal, changed } =
				await saveInsightRecommendation(context, {
					organizationId: workspace.organizationId,
					websiteId: existingGoal.websiteId,
					recommendationId,
					reviewType: "edit_goal",
					definitionId: id,
					changes: updates,
					loadDefinition: async (database, savedId) =>
						(
							await database
								.select()
								.from(goals)
								.where(
									and(
										eq(goals.id, savedId),
										eq(goals.websiteId, existingGoal.websiteId),
										isNull(goals.deletedAt)
									)
								)
								.limit(1)
								.for("update")
						)[0],
					write: async (database) => {
						const [goal] = await database
							.update(goals)
							.set({
								...updates,
								updatedAt: recommendationId
									? sql`CURRENT_TIMESTAMP`
									: new Date(),
							})
							.where(and(eq(goals.id, id), isNull(goals.deletedAt)))
							.returning();
						if (!goal) {
							throw rpcError.notFound("goal", id);
						}
						return goal;
					},
				});
			if (changed) {
				await invalidateGoalsCache(existingGoal.websiteId);
				await queueDefinitionChangeRechecks({
					definitionId: id,
					type: "goal",
					websiteId: existingGoal.websiteId,
				});
			}

			return updatedGoal;
		}),

	delete: trackedProcedure
		.route({
			method: "POST",
			path: "/goals/delete",
			tags: ["Goals"],
			summary: "Delete goal",
			description: "Soft-deletes a goal. Requires website delete permission.",
		})
		.input(z.object({ id: z.string() }))
		.output(successOutputSchema)
		.handler(async ({ context, input }) => {
			const [existingGoal] = await context.db
				.select({ websiteId: goals.websiteId })
				.from(goals)
				.where(and(eq(goals.id, input.id), isNull(goals.deletedAt)))
				.limit(1);

			if (!existingGoal) {
				throw rpcError.notFound("goal", input.id);
			}

			await withWorkspace(context, {
				websiteId: existingGoal.websiteId,
				permissions: ["delete"],
			});

			await context.db
				.update(goals)
				.set({ deletedAt: new Date(), isActive: false })
				.where(and(eq(goals.id, input.id), isNull(goals.deletedAt)));

			await invalidateGoalsCache(existingGoal.websiteId);
			await queueDefinitionChangeRechecks({
				definitionId: input.id,
				type: "goal",
				websiteId: existingGoal.websiteId,
			});

			return { success: true };
		}),

	getAnalytics: publicProcedure
		.route({
			method: "POST",
			path: "/goals/getAnalytics",
			tags: ["Goals"],
			summary: "Get goal analytics",
			description:
				"Returns conversion analytics for a single goal. Requires website read permission.",
		})
		.input(goalAnalyticsInputSchema)
		.output(
			conversionAnalyticsOutputSchema.extend({
				measurement: insightMeasurementSchema,
				savedDefinition: insightMeasurementSchema.shape.definition,
				cohort: analyticsCohortSchema.optional(),
			})
		)
		.use(withWebsiteRead)
		.handler(async ({ context, input }) => {
			const { startDate, endDate } = resolveAnalyticsDateRange(input);

			const [goal] = await context.db
				.select()
				.from(goals)
				.where(
					and(
						eq(goals.id, input.goalId),
						eq(goals.websiteId, input.websiteId),
						isNull(goals.deletedAt)
					)
				)
				.limit(1);

			if (!goal) {
				throw rpcError.notFound("goal", input.goalId);
			}

			const effectiveStartDate = getEffectiveStartDate(
				startDate,
				goal.createdAt,
				goal.ignoreHistoricData
			);

			const combinedFilters = [
				...(input.filters ?? []),
				...(input.cohort?.filters ?? []),
				...(goal.filters ?? []),
			];
			const measurement = insightMeasurementSchema.parse({
				websiteId: input.websiteId,
				definitionId: goal.id,
				startDate: effectiveStartDate,
				endDate,
				definition: { ...goal, filters: combinedFilters },
			});

			const analytics = await cache.withCache({
				key: `analytics:${JSON.stringify(measurement)}`,
				ttl: ANALYTICS_CACHE_TTL,
				tables: ["goals"],
				queryFn: async () =>
					await processGoalAnalytics(
						toAnalyticsSteps([goal]),
						combinedFilters,
						{
							websiteId: input.websiteId,
							startDate: effectiveStartDate,
							endDate: `${endDate} 23:59:59`,
						},
						getTotalWebsiteUsers(
							input.websiteId,
							effectiveStartDate,
							endDate,
							combinedFilters
						)
					),
			});
			return {
				...analytics,
				measurement,
				cohort: input.cohort,
				savedDefinition: insightMeasurementSchema.shape.definition.parse({
					...goal,
					filters: goal.filters ?? [],
				}),
			};
		}),

	bulkAnalytics: publicProcedure
		.route({
			method: "POST",
			path: "/goals/bulkAnalytics",
			tags: ["Goals"],
			summary: "Get bulk goal analytics",
			description:
				"Returns conversion analytics for multiple goals. Requires website read permission.",
		})
		.input(bulkGoalAnalyticsInputSchema)
		.output(z.record(z.string(), goalAnalyticsResultSchema))
		.use(withWebsiteRead)
		.handler(async ({ context, input }) => {
			const { startDate, endDate } = resolveAnalyticsDateRange(input);

			const goalsList = await context.db
				.select()
				.from(goals)
				.where(
					and(
						eq(goals.websiteId, input.websiteId),
						isNull(goals.deletedAt),
						inArray(goals.id, input.goalIds)
					)
				)
				.orderBy(desc(goals.createdAt));

			const requestFilters = input.filters ?? [];
			const totalUsersCache = new Map<string, Promise<number>>();
			const memoizedTotalUsers = (
				effectiveStartDate: string,
				filters: Filter[]
			): Promise<number> => {
				const key = `${effectiveStartDate}|${JSON.stringify(filters)}`;
				let pending = totalUsersCache.get(key);
				if (!pending) {
					pending = getTotalWebsiteUsers(
						input.websiteId,
						effectiveStartDate,
						endDate,
						filters
					);
					totalUsersCache.set(key, pending);
				}
				return pending;
			};
			const analyticsByGoal: Record<string, GoalAnalyticsResult> = {};

			const runGoalIndividually = async (
				goal: (typeof goalsList)[number],
				combinedFilters: Filter[]
			): Promise<void> => {
				const effectiveStartDate = getEffectiveStartDate(
					startDate,
					goal.createdAt,
					goal.ignoreHistoricData
				);
				try {
					const analytics = await processGoalAnalytics(
						toAnalyticsSteps([goal]),
						combinedFilters,
						{
							websiteId: input.websiteId,
							startDate: effectiveStartDate,
							endDate: `${endDate} 23:59:59`,
						},
						memoizedTotalUsers(effectiveStartDate, combinedFilters)
					);
					analyticsByGoal[goal.id] = { ok: true, data: analytics };
				} catch (error) {
					logger.error(
						{
							...getErrorLogFields(error),
							goalId: goal.id,
							websiteId: input.websiteId,
						},
						"Failed to process goal analytics"
					);
					analyticsByGoal[goal.id] = {
						ok: false,
						error: "Failed to process goal analytics",
					};
				}
			};

			const { batchChunks, individualGoals } = groupGoalsForBulkAnalytics(
				goalsList,
				requestFilters,
				startDate,
				BATCH_CHUNK_SIZE
			);

			await Promise.all([
				...batchChunks.map(
					async ({ effectiveStartDate, goals: chunkGoals }) => {
						try {
							const [totalUsers, completionsByStep] = await Promise.all([
								memoizedTotalUsers(effectiveStartDate, []),
								processGoalsConversionCountsBatch(
									toAnalyticsSteps(chunkGoals),
									{
										websiteId: input.websiteId,
										startDate: effectiveStartDate,
										endDate: `${endDate} 23:59:59`,
									}
								),
							]);

							for (const [index, goal] of chunkGoals.entries()) {
								analyticsByGoal[goal.id] = {
									ok: true,
									data: buildGoalAnalyticsResult(
										goal.name,
										completionsByStep.get(index + 1) ?? 0,
										totalUsers
									),
								};
							}
						} catch (error) {
							logger.error(
								{
									...getErrorLogFields(error),
									websiteId: input.websiteId,
									effectiveStartDate,
									goalIds: chunkGoals.map((goal) => goal.id),
								},
								"Batched goal analytics query failed; falling back to per-goal queries"
							);
							await Promise.all(
								chunkGoals.map((goal) => runGoalIndividually(goal, []))
							);
						}
					}
				),
				...individualGoals.map(({ goal, combinedFilters }) =>
					runGoalIndividually(goal, combinedFilters)
				),
			]);

			return analyticsByGoal;
		}),
};
