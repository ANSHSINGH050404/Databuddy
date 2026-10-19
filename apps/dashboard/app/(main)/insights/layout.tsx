import type { Metadata } from "next";
import { type ReactNode, Suspense } from "react";
import { InsightsShell } from "./_components/insights-shell";

export const metadata: Metadata = {
	title: "Insights",
	description: "Organization-wide insights and investigations.",
};

export default function InsightsLayout({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<Suspense fallback={null}>
				<InsightsShell>{children}</InsightsShell>
			</Suspense>
		</div>
	);
}
