import { Heading, Section, Text } from "@react-email/components";
import { emailBrand } from "./email-brand";
import { EmailButton } from "./email-button";
import { EmailLayout } from "./email-layout";
import { EmailNote } from "./email-note";

export type SecurityChange =
	| "two_factor_enabled"
	| "two_factor_disabled"
	| "two_factor_recovery_requested"
	| "two_factor_recovered"
	| "backup_codes_regenerated";

const SECURITY_CHANGE_COPY: Record<
	SecurityChange,
	{ subject: string; heading: string; body: string; ifNotYou: string }
> = {
	two_factor_enabled: {
		subject: "Two-factor authentication is on for your Databuddy account",
		heading: "Two-factor authentication is on",
		body: "Every new sign-in to your account will now ask for a code from your authenticator app or one of your backup codes, and your other devices were signed out.",
		ifNotYou:
			"If you did not turn this on, reset your password and review your account settings.",
	},
	two_factor_disabled: {
		subject:
			"Two-factor authentication was turned off for your Databuddy account",
		heading: "Two-factor authentication is off",
		body: "Signing in to your account no longer asks for a code from your authenticator app or a backup code.",
		ifNotYou:
			"If you did not turn this off, reset your password right away and turn two-factor authentication back on.",
	},
	two_factor_recovery_requested: {
		subject:
			"Someone asked to reset two-factor authentication on your Databuddy account",
		heading: "Two-factor reset requested",
		body: "Databuddy support received a request to turn off two-factor authentication on your account because the authenticator and backup codes were lost. If that was you, there is nothing else to do, and the reset can finish after a two-day waiting period.",
		ifNotYou:
			"If you did not ask for this, sign in to your account, which cancels the request, then change your password and tell support.",
	},
	two_factor_recovered: {
		subject: "Two-factor authentication was reset for your Databuddy account",
		heading: "Two-factor authentication was reset",
		body: "Two-factor authentication was turned off through account recovery, and your account was signed out on every device so you can sign in again and set it up fresh.",
		ifNotYou:
			"If you did not ask for this, reset your password and contact support right away.",
	},
	backup_codes_regenerated: {
		subject: "New backup codes were created for your Databuddy account",
		heading: "Your backup codes changed",
		body: "New two-factor backup codes were created for your account, and the codes you saved before no longer work.",
		ifNotYou:
			"If you did not create new codes, reset your password and generate a fresh set from your account settings.",
	},
};

export const securityChangeSubject = (change: SecurityChange) =>
	SECURITY_CHANGE_COPY[change].subject;

interface SecurityChangeEmailProps {
	change: SecurityChange;
	settingsUrl: string;
}

export const SecurityChangeEmail = ({
	change,
	settingsUrl,
}: SecurityChangeEmailProps) => {
	const copy = SECURITY_CHANGE_COPY[change];
	return (
		<EmailLayout preview={copy.body} tagline="Account security">
			<Section className="text-center">
				<Heading
					className="m-0 mb-3 font-semibold text-xl tracking-tight"
					style={{ color: emailBrand.foreground }}
				>
					{copy.heading}
				</Heading>
				<Text
					className="m-0 mb-6 text-sm leading-relaxed"
					style={{ color: emailBrand.muted }}
				>
					{copy.body}
				</Text>
			</Section>
			<Section className="text-center">
				<EmailButton href={settingsUrl}>Review account security</EmailButton>
			</Section>
			<EmailNote>{copy.ifNotYou}</EmailNote>
		</EmailLayout>
	);
};

SecurityChangeEmail.PreviewProps = {
	change: "two_factor_disabled",
	settingsUrl: "https://app.databuddy.cc/settings/account",
} satisfies SecurityChangeEmailProps;

export default SecurityChangeEmail;
