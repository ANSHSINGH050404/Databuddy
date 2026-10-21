import { Heading, Link, Section, Text } from "@react-email/components";
import { emailBrand } from "./email-brand";
import { EmailButton } from "./email-button";
import type { EmailPreferenceLinks } from "./email-footer";
import { EmailLayout } from "./email-layout";

export interface BlockedTrafficAlertEmailProps {
	baselineEvents?: number;
	blockedCount?: number;
	blockReason?: string;
	dashboardUrl?: string;
	fix?: string;
	origin?: string | null;
	preferences?: EmailPreferenceLinks;
	previousBlockedCount?: number;
	severity?: "critical" | "warning";
	silenceMinutes?: number;
	siteLabel?: string;
	windowMinutes?: number;
}

function formatNumber(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	return Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function plural(value: number, unit: string): string {
	return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function formatSilence(minutes: number): string {
	if (minutes < 120) {
		return plural(Math.max(1, Math.round(minutes)), "minute");
	}
	if (minutes < 48 * 60) {
		return plural(Math.round(minutes / 60), "hour");
	}
	return plural(Math.round(minutes / (24 * 60)), "day");
}

function reasonLabel(reason: string | undefined): string {
	switch (reason) {
		case "origin_not_authorized":
			return "Domain mismatch";
		case "origin_missing":
			return "Missing origin";
		case "ip_not_authorized":
			return "IP allowlist blocked requests";
		default:
			return reason || "Blocked tracking";
	}
}

const DetailRow = ({
	label,
	children,
}: {
	children: React.ReactNode;
	label: string;
}) => (
	<Text className="m-0 mb-2 text-sm" style={{ color: emailBrand.foreground }}>
		<span style={{ color: emailBrand.muted }}>{label} · </span>
		{children}
	</Text>
);

export const BlockedTrafficAlertEmail = ({
	baselineEvents = 0,
	blockReason = "origin_not_authorized",
	blockedCount = 0,
	dashboardUrl,
	fix,
	origin,
	preferences,
	previousBlockedCount = 0,
	severity = "warning",
	silenceMinutes = 0,
	siteLabel = "your site",
	windowMinutes = 15,
}: BlockedTrafficAlertEmailProps) => {
	const critical = severity === "critical";
	const silence = formatSilence(silenceMinutes);
	const title = critical
		? `Tracking stopped for ${siteLabel}`
		: `Blocked tracking increased for ${siteLabel}`;
	const preview = critical
		? `No page views from ${siteLabel} for ${silence} while its tracking requests are being blocked.`
		: `${siteLabel} has more blocked tracking requests than usual.`;
	const accentBorder = critical ? "#dc2626" : "#f59e0b";

	return (
		<EmailLayout
			preferences={preferences}
			preview={preview}
			tagline="Tracking alert"
		>
			<Section className="text-center">
				<Heading
					className="m-0 mb-3 font-semibold text-xl tracking-tight"
					style={{ color: emailBrand.foreground }}
				>
					{title}
				</Heading>
				<Text
					className="m-0 mb-4 text-sm leading-relaxed"
					style={{ color: emailBrand.muted }}
				>
					{critical
						? `Databuddy has not received a page view from this website for ${silence}, and its tracking requests are being blocked. Before that it received ${formatNumber(baselineEvents)} page views in a week.`
						: "Databuddy is blocking more tracking requests for this website than usual."}
				</Text>
			</Section>

			<Section
				className="my-4 rounded border border-border border-l-4 border-solid p-4"
				style={{
					backgroundColor: emailBrand.inset,
					borderLeftColor: accentBorder,
				}}
			>
				<DetailRow label="Reason">{reasonLabel(blockReason)}</DetailRow>
				{origin ? <DetailRow label="Origin">{origin}</DetailRow> : null}
				<DetailRow label="Blocked">
					{formatNumber(blockedCount)} in the last {windowMinutes} minutes
				</DetailRow>
				{critical ? (
					<>
						<DetailRow label="Last page view">{silence} ago</DetailRow>
						<DetailRow label="Usual traffic">
							{formatNumber(baselineEvents)} page views in the week before
						</DetailRow>
					</>
				) : (
					<DetailRow label="Previous window">
						{formatNumber(previousBlockedCount)} blocked
					</DetailRow>
				)}
				{fix ? (
					<Text
						className="m-0 mt-3 text-sm leading-relaxed"
						style={{ color: emailBrand.foreground }}
					>
						<span style={{ color: emailBrand.muted }}>Suggested fix · </span>
						{fix}
					</Text>
				) : null}
			</Section>

			{dashboardUrl ? (
				<Section className="text-center">
					<EmailButton href={dashboardUrl}>Open website settings</EmailButton>
				</Section>
			) : null}

			<Section className="mt-8">
				<Text
					className="m-0 text-center text-xs leading-relaxed"
					style={{ color: emailBrand.muted }}
				>
					{critical
						? "You get one email per outage, and another only if tracking stops again after it recovers. "
						: ""}
					We ignore localhost and private-network origins for this alert. Need
					help? Reply to this email or visit our{" "}
					<Link
						href="https://www.databuddy.cc/docs/troubleshooting"
						style={{ color: emailBrand.coral, textDecoration: "underline" }}
					>
						troubleshooting docs
					</Link>
					.
				</Text>
			</Section>
		</EmailLayout>
	);
};

BlockedTrafficAlertEmail.PreviewProps = {
	baselineEvents: 1240,
	blockReason: "origin_not_authorized",
	blockedCount: 42,
	dashboardUrl: "https://app.databuddy.cc/websites/ws_123/settings/general",
	fix: "Update the website domain to example.com, or add example.com under Security → Allowed origins if this is an additional trusted domain.",
	origin: "https://example.com",
	preferences: {
		settingsUrl: "https://app.databuddy.cc/settings/notifications",
		unsubscribeUrl:
			"https://api.databuddy.cc/public/v1/email-unsubscribe/tracking-health",
	},
	previousBlockedCount: 0,
	severity: "critical",
	silenceMinutes: 95,
	siteLabel: "Example Site",
	windowMinutes: 15,
} satisfies BlockedTrafficAlertEmailProps;

export default BlockedTrafficAlertEmail;
