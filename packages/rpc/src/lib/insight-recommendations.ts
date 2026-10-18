import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, sql, type SQLWrapper } from "@databuddy/db";
import {
	auditEvents,
	funnelDefinitions,
	goals,
	insightObservations,
} from "@databuddy/db/schema";
import { auditActions } from "@databuddy/shared/audit";
import {
	parseInvestigationOutcome,
	type InsightRecommendationReview,
	type insightRecommendationSavedSchema,
} from "@databuddy/shared/insights";
import { z } from "zod";
import { rpcError } from "../errors";
import type { Context } from "../orpc";
import { appendRpcAuditEvent } from "./audit";
import type { FunnelStep } from "../routers/funnel-steps";

const MAX_RECOMMENDATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
type Transaction = Parameters<Parameters<Context["db"]["transaction"]>[0]>[0];
export type Database = Context["db"] | Transaction;
type Definition =
	| typeof goals.$inferSelect
	| typeof funnelDefinitions.$inferSelect;
type SavedDefinition = Pick<
	Definition,
	"id" | "websiteId" | "name" | "updatedAt" | "deletedAt"
>;
type ReviewType = InsightRecommendationReview["type"];

const receiptMetadataSchema = z.object({
	websiteId: z.string(),
	definitionType: z.enum(["goal", "funnel"]),
	definitionId: z.string(),
	reviewType: z.enum([
		"create_goal",
		"create_funnel",
		"edit_goal",
		"edit_funnel",
	]),
	adjusted: z.boolean(),
});

interface RecommendationSource {
	asOf: Date;
	id: string;
	organizationId: string;
	outcome: typeof insightObservations.$inferSelect.outcome;
	recheckAt: Date;
	websiteId: string;
}

export function recommendationExpiresAt(
	source: Pick<RecommendationSource, "asOf" | "recheckAt">
): Date {
	return new Date(
		Math.min(
			source.recheckAt.getTime(),
			source.asOf.getTime() + MAX_RECOMMENDATION_AGE_MS
		)
	);
}

interface RecommendationColumns {
	asOf: SQLWrapper;
	id: SQLWrapper;
	outcome: SQLWrapper;
	recheckAt: SQLWrapper;
	websiteId: SQLWrapper;
}

/** Apply only after selecting the latest source, never to observation histories. */
export function recommendationReadyCondition(
	source: RecommendationColumns,
	now: Date
) {
	return sql`${source.asOf} <= ${now}
		and ${now} < least(${source.recheckAt}, ${source.asOf} + interval '720 hours')
		and (
			${source.outcome}->'recommendation'->'review'->>'type' is null
			or ${source.outcome}->'recommendation'->'review'->>'type' in ('create_goal', 'create_funnel')
			or (${source.outcome}->'recommendation'->'review'->>'type' = 'edit_goal' and exists (
				select 1 from ${goals} where ${goals.id} = ${source.outcome}->'recommendation'->'review'->>'definitionId'
					and ${goals.websiteId} = ${source.websiteId} and ${goals.deletedAt} is null and ${goals.updatedAt} <= ${source.asOf}
			))
			or (${source.outcome}->'recommendation'->'review'->>'type' = 'edit_funnel' and exists (
				select 1 from ${funnelDefinitions} where ${funnelDefinitions.id} = ${source.outcome}->'recommendation'->'review'->>'definitionId'
					and ${funnelDefinitions.websiteId} = ${source.websiteId} and ${funnelDefinitions.deletedAt} is null and ${funnelDefinitions.updatedAt} <= ${source.asOf}
			))
		)`;
}

export function recommendationSavedCondition(
	source: RecommendationColumns,
	organizationId: string
) {
	return sql`exists (
		select 1 from ${auditEvents}
		where ${auditEvents.organizationId} = ${organizationId}
			and ${auditEvents.targetType} = 'recommendation' and ${auditEvents.targetId} = ${source.id}
			and ${auditEvents.action} = ${auditActions.RECOMMENDATION_SAVED.action} and ${auditEvents.outcome} = 'success'
			and ${auditEvents.metadata}->>'websiteId' = ${source.websiteId}
			and ${auditEvents.metadata}->>'reviewType' = ${source.outcome}->'recommendation'->'review'->>'type'
			and ${auditEvents.metadata}->>'definitionType' = case
				when ${source.outcome}->'recommendation'->'review'->>'type' in ('create_goal', 'edit_goal') then 'goal'
				when ${source.outcome}->'recommendation'->'review'->>'type' in ('create_funnel', 'edit_funnel') then 'funnel'
			end
			and (${auditEvents.metadata}->>'reviewType' in ('create_goal', 'create_funnel')
				or ${auditEvents.metadata}->>'definitionId' = ${source.outcome}->'recommendation'->'review'->>'definitionId')
	)`;
}

async function loadReceipt(
	database: Database,
	organizationId: string,
	sourceId: string
) {
	const [receipt] = await database
		.select({
			metadata: auditEvents.metadata,
			createdAt: auditEvents.createdAt,
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.organizationId, organizationId),
				eq(auditEvents.targetType, "recommendation"),
				eq(auditEvents.targetId, sourceId),
				eq(auditEvents.action, auditActions.RECOMMENDATION_SAVED.action),
				eq(auditEvents.outcome, "success")
			)
		)
		.orderBy(auditEvents.createdAt, auditEvents.id)
		.limit(1);
	return receipt;
}

function matchingReceipt(
	source: RecommendationSource,
	review: InsightRecommendationReview,
	metadata: unknown
) {
	const parsed = receiptMetadataSchema.safeParse(metadata);
	if (
		!parsed.success ||
		parsed.data.websiteId !== source.websiteId ||
		parsed.data.reviewType !== review.type ||
		parsed.data.definitionType !==
			(review.type.endsWith("goal") ? "goal" : "funnel") ||
		((review.type === "edit_goal" || review.type === "edit_funnel") &&
			parsed.data.definitionId !== review.definitionId)
	) {
		return null;
	}
	return parsed.data;
}

export async function loadRecommendationsSaved(
	database: Database,
	organizationId: string,
	sources: RecommendationSource[]
) {
	const saved = new Map<
		string,
		z.infer<typeof insightRecommendationSavedSchema>
	>();
	if (sources.length === 0) {
		return saved;
	}
	const sourceById = new Map(sources.map((source) => [source.id, source]));
	const receipts = await database
		.select({
			sourceId: auditEvents.targetId,
			metadata: auditEvents.metadata,
			createdAt: auditEvents.createdAt,
		})
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.organizationId, organizationId),
				eq(auditEvents.targetType, "recommendation"),
				inArray(auditEvents.targetId, [...sourceById.keys()]),
				eq(auditEvents.action, auditActions.RECOMMENDATION_SAVED.action),
				eq(auditEvents.outcome, "success")
			)
		)
		.orderBy(auditEvents.createdAt, auditEvents.id);
	const accepted = new Map<
		string,
		{
			metadata: z.infer<typeof receiptMetadataSchema>;
			createdAt: Date;
			websiteId: string;
		}
	>();
	for (const receipt of receipts) {
		const source = sourceById.get(receipt.sourceId);
		if (!source) {
			continue;
		}
		const review = parseInvestigationOutcome(source.outcome)?.recommendation
			?.review;
		if (!review) {
			continue;
		}
		const metadata = matchingReceipt(source, review, receipt.metadata);
		if (metadata && !accepted.has(receipt.sourceId)) {
			accepted.set(receipt.sourceId, {
				metadata,
				createdAt: receipt.createdAt,
				websiteId: source.websiteId,
			});
		}
	}
	const ids = (type: "goal" | "funnel") =>
		[...accepted.values()].flatMap(({ metadata }) =>
			metadata.definitionType === type ? [metadata.definitionId] : []
		);
	const goalIds = ids("goal");
	const funnelIds = ids("funnel");
	const websiteIds = [...new Set(sources.map((source) => source.websiteId))];
	const [savedGoals, savedFunnels]: [SavedDefinition[], SavedDefinition[]] =
		await Promise.all([
			goalIds.length
				? database
						.select({
							id: goals.id,
							websiteId: goals.websiteId,
							name: goals.name,
							updatedAt: goals.updatedAt,
							deletedAt: goals.deletedAt,
						})
						.from(goals)
						.where(
							and(
								inArray(goals.id, goalIds),
								inArray(goals.websiteId, websiteIds)
							)
						)
				: [],
			funnelIds.length
				? database
						.select({
							id: funnelDefinitions.id,
							websiteId: funnelDefinitions.websiteId,
							name: funnelDefinitions.name,
							updatedAt: funnelDefinitions.updatedAt,
							deletedAt: funnelDefinitions.deletedAt,
						})
						.from(funnelDefinitions)
						.where(
							and(
								inArray(funnelDefinitions.id, funnelIds),
								inArray(funnelDefinitions.websiteId, websiteIds)
							)
						)
				: [],
		]);
	const definitions = {
		goal: new Map(savedGoals.map((definition) => [definition.id, definition])),
		funnel: new Map(
			savedFunnels.map((definition) => [definition.id, definition])
		),
	};
	for (const [sourceId, receipt] of accepted) {
		const { metadata, createdAt, websiteId } = receipt;
		const target = definitions[metadata.definitionType].get(
			metadata.definitionId
		);
		const definition = target?.websiteId === websiteId ? target : undefined;
		saved.set(sourceId, {
			definitionType: metadata.definitionType,
			definitionId: metadata.definitionId,
			name: definition?.name ?? null,
			savedAt: createdAt.toISOString(),
			adjusted: metadata.adjusted,
			current: Boolean(
				definition && !definition.deletedAt && definition.updatedAt <= createdAt
			),
			deleted: !definition || Boolean(definition.deletedAt),
		});
	}
	return saved;
}

type DefinitionFields = {
	name: string;
	description?: string | null;
	filters?:
		| { field: string; operator: string; value: string | string[] }[]
		| null;
	ignoreHistoricData?: boolean;
	isActive?: boolean;
} & ({ type: string; target: string } | { steps: FunnelStep[] });

function definitionFields(definition: DefinitionFields) {
	const filters = (definition.filters ?? []).map(
		({ field, operator, value }) => ({ field, operator, value })
	);
	filters.sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right))
	);
	return {
		name: definition.name,
		description: definition.description ?? null,
		filters,
		ignoreHistoricData: definition.ignoreHistoricData ?? false,
		isActive: definition.isActive ?? true,
		...("target" in definition
			? { type: definition.type, target: definition.target }
			: {
					steps: definition.steps.map((step) => ({
						...step,
						conditions: step.conditions ?? {},
					})),
				}),
	};
}

interface SaveOptions<T extends Definition> {
	changes?: Partial<T>;
	definitionId?: string;
	loadDefinition: (database: Database, id: string) => Promise<T | undefined>;
	organizationId: string;
	recommendationId?: string;
	reviewType: ReviewType;
	websiteId: string;
	write: (database: Database) => Promise<T>;
}

/** Source row lock serializes retries; the definition and its receipt commit together. */
export async function saveInsightRecommendation<T extends Definition>(
	context: Context,
	options: SaveOptions<T>
): Promise<{ definition: T; changed: boolean }> {
	const recommendationId = options.recommendationId;
	if (!recommendationId) {
		return { definition: await options.write(context.db), changed: true };
	}
	return context.db.transaction(async (tx) => {
		const [source] = await tx
			.select()
			.from(insightObservations)
			.where(
				and(
					eq(insightObservations.id, recommendationId),
					eq(insightObservations.organizationId, options.organizationId),
					eq(insightObservations.websiteId, options.websiteId)
				)
			)
			.limit(1)
			.for("update");
		if (!source) {
			throw rpcError.notFound("recommendation", recommendationId);
		}
		const receipt = await loadReceipt(tx, options.organizationId, source.id);
		const review = parseInvestigationOutcome(source.outcome)?.recommendation
			?.review;
		if (
			!review ||
			review.type !== options.reviewType ||
			((review.type === "edit_goal" || review.type === "edit_funnel") &&
				review.definitionId !== options.definitionId)
		) {
			throw rpcError.badRequest(
				"This recommendation does not match the requested definition save."
			);
		}
		if (receipt) {
			const metadata = matchingReceipt(source, review, receipt.metadata);
			if (!metadata) {
				throw rpcError.conflict(
					"The saved recommendation receipt does not match this source."
				);
			}
			const saved = await options.loadDefinition(tx, metadata.definitionId);
			if (!saved || saved.deletedAt) {
				throw rpcError.conflict(
					"The definition saved from this recommendation is no longer available. Review current recommendations."
				);
			}
			if (
				!isDeepStrictEqual(
					definitionFields(saved),
					definitionFields({ ...saved, ...options.changes })
				)
			) {
				throw rpcError.conflict(
					`This recommendation has already been saved. Open the saved ${metadata.definitionType} to edit it.`
				);
			}
			return { definition: saved, changed: false };
		}
		const [latest] = await tx
			.select({ id: insightObservations.id })
			.from(insightObservations)
			.where(
				and(
					eq(insightObservations.organizationId, options.organizationId),
					eq(insightObservations.websiteId, options.websiteId),
					eq(insightObservations.signalKey, source.signalKey)
				)
			)
			.orderBy(
				desc(insightObservations.asOf),
				desc(insightObservations.createdAt),
				desc(insightObservations.id)
			)
			.limit(1);
		const now = new Date();
		if (
			latest?.id !== source.id ||
			source.asOf > now ||
			now >= recommendationExpiresAt(source)
		) {
			throw rpcError.conflict(
				"This recommendation is no longer current. Review the latest recommendations before saving."
			);
		}
		const before = options.definitionId
			? await options.loadDefinition(tx, options.definitionId)
			: undefined;
		if (
			(review.type === "edit_goal" || review.type === "edit_funnel") &&
			(!before || before.deletedAt || before.updatedAt > source.asOf)
		) {
			throw rpcError.conflict(
				"This definition changed after the recommendation. Review its current settings before saving."
			);
		}
		if (
			before &&
			isDeepStrictEqual(
				definitionFields(before),
				definitionFields({ ...before, ...options.changes })
			)
		) {
			throw rpcError.badRequest(
				"This definition already matches your draft. No changes were saved."
			);
		}
		const definition = await options.write(tx);
		const proposed =
			review.type === "create_goal" || review.type === "create_funnel"
				? review.draft
				: before && {
						...before,
						name: review.changes.name ?? before.name,
						description: review.changes.description ?? before.description,
					};
		if (!proposed) {
			throw rpcError.badRequest(
				"The recommendation has no definition to save."
			);
		}
		await appendRpcAuditEvent(
			context,
			options.organizationId,
			{
				action: auditActions.RECOMMENDATION_SAVED,
				target: { id: source.id },
				metadata: {
					websiteId: options.websiteId,
					definitionType: review.type.endsWith("goal") ? "goal" : "funnel",
					definitionId: definition.id,
					reviewType: review.type,
					adjusted: !isDeepStrictEqual(
						definitionFields(definition),
						definitionFields(proposed)
					),
				},
			},
			tx
		);
		return { definition, changed: true };
	});
}
