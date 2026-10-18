"use client";

import { authClient } from "@databuddy/auth/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryState } from "nuqs";
import { Suspense, useRef, useState } from "react";
import { toast } from "sonner";
import { safeCallbackPath } from "@/lib/safe-callback";
import { ArrowLeftIcon } from "@databuddy/ui/icons";
import { Button, Field, Input, Spinner, Text } from "@databuddy/ui";
import { Checkbox, OtpInput } from "@databuddy/ui/client";

const TOTP_LENGTH = 6;
const RECOVERY_DOCS_URL =
	"https://www.databuddy.cc/docs/security#losing-your-authenticator-and-backup-codes";
const WHITESPACE = /\s+/g;
const UNSEPARATED_BACKUP_CODE = /^[A-Za-z0-9]{10}$/;

function normalizeBackupCode(value: string): string {
	const code = value.replace(WHITESPACE, "");
	return UNSEPARATED_BACKUP_CODE.test(code)
		? `${code.slice(0, 5)}-${code.slice(5)}`
		: code;
}

const RESTART_SIGN_IN: Record<string, { title: string; description: string }> =
	{
		INVALID_TWO_FACTOR_COOKIE: {
			title: "Your sign-in expired",
			description: "Sign in again to get a new code.",
		},
		TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: {
			title: "Too many incorrect codes",
			description: "Sign in again to get a new code.",
		},
		ACCOUNT_TEMPORARILY_LOCKED: {
			title: "Two-factor sign-in is locked",
			description:
				"Too many incorrect codes were entered. Try again in a few minutes.",
		},
	};

type Method = "totp" | "backup";

interface VerifyError {
	code?: string;
	status?: number;
}

function describeRetry(error: VerifyError, method: Method) {
	if (error.status === 429) {
		return {
			title: "Too many attempts",
			description: "Wait a moment and try again.",
		};
	}
	return method === "totp"
		? {
				title: "That code didn't work",
				description: "Enter the current code from your authenticator app.",
			}
		: {
				title: "That backup code didn't work",
				description: "Each backup code can only be used once.",
			};
}

function TwoFactorPage() {
	const router = useRouter();
	const [callback] = useQueryState("callback");
	const safeCallback = safeCallbackPath(callback);
	const loginHref = `/login?callback=${encodeURIComponent(safeCallback)}`;
	const [method, setMethod] = useState<Method>("totp");
	const [code, setCode] = useState("");
	const [trustDevice, setTrustDevice] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const isVerifying = useRef(false);

	const verify = async (value: string) => {
		if (isVerifying.current) {
			return;
		}
		isVerifying.current = true;
		setIsLoading(true);
		let isLeaving = false;
		try {
			const { error } =
				method === "totp"
					? await authClient.twoFactor.verifyTotp({ code: value, trustDevice })
					: await authClient.twoFactor.verifyBackupCode({
							code: normalizeBackupCode(value),
							trustDevice,
						});
			if (!error) {
				isLeaving = true;
				window.location.assign(safeCallback);
				return;
			}
			setCode("");
			const restart = error.code ? RESTART_SIGN_IN[error.code] : undefined;
			if (restart) {
				isLeaving = true;
				toast.error(restart.title, { description: restart.description });
				router.replace(loginHref);
				return;
			}
			const { title, description } = describeRetry(error, method);
			toast.error(title, { description });
		} catch {
			toast.error("Couldn't verify your code", {
				description: "Check your connection and try again.",
			});
		} finally {
			if (!isLeaving) {
				isVerifying.current = false;
				setIsLoading(false);
			}
		}
	};

	const handleTotpChange = (value: string) => {
		setCode(value);
		if (value.length === TOTP_LENGTH) {
			verify(value);
		}
	};

	const switchMethod = () => {
		setMethod(method === "totp" ? "backup" : "totp");
		setCode("");
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (code) {
			verify(code);
		}
	};

	return (
		<>
			<div className="mb-8 space-y-1.5 px-6">
				<Text as="h1" className="text-balance font-medium text-2xl">
					Two-factor authentication
				</Text>
				<Text tone="muted">
					{method === "totp"
						? "Enter the 6-digit code from your authenticator app to finish signing in."
						: "Enter one of the backup codes you saved when you turned on two-factor authentication."}
				</Text>
			</div>

			<form className="space-y-5 px-6" onSubmit={handleSubmit}>
				{method === "totp" ? (
					<OtpInput
						aria-label="Authentication code"
						autoFocus
						length={TOTP_LENGTH}
						onChange={handleTotpChange}
						value={code}
					/>
				) : (
					<Field>
						<Field.Label>Backup code</Field.Label>
						<Input
							autoComplete="one-time-code"
							autoFocus
							name="backup-code"
							onChange={(e) => setCode(e.target.value)}
							placeholder="xxxxx-xxxxx"
							value={code}
						/>
					</Field>
				)}

				<Checkbox
					checked={trustDevice}
					description="You won't be asked for a code on this device for 30 days."
					disabled={isLoading}
					label="Trust this device"
					onCheckedChange={setTrustDevice}
				/>

				<Button
					className="w-full"
					disabled={
						method === "totp" ? code.length !== TOTP_LENGTH : !code.trim()
					}
					loading={isLoading}
					type="submit"
				>
					Verify and sign in
				</Button>

				<Button
					className="w-full"
					disabled={isLoading}
					onClick={switchMethod}
					variant="ghost"
				>
					{method === "totp"
						? "Use a backup code instead"
						: "Use your authenticator app instead"}
				</Button>

				{method === "backup" && (
					<Text className="text-center" tone="muted" variant="caption">
						Lost your backup codes too?{" "}
						<a
							className="font-medium text-accent-foreground hover:text-accent-foreground/80"
							href={RECOVERY_DOCS_URL}
							rel="noopener"
							target="_blank"
						>
							Recover your account
						</a>
					</Text>
				)}
			</form>

			<div className="mt-5 flex items-center justify-center px-6">
				<Link
					className="text-[13px] text-accent-foreground/60 duration-200 hover:text-accent-foreground"
					href={loginHref}
				>
					<ArrowLeftIcon className="mr-1 inline size-3" />
					Back to sign in
				</Link>
			</div>
		</>
	);
}

export default function Page() {
	return (
		<Suspense
			fallback={
				<div className="flex h-40 items-center justify-center">
					<Spinner size="lg" />
				</div>
			}
		>
			<TwoFactorPage />
		</Suspense>
	);
}
