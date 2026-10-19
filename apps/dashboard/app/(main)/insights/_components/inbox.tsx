"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDateTime, fromNow, Spinner } from "@databuddy/ui";
import { useOrganizationsContext } from "@/components/providers/organizations-provider";
import { orpc } from "@/lib/orpc";
import { isActiveRun } from "../_lib/insight-run";
import { type InboxSection, SECTION_COPY } from "./inbox-state";

export function InboxEmptyPane({ section }: { section: InboxSection }) {
	const { activeOrganization, activeOrganizationId } =
		useOrganizationsContext();
	const organizationId =
		activeOrganization?.id ?? activeOrganizationId ?? undefined;
	const latestRun = useQuery({
		...orpc.insightGeneration.getLatestRun.queryOptions({
			input: { organizationId },
		}),
		enabled: Boolean(organizationId),
		meta: { suppressGlobalErrorToast: true },
	});
	const config = useQuery({
		...orpc.insightGeneration.getConfig.queryOptions({
			input: { organizationId },
		}),
		enabled: Boolean(organizationId),
		meta: { suppressGlobalErrorToast: true },
	});
	const copy = SECTION_COPY[section];
	const run = latestRun.data ?? null;
	const checking = isActiveRun(run?.status);
	const lastChecked = run?.finishedAt ?? null;
	const nextRunAt = config.data?.enabled ? config.data.nextRunAt : null;

	return (
		<div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
			<div className="w-full max-w-sm">
				<h2 className="text-balance font-semibold text-base text-foreground">
					{copy.title}
				</h2>
				<p className="mt-1 text-pretty text-muted-foreground text-sm">
					{copy.description}
				</p>
				{latestRun.isSuccess && config.isSuccess ? (
					<div className="mt-6 flex flex-col items-center gap-1 text-muted-foreground text-xs">
						{checking ? (
							<span className="inline-flex items-center gap-1.5">
								<Spinner size="sm" />
								Checking your websites now
							</span>
						) : lastChecked ? (
							<span>
								Last checked{" "}
								<time
									dateTime={lastChecked}
									title={formatDateTime(lastChecked)}
								>
									{fromNow(lastChecked)}
								</time>
							</span>
						) : (
							<span>No checks have run yet</span>
						)}
						{nextRunAt ? (
							<span>
								Next check{" "}
								<time
									dateTime={String(nextRunAt)}
									title={formatDateTime(nextRunAt)}
								>
									{fromNow(nextRunAt)}
								</time>
							</span>
						) : (
							<span>
								Scheduled checks are off. Turn them on under Analysis.
							</span>
						)}
					</div>
				) : null}
				<p className="mt-6 text-muted-foreground text-xs">
					Pick something on the left to read it, answer, apply the fix, or mark
					it done.
				</p>
			</div>
		</div>
	);
}
