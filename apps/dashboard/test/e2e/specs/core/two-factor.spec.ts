import type { Page } from "@playwright/test";
import { expect, test } from "@/test/e2e/fixtures";
import { expectDashboardReady } from "@/test/e2e/utils/dashboard";
import { totpCode } from "@/test/e2e/utils/totp";

const CURRENT_PASSWORD = "DatabuddyE2E!123";
const LOGIN_PASSWORD_LABEL_RE = /^Password\*?$/;
const TWO_FACTOR_PATH_RE = /\/login\/two-factor/;
const VERIFY_TOTP_ROUTE = "**/api/auth/two-factor/verify-totp";

async function signOutAndEnterPassword(page: Page, email: string) {
	await page
		.getByRole("button", { name: "Account", exact: true })
		.filter({ hasText: email })
		.click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/login/);
	await page.getByRole("textbox", { name: "Email" }).fill(email);
	await page.getByLabel(LOGIN_PASSWORD_LABEL_RE).fill(CURRENT_PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(TWO_FACTOR_PATH_RE);
}

test("turns on two-factor authentication and signs back in with an authenticator code or a backup code", {
	tag: "@core",
}, async ({ authenticatedPage: page, e2eSession }) => {
	await page.goto("/settings/account");
	await page.getByRole("button", { name: "Enable", exact: true }).click();

	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Password").fill(CURRENT_PASSWORD);
	await dialog.getByRole("button", { name: "Continue" }).click();
	await dialog
		.getByRole("button", { name: "Can't scan? Enter code manually" })
		.click();
	const secret = (await dialog.locator("code").first().textContent()) ?? "";
	expect(secret).not.toBe("");
	await dialog.getByRole("button", { name: "I've scanned it" }).click();
	await dialog
		.getByRole("textbox", { name: "Authentication code" })
		.fill(totpCode(secret));
	await dialog.getByRole("button", { name: "Verify and enable" }).click();
	await expect(
		dialog.getByRole("heading", { name: "Save your backup codes" })
	).toBeVisible();
	const [backupCode = ""] = await dialog.locator("code").allTextContents();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(page.getByRole("button", { name: "Manage" })).toBeVisible();

	await signOutAndEnterPassword(page, e2eSession.email);
	const codeInput = page.getByRole("textbox", { name: "Authentication code" });
	await page.route(VERIFY_TOTP_ROUTE, (route) => route.abort());
	await codeInput.fill(totpCode(secret));
	await expect(page.getByText("Couldn't verify your code")).toBeVisible();
	await page.unroute(VERIFY_TOTP_ROUTE);

	await codeInput.fill(totpCode(secret) === "000000" ? "111111" : "000000");
	await expect(page.getByText("That code didn't work")).toBeVisible();
	await expect(codeInput).toBeFocused();

	await codeInput.fill(totpCode(secret));
	await expectDashboardReady(page);

	await signOutAndEnterPassword(page, e2eSession.email);
	await page.getByRole("button", { name: "Use a backup code instead" }).click();
	await page
		.getByRole("textbox", { name: "Backup code" })
		.fill(backupCode.replace("-", ""));
	await page.getByRole("button", { name: "Verify and sign in" }).click();
	await expectDashboardReady(page);
});
