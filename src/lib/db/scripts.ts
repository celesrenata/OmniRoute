/**
 * scripts.ts — Script vault database module.
 *
 * Manages versioned, provenance-aware script artifacts with metadata.
 */
import { getDbInstance } from "./core";
import { logger } from "@omniroute/open-sse/utils/logger.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { z } from "zod";
import { basename, dirname } from "path";
import { createHash } from "crypto";

const log = logger("SCRIPTS_DB");

export interface Script {
  id: string;
  name: string;
  version: string;
  description: string;
  scriptContent: string;
  hash: string;
  metadata: string; // JSON string
  createdAt: string;
  updatedAt: string;
  createdBy: string; // API key ID or user identifier
  tags: string; // Comma-separated tags
  status: "active" | "deprecated" | "archived";
  installCount: number;
}

export interface ScriptSearchOptions {
  query?: string;
  tags?: string[];
  status?: "active" | "deprecated" | "archived";
  limit?: number;
  offset?: number;
}

const ScriptCreateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(20),
  description: z.string().max(500),
  scriptContent: z.string().min(1),
  hash: z.string().min(1).max(128), // SHA-256 hash
  metadata: z.string().max(10000), // JSON string
  createdBy: z.string().min(1).max(100),
  tags: z.string().max(200), // Comma-separated tags
  status: z.enum(["active", "deprecated", "archived"]).default("active"),
});

/**
 * Initialize the script vault schema if it doesn't exist (called at startup)
 */
export function initializeScriptVaultSchema(): void {
  const db = getDbInstance();

  try {
    // Create scripts table with all required fields
    db.exec(`
      CREATE TABLE IF NOT EXISTS script_vault (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT,
        script_content TEXT NOT NULL,
        hash TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        created_by TEXT NOT NULL,
        tags TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        install_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(name, version)
      )
    `);

    // Create indexes for performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_script_vault_name ON script_vault(name);
      CREATE INDEX IF NOT EXISTS idx_script_vault_created_by ON script_vault(created_by);
      CREATE INDEX IF NOT EXISTS idx_script_vault_status ON script_vault(status);
      CREATE INDEX IF NOT EXISTS idx_script_vault_tags ON script_vault(tags);
      CREATE INDEX IF NOT EXISTS idx_script_vault_updated_at ON script_vault(updated_at);
    `);

    log.info("Script vault schema initialized successfully");
  } catch (error) {
    const errorMessage = sanitizeErrorMessage(error);
    log.error("Failed to initialize script vault schema:", errorMessage);
    throw error;
  }
}

/**
 * Create a new script in the vault
 */
export async function createScript(
  script: Omit<Script, "id" | "createdAt" | "updatedAt"> & { id?: string }
): Promise<Script> {
  const db = getDbInstance();

  try {
    const parsed = ScriptCreateSchema.parse(script);

    const id = script.id || crypto.randomUUID();
    const now = new Date().toISOString();

    const inserted = db
      .prepare(
        `
      INSERT INTO script_vault (
        id, name, version, description, script_content, hash, metadata, 
        created_by, tags, status, install_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name, version) DO NOTHING
    `
      )
      .get(
        id,
        parsed.name,
        parsed.version,
        parsed.description,
        parsed.scriptContent,
        parsed.hash,
        parsed.metadata,
        parsed.createdBy,
        parsed.tags,
        parsed.status,
        parsed.installCount,
        now,
        now
      );

    if (!inserted) {
      throw new Error(`Script '${parsed.name}' version '${parsed.version}' already exists`);
    }

    const result = db
      .prepare(
        `
      SELECT * FROM script_vault 
      WHERE id = ?
    `
      )
      .get(id) as Script;

    return result;
  } catch (error) {
    log.error("Failed to create script:", sanitizeErrorMessage(error));
    throw error;
  }
}

/**
 * Get a script by ID
 */
export async function getScript(id: string): Promise<Script | null> {
  const db = getDbInstance();

  try {
    const result = db
      .prepare(
        `
      SELECT * FROM script_vault WHERE id = ?
    `
      )
      .get(id) as Script | null;

    return result || null;
  } catch (error) {
    log.error("Failed to retrieve script:", sanitizeErrorMessage(error));
    throw error;
  }
}

/**
 * Get a script by name and version
 */
export async function getScriptByVersion(name: string, version: string): Promise<Script | null> {
  const db = getDbInstance();

  try {
    const result = db
      .prepare(
        `
      SELECT * FROM script_vault WHERE name = ? AND version = ?
    `
      )
      .get(name, version) as Script | null;

    return result || null;
  } catch (error) {
    log.error("Failed to retrieve script:", sanitizeErrorMessage(error));
    throw error;
  }
}

/**
 * List scripts with filtering and pagination
 */
export async function listScripts(
  options: ScriptSearchOptions = {}
): Promise<{ scripts: Script[]; total: number }> {
  const db = getDbInstance();

  try {
    const whereConditions: string[] = [];
    const params: any[] = [];

    if (options.query) {
      whereConditions.push("(name LIKE ? OR description LIKE ? OR metadata LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`, `%${options.query}%`);
    }

    if (options.tags?.length) {
      const tagsParam = options.tags.join(",");
      whereConditions.push(`tags LIKE ?`);
      params.push(`%${tagsParam}%`);
    }

    if (options.status) {
      whereConditions.push("status = ?");
      params.push(options.status);
    }

    const whereClause = whereConditions.length ? `WHERE ${whereConditions.join(" AND ")}` : "";

    const countQuery = `
      SELECT COUNT(*) as count FROM script_vault ${whereClause}
    `;

    const countResult = db.prepare(countQuery).get(...params);
    const total = (countResult as any).count;

    const limit = options.limit || 20;
    const offset = options.offset || 0;

    const listQuery = `
      SELECT * FROM script_vault ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `;

    const scripts = db.prepare(listQuery).all(...params, limit, offset) as Script[];

    return { scripts, total };
  } catch (error) {
    log.error("Failed to list scripts:", sanitizeErrorMessage(error));
    throw error;
  }
}

/**
 * Search scripts by query
 */
export async function searchScripts(query: string, limit: number = 20): Promise<Script[]> {
  const db = getDbInstance();

  try {
    const results = db
      .prepare(
        `
      SELECT * FROM script_vault
      WHERE name LIKE ? OR description LIKE ? OR metadata LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `
      )
      .all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as Script[];

    return results;
  } catch (error) {
    log.error("Failed to search scripts:", sanitizeErrorMessage(error));
    throw error;
  }
}

/**
 * Update a script's metadata
 */
export async function updateScript(
  id: string,
  updates: Partial<Omit<Script, "id" | "created_at" | "created_by">>
): Promise<Script | null> {
  const db = getDbInstance();

  try {
    const now = new Date().toISOString();

    // Prepare SET clause dynamically
    const updatesArray = Object.entries(updates)
      .filter(([_, value]) => value !== undefined)
      .map(([key]) => `${key} = ?`);

    if (updatesArray.length === 0) {
      return await getScript(id);
    }

    const updateValues = Object.values(updates)
      .filter((value) => value !== undefined)
      .concat(now, id);

    const setClause = updatesArray.join(", ");

    db.prepare(
      `
      UPDATE script_vault SET ${setClause}, updated_at = ? WHERE id = ?
    `
    ).run(...updateValues);

    return await getScript(id);
  } catch (error) {
    log.error("Failed to update script:", sanitizeErrorMessage(error));
    throw error;
  }
}

/**
 * Delete a script by ID
 */
export async function deleteScript(id: string): Promise<boolean> {
  const db = getDbInstance();

  try {
    const result = db
      .prepare(
        `
      DELETE FROM script_vault WHERE id = ?
    `
      )
      .run(id);

    return result.changes > 0;
  } catch (error) {
    log.error("Failed to delete script:", sanitizeErrorMessage(error));
    throw error;
  }
}

/**
 * Increment script install count
 */
export async function incrementInstallCount(id: string): Promise<boolean> {
  const db = getDbInstance();

  try {
    const result = db
      .prepare(
        `
      UPDATE script_vault SET install_count = install_count + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') 
      WHERE id = ?
    `
      )
      .run(id);

    return result.changes > 0;
  } catch (error) {
    log.error("Failed to increment script install count:", sanitizeErrorMessage(error));
    throw error;
  }
}

/**
 * Calculate SHA256 hash of script content
 */
export function calculateScriptHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
