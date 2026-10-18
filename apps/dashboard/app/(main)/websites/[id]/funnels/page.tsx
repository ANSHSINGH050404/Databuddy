"use client";

import { FeatureGate, usePlanLimitMessage } from "@/components/feature-gate";
import { useOrganizationsContext } from "@/components/providers/organizations-provider";
import { useQuery } from "@tanstack/react-query";
import { List } from "@/components/ui/composables/list";
import { insightDefinitionEditChangesSchema } from "@databuddy/shared/insights";
import { useAutocompleteData } from "@/hooks/use-autocomplete";
import { useDateFilters } from "@/hooks/use-date-filters";
import {
	useFunnelAnalytics,
	useFunnelAnalyticsByReferrer,
	useFunnels,
} from "@/hooks/use-funnels";
import type { CreateFunnelData } from "@/types/funnels";
import { cn } from "@/lib/utils";
import { orpc } from "@/lib/orpc";
import { GATED_FEATURES } from "@databuddy/shared/types/features";
import dynamic from "next/dynamic";
import { useParams, usePathname } from "next/navigation";
import { parseAsString, useQueryStates } from "nuqs";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { TopBar } from "@/components/layout/top-bar";
import {
	FunnelAnalytics,
	FunnelAnalyticsByReferrer,
	type FunnelItemData,
	FunnelItemSkeleton,
	FunnelsList,
} from "./_components";
import { ArrowClockwiseIcon, FunnelIcon, PlusIcon } from "@databuddy/ui/icons";
import { Button } from "@databuddy/ui";
import { DeleteDialog } from "@databuddy/ui/client";

const EditFunnelDialog = dynamic(
	() =>
		import("./_components/edit-funnel-dialog").then((m) => ({
			default: m.EditFunnelDialog,
		})),
	{ ssr: false }
);

function FunnelsListSkeleton() {
	return (
		<List className="rounded bg-card">
			{[1, 2, 3].map((i) => (
				<FunnelItemSkeleton key={i} />
			))}
		</List>
	);
}

export default function FunnelsPage() {
	const { id } = useParams();
	const websiteId = id as string;
	const pathname = usePathname();
	const isDemoRoute = pathname.startsWith("/demo/");
	const { formattedDateRangeState, calendarDateRange: dateRange } =
		useDateFilters();

	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [selectedReferrer, setSelectedReferrer] = useState("all");
	const [editing, setEditing] = useState<FunnelItemData | "new" | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);

	const [
		{ command, description, funnelId, name, new: newFunnel, recommendationId },
		setHandoff,
	] = useQueryStates(
		{
			command: parseAsString,
			description: parseAsString,
			funnelId: parseAsString,
			name: parseAsString,
			new: parseAsString,
			recommendationId: parseAsString,
		},
		{ history: "replace", scroll: false }
	);
	const [review, setReview] = useState<{
		recommendationId: string;
		draft?: CreateFunnelData;
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

	useEffect(() => {
		if (!isDemoRoute && newFunnel === "funnel") {
			setReview(undefined);
			setEditing("new");
			setHandoff({ new: null });
		}
	}, [newFunnel, setHandoff, isDemoRoute]);

	const {
		analyticsMap,
		funnels,
		loadingIds,
		listOutcome,
		isFetching,
		error,
		refreshAction,
		createAction,
		updateAction,
		deleteAction,
		isCreating,
		isUpdating,
	} = useFunnels(websiteId, { dateRange });

	const planLimitMessage = usePlanLimitMessage(
		GATED_FEATURES.FUNNELS,
		funnels.length
	);

	const openCreate = () => {
		if (planLimitMessage) {
			toast.info(planLimitMessage);
			return;
		}
		setEditing("new");
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
		const handoffUpdate: { recommendationId: null; funnelId?: string } = {
			recommendationId: null,
		};
		if (item?.saved) {
			if (item.saved.definitionType === "funnel" && !item.saved.deleted) {
				handoffUpdate.funnelId = item.saved.definitionId;
				toast.info("This recommendation has already been saved.");
			} else {
				toast.info("The saved definition is no longer available.");
			}
		} else if (proposal?.type === "create_funnel") {
			if (planLimitMessage) {
				toast.info(planLimitMessage);
			} else {
				setReview({
					recommendationId,
					draft: {
						...proposal.draft,
						description: proposal.draft.description ?? undefined,
					},
				});
				setEditing("new");
			}
		} else if (proposal?.type === "edit_funnel") {
			const funnel = funnels.find((item) => item.id === proposal.definitionId);
			if (funnel) {
				setEditing({
					...funnel,
					name: proposal.changes.name ?? funnel.name,
					description: proposal.changes.description ?? funnel.description,
				});
				setReview({ recommendationId });
			} else {
				toast.error("The recommended funnel no longer exists.");
			}
		} else {
			toast.error(
				"This recommendation is no longer available. Review the latest recommendations."
			);
		}
		setHandoff(handoffUpdate);
	}, [
		funnels,
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
		if (
			isDemoRoute ||
			!funnelId ||
			(command && command !== "edit-funnel" && command !== "delete-funnel") ||
			(command && isFetching) ||
			listOutcome.status === "loading" ||
			listOutcome.status === "error"
		) {
			return;
		}

		const funnel = funnels.find((candidate) => candidate.id === funnelId);
		if (!funnel) {
			if (isFetching) {
				return;
			}
			toast.error("This funnel no longer exists. It may have been deleted.");
		} else if (!command) {
			const row = document.getElementById(`funnel-${funnel.id}`);
			if (!row) {
				return;
			}
			setExpandedId(funnel.id);
			setSelectedReferrer("all");
			row.scrollIntoView({ block: "start" });
		} else if (command === "edit-funnel") {
			const proposal = insightDefinitionEditChangesSchema.safeParse({
				description,
				name,
			});
			if (proposal.success) {
				const proposedFunnel = {
					...funnel,
					description: proposal.data.description ?? funnel.description,
					name: proposal.data.name ?? funnel.name,
				};
				if (
					proposedFunnel.description === funnel.description &&
					proposedFunnel.name === funnel.name
				) {
					toast.success("This funnel already matches the recommendation");
				} else {
					setEditing(proposedFunnel);
					setReview(undefined);
				}
			} else {
				toast.error(
					"Databuddy's suggested changes could not be loaded. Open the recommendation again."
				);
			}
		} else {
			setDeletingId(funnel.id);
		}

		setHandoff({
			command: null,
			description: null,
			funnelId: null,
			name: null,
		});
	}, [
		command,
		description,
		funnelId,
		funnels,
		isDemoRoute,
		isFetching,
		listOutcome.status,
		name,
		setHandoff,
	]);

	const {
		data: analyticsData,
		isLoading: analyticsLoading,
		error: analyticsError,
		refetch: refetchAnalytics,
	} = useFunnelAnalytics(websiteId, expandedId ?? "", dateRange, {
		enabled: !!expandedId,
	});

	const {
		data: referrerData,
		isLoading: referrerLoading,
		error: referrerError,
	} = useFunnelAnalyticsByReferrer(
		websiteId,
		expandedId ?? "",
		{
			start_date: formattedDateRangeState.startDate,
			end_date: formattedDateRangeState.endDate,
		},
		{ enabled: !!expandedId }
	);

	const autocomplete = useAutocompleteData(websiteId);

	const closeEditor = () => {
		setEditing(null);
		setReview(undefined);
	};

	const handleCreate = async (data: CreateFunnelData) => {
		try {
			await createAction(data, review?.recommendationId);
			closeEditor();
		} catch {
			// The mutation hook reports the error; keep the editor for retry.
		}
	};

	const handleUpdate = async (funnel: FunnelItemData) => {
		try {
			await updateAction(
				funnel.id,
				{
					name: funnel.name,
					description: funnel.description ?? "",
					steps: funnel.steps,
					filters: funnel.filters,
					ignoreHistoricData: funnel.ignoreHistoricData,
				},
				review?.recommendationId
			);
			closeEditor();
		} catch {
			// The mutation hook reports the error; keep the editor for retry.
		}
	};

	const handleDelete = async (funnelId: string) => {
		try {
			await deleteAction(funnelId);
			if (expandedId === funnelId) {
				setExpandedId(null);
			}
			setDeletingId(null);
		} catch {}
	};

	return (
		<FeatureGate feature={GATED_FEATURES.FUNNELS}>
			<div className="relative flex h-full flex-col">
				<TopBar.Title>
					<h1 className="font-semibold text-sm">Conversion funnels</h1>
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
							Create funnel
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
										label: "Create a funnel",
										onClick: openCreate,
									},
							description:
								"Define a multi-step journey to see where users drop off.",
							icon: <FunnelIcon className="size-6" />,
							title: "No funnels yet",
						}}
						errorProps={{
							action: { label: "Try again", onClick: () => refreshAction() },
							description:
								error?.message ??
								"Something went wrong while loading funnel data.",
							icon: <FunnelIcon className="size-6" />,
							title: "Failed to load funnels",
						}}
						loading={<FunnelsListSkeleton />}
						outcome={listOutcome}
					>
						{(items) => (
							<FunnelsList
								analyticsMap={analyticsMap}
								expandedFunnelId={expandedId}
								funnels={items}
								loadingAnalyticsIds={loadingIds}
								onDeleteFunnel={setDeletingId}
								onEditFunnel={(funnel) => {
									setReview(undefined);
									setEditing(funnel);
								}}
								onToggleFunnel={(funnelId) => {
									setExpandedId(expandedId === funnelId ? null : funnelId);
									setSelectedReferrer("all");
								}}
								readOnly={isDemoRoute}
							>
								{(funnel) => {
									if (expandedId !== funnel.id) {
										return null;
									}

									return (
										<div className="space-y-4">
											<FunnelAnalyticsByReferrer
												data={referrerData}
												error={referrerError}
												isLoading={referrerLoading}
												onReferrerChange={setSelectedReferrer}
											/>

											<FunnelAnalytics
												data={analyticsData}
												error={analyticsError as Error | null}
												isLoading={analyticsLoading}
												onRetry={refetchAnalytics}
												referrerAnalytics={referrerData?.referrer_analytics}
												selectedReferrer={selectedReferrer}
											/>
										</div>
									);
								}}
							</FunnelsList>
						)}
					</List.Content>
				</div>

				{!isDemoRoute && editing !== null && (
					<EditFunnelDialog
						autocompleteData={autocomplete.data}
						draft={editing === "new" ? review?.draft : undefined}
						funnel={
							typeof editing === "object"
								? {
										...editing,
										createdAt: String(editing.createdAt),
										updatedAt: String(editing.updatedAt),
									}
								: null
						}
						isCreating={isCreating}
						isOpen
						isUpdating={isUpdating}
						onClose={closeEditor}
						onCreate={handleCreate}
						onSubmit={handleUpdate}
					/>
				)}

				{!isDemoRoute && !!deletingId && (
					<DeleteDialog
						confirmLabel="Delete funnel"
						isOpen={!!deletingId}
						itemName="this funnel"
						onClose={() => setDeletingId(null)}
						onConfirm={() => {
							if (deletingId) {
								return handleDelete(deletingId);
							}
						}}
						title="Delete funnel"
					/>
				)}
			</div>
		</FeatureGate>
	);
}
