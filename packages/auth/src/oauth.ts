import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { isUniqueViolationFor } from "@databuddy/db";
import { config } from "@databuddy/env/app";
import { API_SCOPES } from "@databuddy/shared/api-scopes";
import { MCP_API_SCOPES } from "@databuddy/shared/mcp-access";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { jwt } from "better-auth/plugins";
import { log } from "evlog";
import { baseAuthOptions } from "./auth";
import {
	mcpAccessTokenClaims,
	mcpConsentAccess,
	mcpPostLogin,
} from "./mcp-grant";

const database: typeof baseAuthOptions.database = (options) => {
	const adapter = baseAuthOptions.database(options);
	return {
		...adapter,
		create: <T extends Record<string, unknown>, R = T>(
			data: Parameters<typeof adapter.create<T, R>>[0]
		) =>
			adapter.create<T, R>(data).catch((error) => {
				// oauth-provider treats a concurrent resource seed as a no-op only when
				// the error message says "duplicate"; Drizzle keeps that in `cause`.
				if (
					data.model === "oauthResource" &&
					error instanceof Error &&
					error.cause instanceof Error &&
					isUniqueViolationFor(error, "oauth_resource_identifier_unique")
				) {
					throw error.cause;
				}
				throw error;
			}),
	};
};

const IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"];

// Clients such as Vercel Connect omit the RFC 8707 resource, which otherwise
// yields an opaque token the MCP server cannot verify. Defaulting it at
// authorization stores it with the code, so the code and refresh grants inherit it.
const mcpDefaultResource = {
	id: "mcp-default-resource",
	hooks: {
		before: [
			{
				matcher: (context) => context.path === "/oauth2/authorize",
				handler: createAuthMiddleware((ctx) => {
					const source = ctx.method === "POST" ? "body" : "query";
					const params = ctx[source] as Record<string, unknown> | undefined;
					return Promise.resolve(
						params?.resource || params?.request_uri
							? undefined
							: {
									context: {
										[source]: { ...params, resource: config.urls.mcp },
									},
								}
					);
				}),
			},
		],
	},
} satisfies BetterAuthPlugin;

function createMcpOAuthPlugins() {
	try {
		return [
			mcp({
				loginPage: "/login",
				consentPage: "/consent",
				postLogin: mcpPostLogin,
				customAccessTokenClaims: mcpAccessTokenClaims,
				resource: config.urls.mcp,
				scopes: [...IDENTITY_SCOPES, ...API_SCOPES],
				advertisedMetadata: {
					scopes_supported: [...IDENTITY_SCOPES, ...MCP_API_SCOPES],
				},
				rateLimit: { token: { window: 60, max: 600 } },
			}),
			cimd({
				fetchClientMetadataResource,
				metadataProfile: "mcp-2026-07-28",
			}),
			mcpConsentAccess,
			mcpDefaultResource,
		];
	} catch (error) {
		log.warn({
			service: "auth",
			mcp_oauth_disabled: true,
			mcp_resource: config.urls.mcp,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

const mcpOAuthPlugins = createMcpOAuthPlugins();

export const mcpOAuthEnabled = mcpOAuthPlugins.length > 0;

export const oauthAuthOptions = {
	...baseAuthOptions,
	database,
	disabledPaths: [
		"/oauth2/create-client",
		"/oauth2/update-client",
		"/oauth2/client/rotate-secret",
	],
	plugins: [
		...baseAuthOptions.plugins,
		jwt({ disableSettingJwtHeader: true }),
		...mcpOAuthPlugins,
	],
};

export const oauthAuth = betterAuth(oauthAuthOptions);
