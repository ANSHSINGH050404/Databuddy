"use client";

import {
	type FeatureLimit,
	GATED_FEATURES,
	normalizePlanId,
	PLAN_FEATURE_LIMITS,
} from "@databuddy/shared/types/features";
import { Button } from "@databuddy/ui";
import { ArrowRightIcon, CheckIcon } from "@databuddy/ui/icons";
import Link from "next/link";
import type { NormalizedPlan } from "@/app/(home)/pricing/_pricing/normalize";
import { normalizePlans } from "@/app/(home)/pricing/_pricing/normalize";
import { trackPricingPlanClick } from "@/app/(home)/pricing/_pricing/track-pricing";
import { PLAN_SUPPORT, RAW_PLANS } from "@/app/(home)/pricing/data";
import { SectionBullet } from "../icons/section-bullet";

const SELF_SERVE_PLAN_IDS = ["free", "hobby", "pro"] as const;
const FEATURED_PLAN_ID = "hobby";

const PLANS: NormalizedPlan[] = normalizePlans(RAW_PLANS);

const selfServePlans = SELF_SERVE_PLAN_IDS.map((id) =>
	PLANS.find((plan) => plan.id === id)
).filter((plan): plan is NormalizedPlan => Boolean(plan));

function formatEvents(events: number) {
	return events >= 1_000_000
		? `${events / 1_000_000}M events/mo`
		: `${events / 1000}K events/mo`;
}

function formatPrice(price: number) {
	return price === 0 ? "Free" : `$${price}`;
}

function formatLimit(limit: FeatureLimit, singular: string, plural: string) {
	if (limit === "unlimited") {
		return `unlimited ${plural}`;
	}
	return `${limit} ${limit === 1 ? singular : plural}`;
}

function planHighlights(plan: NormalizedPlan) {
	const limits = PLAN_FEATURE_LIMITS[normalizePlanId(plan.id)];
	const credits = plan.agentCredits;
	return [
		limits[GATED_FEATURES.ERROR_TRACKING] === false ? null : "Error tracking",
		`${formatLimit(limits[GATED_FEATURES.FUNNELS], "funnel", "funnels")} and ${formatLimit(limits[GATED_FEATURES.GOALS], "goal", "goals")}`,
		credits
			? `${credits.month} Databunny AI credits/mo${credits.day ? ` + ${credits.day}/day` : ""}`
			: null,
		PLAN_SUPPORT[plan.id] ? `${PLAN_SUPPORT[plan.id]} support` : null,
	].filter((line): line is string => Boolean(line));
}

function signupHref(planId: string) {
	return planId === "free"
		? "https://app.databuddy.cc/register"
		: `https://app.databuddy.cc/register?plan=${planId}`;
}

export function PricingPreview() {
	return (
		<div className="w-full">
			<div className="mb-10 text-start lg:mb-12 lg:text-left">
				<h2 className="mx-auto flex max-w-4xl items-start gap-2 text-balance font-semibold text-2xl leading-tight sm:text-4xl lg:mx-0 lg:text-5xl">
					<span className="mt-1.5 hidden sm:block">
						<SectionBullet color="#E3A514" />
					</span>
					<span className="text-foreground">
						10,000 events free, then from $9.99.
					</span>
				</h2>
				<p className="mt-3 max-w-2xl text-pretty text-muted-foreground text-sm sm:px-0 sm:text-base lg:text-lg">
					No credit card and no sales call. Every plan includes real-time
					analytics, sessions, Web Vitals, and feature flags.
				</p>
			</div>

			<div className="grid gap-px border border-white/[0.06] bg-white/[0.06] sm:grid-cols-3">
				{selfServePlans.map((plan) => (
					<div className="flex flex-col bg-background p-6" key={plan.id}>
						<span className="font-medium text-muted-foreground text-sm">
							{plan.name}
						</span>
						<span className="mt-1 font-semibold text-3xl text-foreground tabular-nums">
							{formatPrice(plan.priceMonthly)}
							{plan.priceMonthly > 0 && (
								<span className="ml-1 font-normal text-muted-foreground text-sm">
									/mo
								</span>
							)}
						</span>
						<span className="mt-1 text-foreground text-sm">
							{formatEvents(plan.includedEventsMonthly)}
						</span>
						<ul className="mt-5 mb-6 space-y-2">
							{planHighlights(plan).map((line) => (
								<li
									className="flex items-start gap-2 text-muted-foreground text-sm"
									key={line}
								>
									<CheckIcon className="mt-0.5 size-4 shrink-0 text-foreground" />
									<span>{line}</span>
								</li>
							))}
						</ul>
						<Button
							asChild
							className="mt-auto w-full"
							variant={plan.id === FEATURED_PLAN_ID ? "primary" : "secondary"}
						>
							<a
								href={signupHref(plan.id)}
								onClick={() => trackPricingPlanClick(plan.id, "home_pricing")}
							>
								{plan.id === "free" ? "Start free" : `Start with ${plan.name}`}
							</a>
						</Button>
					</div>
				))}
			</div>

			<div className="mt-4 flex flex-wrap items-center justify-between gap-3">
				<p className="text-muted-foreground/70 text-xs">
					Scales to 250M+ events/mo. Set a billing limit and ingestion stops
					instead of surprising you.
				</p>
				<Link
					className="inline-flex items-center gap-1 text-muted-foreground text-sm transition-colors hover:text-foreground"
					href="/pricing"
				>
					See the full plan comparison
					<ArrowRightIcon className="size-3.5" />
				</Link>
			</div>
		</div>
	);
}
