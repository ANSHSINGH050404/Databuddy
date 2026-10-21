import { Hr, Link, Section, Text } from "@react-email/components";
import { emailBrand } from "./email-brand";

export interface EmailPreferenceLinks {
	settingsUrl: string;
	unsubscribeUrl?: string | null;
}

const linkStyle = { color: emailBrand.muted, textDecoration: "underline" };

export const EmailFooter = ({
	preferences,
}: {
	preferences?: EmailPreferenceLinks;
}) => (
	<Section className="mt-8">
		<Hr
			className="border-border border-solid"
			style={{ borderColor: emailBrand.border }}
		/>
		{preferences ? (
			<Text
				className="m-0 mb-2 text-center text-xs"
				style={{ color: emailBrand.muted }}
			>
				<Link href={preferences.settingsUrl} style={linkStyle}>
					Email settings
				</Link>
				{preferences.unsubscribeUrl ? (
					<>
						{" · "}
						<Link href={preferences.unsubscribeUrl} style={linkStyle}>
							Unsubscribe
						</Link>
					</>
				) : null}
			</Text>
		) : null}
		<Text
			className="m-0 mb-2 text-center text-xs"
			style={{ color: emailBrand.muted }}
		>
			<Link
				href="https://www.databuddy.cc"
				style={{ color: emailBrand.muted, textDecoration: "underline" }}
			>
				Website
			</Link>
			{" · "}
			<Link
				href="https://www.databuddy.cc/docs"
				style={{ color: emailBrand.muted, textDecoration: "underline" }}
			>
				Docs
			</Link>
			{" · "}
			<Link
				href="https://twitter.com/trydatabuddy"
				style={{ color: emailBrand.muted, textDecoration: "underline" }}
			>
				Twitter
			</Link>
		</Text>
		<Text
			className="m-0 text-center text-xs"
			style={{ color: emailBrand.muted }}
		>
			© {new Date().getFullYear()} Databuddy Analytics, Inc. All rights
			reserved.
		</Text>
	</Section>
);
