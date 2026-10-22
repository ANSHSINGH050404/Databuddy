import {
	getAccessibleWebsiteIds,
	hasKeyAllScopes,
	hasWebsiteAllScopes,
} from "@databuddy/api-keys/resolve";
import { config } from "@databuddy/env/app";
import { readBooleanEnv } from "@databuddy/env/boolean";
import { trackMcp } from "@databuddy/sdk/mcp";
import { resolveDeployCommit } from "@databuddy/shared/evlog-redaction";
import {
	bearerAuthChallengeResponse,
	createMcpHandler,
	McpServer,
	OAuthError,
	OAuthErrorCode,
	ProtocolError,
	ProtocolErrorCode,
	type Tool,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { captureError, mergeWideEvent } from "../lib/tracing";
import {
	authType,
	type McpRequestContext,
	type RegisteredMcpTool,
} from "../ai/mcp/define-tool";
import { createMcpTools } from "../ai/mcp/tools";
import { GUIDE_MARKDOWN, GUIDE_URI, MCP_INSTRUCTIONS } from "./guide";

export { flushMcp } from "@databuddy/sdk/mcp";

export interface DatabuddyMcpHttpOptions extends McpRequestContext {
	clientName?: string;
	request: Request;
}

const RESOURCE_METADATA_URL = new URL(
	"/.well-known/oauth-protected-resource",
	config.urls.mcp
).href;
const MAX_MCP_REQUEST_BYTES = 1_048_576;

export function createMcpErrorResponse(
	status: number,
	code: number,
	message: string,
	headers?: HeadersInit
): Response {
	return Response.json(
		{ jsonrpc: "2.0", error: { code, message }, id: null },
		{ status, headers }
	);
}

export function createMcpUnauthorizedResponse(): Response {
	mergeWideEvent({ mcp_auth: "unauthorized" });

	return bearerAuthChallengeResponse(
		new OAuthError(
			OAuthErrorCode.InvalidToken,
			"Authentication required. Use OAuth 2.1, or x-api-key / Authorization: Bearer with a valid Databuddy API key."
		),
		{ resourceMetadataUrl: RESOURCE_METADATA_URL }
	);
}

export function handleDatabuddyMcpRequest(
	options: DatabuddyMcpHttpOptions
): Promise<Response> {
	mergeWideEvent({
		mcp_auth: authType(options),
		mcp_session: Boolean(options.userId && !options.oauth),
		mcp_api_key: Boolean(options.apiKey),
	});
	const handler = createMcpHandler(() => createMcpServer(options), {
		maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
		onerror: (error) => mergeWideEvent({ mcp_transport_error: error.message }),
	});
	return handler.fetch(options.request).catch((error) => {
		captureError(error, { mcp_error: true });
		throw error;
	});
}

function createMcpServer(options: DatabuddyMcpHttpOptions): McpServer {
	const server = new McpServer(
		{
			name: "databuddy",
			version: resolveDeployCommit()?.slice(0, 7) ?? "1.0.0",
		},
		{ capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS }
	);

	if (!readBooleanEnv("SELFHOST")) {
		trackMcp(server, {
			beforeSend: (call) => ({
				...call,
				clientName: call.clientName ?? options.clientName,
			}),
		});
	}
	registerGuideResource(server);

	const allTools = createMcpTools(options);
	const tools = allTools.filter((tool) => callerCanCallTool(options, tool));
	server.server.setRequestHandler("tools/list", () => ({
		tools: tools.map(toListedTool),
	}));
	server.server.setRequestHandler("tools/call", ({ params }, ctx) => {
		const tool = tools.find(({ name }) => name === params.name);
		if (tool) {
			return tool.handler(params.arguments, { signal: ctx.mcpReq.signal });
		}
		const hidden = allTools.find(({ name }) => name === params.name);
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			hidden
				? `Tool ${params.name} requires scopes: ${hidden.metadata.access.scopes.join(", ")}. Reconnect or use an API key that has them.`
				: `Unknown tool: ${params.name}`
		);
	});
	return server;
}

function callerCanCallTool(
	{ apiKey, oauth }: McpRequestContext,
	tool: RegisteredMcpTool
): boolean {
	const { scopes: required, globalScopes } = tool.metadata.access;
	if (!required.length) {
		return true;
	}
	if (oauth) {
		return required.every((scope) => oauth.scopes.includes(scope));
	}
	if (!apiKey) {
		return true;
	}
	if (!hasKeyAllScopes(apiKey, globalScopes)) {
		return false;
	}
	const websiteScopes = required.filter(
		(scope) => !globalScopes.includes(scope)
	);
	return (
		hasKeyAllScopes(apiKey, websiteScopes) ||
		getAccessibleWebsiteIds(apiKey).some((websiteId) =>
			hasWebsiteAllScopes(apiKey, websiteId, websiteScopes)
		)
	);
}

function registerGuideResource(server: McpServer): void {
	server.registerResource(
		"databuddy_guide",
		GUIDE_URI,
		{
			title: "Databuddy MCP guide",
			description:
				"Reference for Databuddy MCP tools: query conventions, what insight and investigation fields mean, and the scopes each tool needs.",
			mimeType: "text/markdown",
		},
		(uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "text/markdown",
					text: GUIDE_MARKDOWN,
				},
			],
		})
	);
}

function toListedTool(tool: RegisteredMcpTool): Tool {
	return {
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: z.toJSONSchema(tool.inputSchema, {
			io: "input",
			target: "draft-7",
		}) as Tool["inputSchema"],
		...(tool.outputSchema && {
			outputSchema: z.toJSONSchema(tool.outputSchema, {
				io: "output",
				metadata: z.registry(),
				target: "draft-7",
			}) as Tool["outputSchema"],
		}),
		annotations: tool.annotations,
	};
}
