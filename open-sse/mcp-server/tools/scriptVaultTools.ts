/**
 * scriptVaultTools.ts - MCP tools for Script Vault
 *
 * These tools allow agents to interact with the script vault system
 */
import { z } from "zod";
import { ScriptVaultManager } from "@/lib/scripts/scriptVault";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { resolveMcpToolOwnerId } from "../mcpCallerIdentity.ts";
import type { McpToolExtraLike } from "../scopeEnforcement.ts";

/**
 * Resolve the caller's API key ID for script vault operations
 *
 * Ensures that tools respect the caller's identity to prevent unauthorized access
 */
async function resolveScriptVaultOwnerId(
  explicit?: string,
  extra?: McpToolExtraLike
): Promise<string> {
  return (await resolveMcpToolOwnerId(extra, explicit)) ?? "system";
}

/**
 * Search scripts in the vault
 */
export const scriptVaultSearch = {
  name: "script_vault_search",
  description: "Search for available scripts in the vault by name, description, or tags",
  scopes: ["read:scripts"],
  inputSchema: z
    .object({
      query: z.string().min(1).max(200).describe("Search query text"),
      limit: z.number().int().min(1).max(50).default(10).describe("Maximum results to return"),
      tags: z.array(z.string()).max(10).optional().describe("Filter by specific tags (optional)"),
      status: z
        .enum(["active", "deprecated", "archived"])
        .optional()
        .describe("Filter by status (optional)"),
    })
    .strict(),
  handler: async (args: {
    query: string;
    limit?: number;
    tags?: string[];
    status?: "active" | "deprecated" | "archived";
  }) => {
    try {
      const ownerId = await resolveScriptVaultOwnerId();
      const { scripts, total } = await ScriptVaultManager.listScripts({
        query: args.query,
        tags: args.tags || [],
        status: args.status,
        limit: args.limit || 10,
        offset: 0,
      });

      return {
        results: scripts.map((script) => ({
          id: script.id,
          name: script.name,
          version: script.version,
          description: script.description,
          createdAt: script.createdAt,
          updatedAt: script.updatedAt,
          tags: (script.tags || "").split(",").filter(Boolean),
          status: script.status,
          installCount: script.installCount,
        })),
        total,
        query: args.query,
      };
    } catch (error) {
      throw new Error(`Script vault search failed: ${sanitizeErrorMessage(error)}`);
    }
  },
};

/**
 * Get a specific script by ID
 */
export const scriptVaultGet = {
  name: "script_vault_get",
  description: "Retrieve a specific script entry by its unique ID",
  scopes: ["read:scripts"],
  inputSchema: z
    .object({
      id: z.string().min(1).max(100).describe("Unique script ID"),
    })
    .strict(),
  handler: async (args: { id: string }) => {
    try {
      const ownerId = await resolveScriptVaultOwnerId();
      const script = await ScriptVaultManager.getScriptById(args.id);

      if (!script) {
        return { error: "Script not found" };
      }

      return {
        id: script.id,
        name: script.name,
        version: script.version,
        description: script.description,
        content: script.scriptContent,
        hash: script.hash,
        metadata: script.metadata ? JSON.parse(script.metadata) : {},
        createdAt: script.createdAt,
        updatedAt: script.updatedAt,
        createdBy: script.createdBy,
        tags: (script.tags || "").split(",").filter(Boolean),
        status: script.status,
        installCount: script.installCount,
      };
    } catch (error) {
      throw new Error(`Failed to retrieve script: ${sanitizeErrorMessage(error)}`);
    }
  },
};

/**
 * Install a script (increments its install count)
 */
export const scriptVaultInstall = {
  name: "script_vault_install",
  description: "Mark a script as installed, increasing its installation count",
  scopes: ["write:scripts"],
  inputSchema: z
    .object({
      id: z.string().min(1).max(100).describe("Unique script ID to install"),
      reason: z.string().max(200).optional().describe("Reason for installation (optional)"),
    })
    .strict(),
  handler: async (args: { id: string; reason?: string }) => {
    try {
      const ownerId = await resolveScriptVaultOwnerId();
      const incremented = await ScriptVaultManager.incrementInstallCount(args.id);

      if (!incremented) {
        return { error: "Script not found or failed to increment install count" };
      }

      return {
        success: true,
        message: "Script install count incremented successfully",
      };
    } catch (error) {
      throw new Error(`Installation failed: ${sanitizeErrorMessage(error)}`);
    }
  },
};

/**
 * List available scripts in the vault
 */
export const scriptVaultList = {
  name: "script_vault_list",
  description: "List all scripts in the vault with pagination",
  scopes: ["read:scripts"],
  inputSchema: z
    .object({
      limit: z.number().int().min(1).max(50).default(20).describe("Number of scripts to return"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      status: z
        .enum(["active", "deprecated", "archived"])
        .optional()
        .describe("Filter by status (optional)"),
    })
    .strict(),
  handler: async (args: {
    limit?: number;
    offset?: number;
    status?: "active" | "deprecated" | "archived";
  }) => {
    try {
      const ownerId = await resolveScriptVaultOwnerId();
      const { scripts, total } = await ScriptVaultManager.listScripts({
        limit: args.limit || 20,
        offset: args.offset || 0,
        status: args.status,
      });

      return {
        scripts: scripts.map((script) => ({
          id: script.id,
          name: script.name,
          version: script.version,
          description: script.description,
          createdAt: script.createdAt,
          updatedAt: script.updatedAt,
          tags: (script.tags || "").split(",").filter(Boolean),
          status: script.status,
          installCount: script.installCount,
        })),
        total,
        limit: args.limit || 20,
        offset: args.offset || 0,
      };
    } catch (error) {
      throw new Error(`Failed to list scripts: ${sanitizeErrorMessage(error)}`);
    }
  },
};

/**
 * Register a new script in the vault
 */
export const scriptVaultRegister = {
  name: "script_vault_register",
  description: "Register a new script in the script vault",
  scopes: ["write:scripts"],
  inputSchema: z
    .object({
      name: z.string().min(1).max(100).describe("Human-readable name for the script"),
      version: z.string().min(1).max(20).describe("Semantic version (e.g., 1.0.0)"),
      description: z.string().max(500).describe("Brief description of the script"),
      scriptContent: z
        .string()
        .min(1)
        .max(500000)
        .describe("Raw script content (not base64 or compressed)"),
      metadata: z
        .object({
          author: z.string().max(100).optional().describe("Author of the script (optional)"),
          license: z.string().max(50).optional().describe("License information (optional)"),
          dependencies: z
            .record(z.string(), z.string())
            .optional()
            .describe("Dependencies mapping (optional)"),
          category: z.string().max(50).optional().describe("Category for the script (optional)"),
          tags: z
            .array(z.string())
            .max(10)
            .optional()
            .describe("Tags for categorization (optional)"),
        })
        .optional()
        .describe("Additional metadata about the script (optional)"),
      createdBy: z.string().min(1).max(100).optional().describe("Creator identifier (optional)"),
    })
    .strict(),
  handler: async (args: {
    name: string;
    version: string;
    description: string;
    scriptContent: string;
    metadata?: {
      author?: string;
      license?: string;
      dependencies?: Record<string, string>;
      category?: string;
      tags?: string[];
    };
    createdBy?: string;
  }) => {
    try {
      const ownerId = await resolveScriptVaultOwnerId(args.createdBy);

      // Prepare metadata for storage
      const metadataObj = args.metadata || {};
      const tags = metadataObj.tags || [];

      const fullMetadata = {
        author: metadataObj.author,
        license: metadataObj.license,
        dependencies: metadataObj.dependencies,
        category: metadataObj.category || "general",
        tags: tags,
        version: args.version,
        description: args.description,
      };

      const script = await ScriptVaultManager.registerScript(
        args.name,
        args.version,
        args.description,
        args.scriptContent,
        fullMetadata,
        ownerId
      );

      return {
        success: true,
        script: {
          id: script.id,
          name: script.name,
          version: script.version,
          description: script.description,
          createdAt: script.createdAt,
          updatedAt: script.updatedAt,
          createdBy: script.createdBy,
          tags: (script.tags || "").split(",").filter(Boolean),
          status: script.status,
          installCount: script.installCount,
        },
        message: `Script "${script.name}" registered successfully`,
      };
    } catch (error) {
      throw new Error(`Failed to register script: ${sanitizeErrorMessage(error)}`);
    }
  },
};

export const scriptVaultTools = [
  scriptVaultSearch,
  scriptVaultGet,
  scriptVaultInstall,
  scriptVaultList,
  scriptVaultRegister,
];
