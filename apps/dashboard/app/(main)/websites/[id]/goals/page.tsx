"use client";

import { insightDefinitionEditChangesSchema } from "@databuddy/shared/insights";
import { GATED_FEATURES } from "@databuddy/shared/types/features";
import { Button } from "@databuddy/ui";
import { DeleteDialog } from "@databuddy/ui/client";
import { ArrowClockwiseIcon, PlusIcon, TargetIcon } from "@databuddy/ui/icons";
import { useAtomValue } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { useParams, usePathname } from "next/navigation";
import { parseAsString, useQueryStates } from "nuqs";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FeatureGate, usePlanLimitMessage } from "@/components/feature-gate";
import { useOrganizationsContext } from "@/components/providers/organizations-provider";
import { List } from "@/components/ui/composables/list";
import { useAutocompleteData } from "@/hooks/use-autocomplete";
import { useDateFilters } from "@/hooks/use-date-filters";
import {
	type CreateGoalData,
	type Goal,
	useBulkGoalAnalytics,
	useGoals,
} from "@/hooks/use-goals";
import { TopBar } from "@/components/layout/top-bar";
import { dynamicQueryFiltersAtom } from "@/stores/jotai/filterAtoms";
import type { DynamicQueryFilter, GoalFilter } from "@/types/api";
import { EditGoalDialog } from "./_components/edit-goal-dialog";
import { GoalItemSkeleton } from "./_components/goal-item";
import { GoalsList } from "./_components/goals-list";
import { cn } from "@/lib/utils";
import { orpc } from "@/lib/orpc";

function GoalsListSkeleton() {
	return (
		<List className="rounded bg-card">
			{[1, 2, 3].map((i) => (
				<GoalItemSkeleton key={i} />
			))}
		</List>
	);
}

const filterOperatorMap = {
	contains: "contains",
	eq: "equals",
	in: "in",
	ne: "not_equals",
	not_contains: "not_contains",
	not_in: "not_in",
	starts_with: "starts_with",
} satisfies Record<DynamicQueryFilter["operator"], GoalFilter["operator"]>;

function toGoalFilters(filters: DynamicQueryFilter[]): GoalFilter[] {
	return filters.map((filter) => ({
		field: filter.field,
		operator: filterOperatorMap[filter.operator],
		value: Array.isArray(filter.value)
			? filter.value.map(String)
			: String(filter.value),
	}));
}

export default function GoalsPage() {
	const { id } = useParams();
	const websiteId = id as string;
	const pathname = usePathname();
	const [{ command, description, goalId, name, recommendationId }, setHandoff] =
		useQueryStates(
			{
				command: parseAsString,
				description: parseAsString,
				goalId: parseAsString,
				name: parseAsString,
				recommendationId: parseAsString,
			},
			{ history: "replace", scroll: false }
		);
	const isDemoRoute = pathname.startsWith("/demo/");
	const [deletingGoalId, setDeletingGoalId] = useState<string | null>(null);
	const [editingGoal, setEditingGoal] = useState<Goal | null>();
	const [review, setReview] = useState<{
		recommendationId: string;
		draft?: Omit<CreateGoalData, "websiteId">;
	}>();
	const { activeOrganizationId } = useOrganizationsContext();
	const recommendation = useQuery({
		...orpc.insights.recommendations.queryOptions({
			input: {
				organizationId: activeOrganizationId ?? "",
				websiteId,
				recommendationId: recommendationId ?? "",
			},
		}),
		enabled: Boolean(!isDemoRoute && recommendationId && activeOrganizationId),
		staleTime: 0,
		refetchOnMount: "always",
		meta: { suppressGlobalErrorToast: true },
	});

	const { calendarDateRange: dateRange } = useDateFilters();
	const globalFilters = useAtomValue(dynamicQueryFiltersAtom);
	const goalFilters = useMemo(
		() => toGoalFilters(globalFilters),
		[globalFilters]
	);

	const {
		data: goals,
		listOutcome,
		isFetching,
		error,
		refreshAction,
		createGoal,
		updateGoal,
		deleteGoal,
		isCreating,
		isUpdating,
	} = useGoals(websiteId);

	const planLimitMessage = usePlanLimitMessage(
		GATED_FEATURES.GOALS,
		goals.length
	);

	const openCreate = () => {
		if (planLimitMessage) {
			toast.info(planLimitMessage);
			return;
		}
		setEditingGoal(null);
		setReview(undefined);
	};

	useEffect(() => {
		if (
			!(recommendationId && recommendation.isSuccess) ||
			recommendation.isFetching ||
			isFetching ||
			listOutcome.status === "loading" ||
			listOutcome.status === "error"
		) {
			return;
		}
		const item = recommendation.data.recommendations.find(
			(item) => item.id === recommendationId
		);
		const proposal = item?.recommendation.review;
		const handoffUpdate: { recommendationId: null; goalId?: string } = {
			recommendationId: null,
		};
		if (item?.saved) {
			if (item.saved.definitionType === "goal" && !item.saved.deleted) {
				handoffUpdate.goalId = item.saved.definitionId;
				toast.info("This recommendation has already been saved.");
			} else {
				toast.info("The saved definition is no longer available.");
			}
		} else if (proposal?.type === "create_goal") {
			if (planLimitMessage) {
				toast.info(planLimitMessage);
			} else {
				setReview({ recommendationId, draft: proposal.draft });
				setEditingGoal(null);
			}
		} else if (proposal?.type === "edit_goal") {
			const goal = goals.find((item) => item.id === proposal.definitionId);
			if (goal) {
				setEditingGoal({
					...goal,
					name: proposal.changes.name ?? goal.name,
					description: proposal.changes.description ?? goal.description,
				});
				setReview({ recommendationId });
			} else {
				toast.error("The recommended goal no longer exists.");
			}
		} else {
			toast.error(
				"This recommendation is no longer available. Review the latest recommendations."
			);
		}
		setHandoff(handoffUpdate);
	}, [
		goals,
		isFetching,
		listOutcome.status,
		planLimitMessage,
		recommendation.data,
		recommendation.isSuccess,
		recommendation.isFetching,
		recommendationId,
		setHandoff,
	]);

	useEffect(() => {
		if (isDemoRoute) {
			return;
		}

		if (
			!goalId ||
			(command && command !== "edit-goal" && command !== "delete-goal") ||
			(command && isFetching) ||
			listOutcome.status === "loading" ||
			listOutcome.status === "error"
		) {
			return;
		}

		const goal = goals.find((candidate) => candidate.id === goalId);
		if (!goal) {
			if (isFetching) {
				return;
			}
			toast.error("This goal no longer exists. It may have been deleted.");
		} else if (!command) {
			const row = document.getElementById(`goal-${goal.id}`);
			if (!row) {
				return;
			}
			row.scrollIntoView({ block: "start" });
		} else if (command === "edit-goal") {
			const proposal = insightDefinitionEditChangesSchema.safeParse({
				description,
				name,
			});
			if (proposal.success) {
				const proposedGoal = {
					...goal,
					description: proposal.data.description ?? goal.description,
					name: proposal.data.name ?? goal.name,
				};
				if (
					proposedGoal.description === goal.description &&
					proposedGoal.name === goal.name
				) {
					toast.success("This goal already matches the recommendation");
				} else {
					setEditingGoal(proposedGoal);
					setReview(undefined);
				}
			} else {
				toast.error(
					"Databuddy's suggested changes could not be loaded. Open the recommendation again."
				);
			}
		} else {
			setDeletingGoalId(goal.id);
		}

		setHandoff({
			command: null,
			description: null,
			goalId: null,
			name: null,
		});
	}, [
		command,
		description,
		goalId,
		goals,
		isDemoRoute,
		isFetching,
		listOutcome.status,
		name,
		setHandoff,
	]);

	const goalIds = useMemo(() => goals.map((goal) => goal.id), [goals]);

	const { data: goalAnalytics, isLoading: analyticsLoading } =
		useBulkGoalAnalytics(websiteId, goalIds, dateRange, goalFilters, {
			enabled: goalIds.length > 0,
		});

	const autocompleteQuery = useAutocompleteData(websiteId);

	const closeEditor = () => {
		setEditingGoal(undefined);
		setReview(undefined);
	};

	const handleSaveGoal = async (
		data: Goal | Omit<CreateGoalData, "websiteId">
	) => {
		try {
			if ("id" in data && data.id) {
				await updateGoal({
					goalId: data.id,
					recommendationId: review?.recommendationId,
					updates: {
						name: data.name,
						description: data.description ?? null,
						type: data.type,
						target: data.target,
						filters: data.filters ?? undefined,
						ignoreHistoricData:
							"ignoreHistoricData" in data
								? data.ignoreHistoricData
								: undefined,
					},
				});
			} else {
				await createGoal(
					{
						name: data.name,
						description: data.description || undefined,
						type: data.type,
						target: data.target,
						filters: data.filters ?? undefined,
						ignoreHistoricData:
							"ignoreHistoricData" in data
								? data.ignoreHistoricData
								: undefined,
						websiteId,
					} as CreateGoalData,
					review?.recommendationId
				);
			}
			closeEditor();
		} catch {
			// The mutation hook reports the error; keep the editor for retry.
		}
	};

	const handleDeleteGoal = async (goalId: string) => {
		try {
			await deleteGoal(goalId);
			setDeletingGoalId(null);
		} catch {}
	};

	const deletingGoal = goals.find((goal) => goal.id === deletingGoalId) ?? null;

	return (
		<FeatureGate feature={GATED_FEATURES.GOALS}>
			<div className="relative flex h-full flex-col">
				<TopBar.Title>
					<h1 className="font-semibold text-sm">Goals</h1>
				</TopBar.Title>
				<TopBar.Actions>
					<Button
						aria-label="Refresh"
						disabled={isFetching}
						onClick={refreshAction}
						size="sm"
						variant="secondary"
					>
						<ArrowClockwiseIcon
							className={cn("size-4 shrink-0", isFetching && "animate-spin")}
						/>
					</Button>
					{!isDemoRoute && (
						<Button onClick={openCreate} size="sm">
							<PlusIcon className="size-4 shrink-0" />
							Create goal
						</Button>
					)}
				</TopBar.Actions>
				{recommendationId && recommendation.isError ? (
					<div className="flex items-center gap-2 p-4" role="alert">
						<p className="text-sm">The recommendation could not be loaded.</p>
						<Button
							onClick={() => recommendation.refetch()}
							size="sm"
							variant="secondary"
						>
							Try again
						</Button>
					</div>
				) : null}

				<div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
					<List.Content
						emptyProps={{
							action: isDemoRoute
								? undefined
								: {
										label: "Create a goal",
										onClick: openCreate,
									},
							description:
								"Track single-step conversions like signups, purchases, or activation events.",
							icon: <TargetIcon className="size-6" />,
							title: "No goals yet",
						}}
						errorProps={{
							action: { label: "Try again", onClick: () => refreshAction() },
							description:
								error?.message ??
								"Something went wrong while loading goal data.",
							icon: <TargetIcon className="size-6" />,
							title: "Failed to load goals",
						}}
						loading={<GoalsListSkeleton />}
						outcome={listOutcome}
					>
						{(items) => (
							<GoalsList
								analyticsLoading={analyticsLoading}
								goalAnalytics={goalAnalytics}
								goals={items}
								onDeleteGoal={(goalId) => setDeletingGoalId(goalId)}
								onEditGoal={(goal) => {
									setReview(undefined);
									setEditingGoal(goal);
								}}
								readOnly={isDemoRoute}
							/>
						)}
					</List.Content>
				</div>

				{!isDemoRoute && editingGoal !== undefined && (
					<EditGoalDialog
						autocompleteData={autocompleteQuery.data}
						goal={editingGoal}
						draft={editingGoal === null ? review?.draft : undefined}
						isOpen
						isSaving={isCreating || isUpdating}
						onClose={closeEditor}
						onSave={handleSaveGoal}
					/>
				)}

				{!isDemoRoute && deletingGoalId && (
					<DeleteDialog
						confirmLabel="Delete goal"
						description={`Delete ${deletingGoal?.name ?? "this goal"}? Historical events remain in your analytics, but the goal will no longer be available for reporting.`}
						isOpen={!!deletingGoalId}
						onClose={() => setDeletingGoalId(null)}
						onConfirm={() => {
							if (deletingGoalId) {
								return handleDeleteGoal(deletingGoalId);
							}
						}}
						title={`Delete ${deletingGoal?.name ?? "goal"}`}
					/>
				)}
			</div>
		</FeatureGate>
	);
}
