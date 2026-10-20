/**
 * scriptVault.ts - Core Script Vault implementation
 *
 * This module implements versioned, provenance-aware executable script registry
 */
import {
  createScript,
  getScript,
  getScriptByVersion,
  listScripts,
  searchScripts,
  updateScript,
  deleteScript,
  incrementInstallCount,
  calculateScriptHash,
  Script,
} from "@/lib/db/scripts";
import { logger } from "../../../open-sse/utils/logger.ts";
import { sanitizeErrorMessage } from "../../../open-sse/utils/error.ts";
import { z } from "zod";

const log = logger("SCRIPT_VAULT");

export interface ScriptMetadata {
  author?: string;
  license?: string;
  dependencies?: Record<string, string>;
  category?: string;
  tags: string[];
  version: string;
  description: string;
  // Add more metadata fields as needed
}

/**
 * Script Vault manager - handles storing, retrieving, and managing scripts.
 */
export class ScriptVaultManager {
  public static async initialize(): Promise<void> {
    try {
      // Schema is initialized via migration - no additional setup needed
      log.info("Script vault initialized successfully");
    } catch (error) {
      log.error("Failed to initialize script vault:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * Import a script from zip file contents
   */
  public static async importFromZip(zipContents: Buffer, metadata?: any): Promise<Script> {
    try {
      // For now, we'll assume we receive a valid script file content
      const scriptContent = zipContents.toString("utf-8");

      // Calculate the hash
      const hash = calculateScriptHash(scriptContent);

      // Generate a name from metadata or create a UUID
      const name = metadata?.name || `script-${crypto.randomUUID().slice(0, 8)}`;
      const version = metadata?.version || "1.0.0";
      const description = metadata?.description || "Imported script";
      const author = metadata?.author;
      const license = metadata?.license;
      const category = metadata?.category || "general";

      // Create metadata JSON string
      const tags = [category, ...(metadata?.tags || [])];
      const scriptMetadata = {
        author,
        license,
        dependencies: metadata?.dependencies,
        category,
        tags: [...new Set(tags)].filter(Boolean).join(","),
        version,
        description,
      };

      // Create the new script entry
      const scriptData = {
        name,
        version,
        description,
        scriptContent,
        hash,
        metadata: JSON.stringify(scriptMetadata),
        createdBy: metadata?.createdBy || "system",
        tags: scriptMetadata.tags,
        status: "active" as const,
        installCount: 0,
      };

      const script = await createScript(scriptData);
      log.info(`Successfully imported script "${script.name}" version ${script.version}`);
      return script;
    } catch (error) {
      log.error("Failed to import script from zip:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * Get a script by ID
   */
  public static async getScriptById(id: string): Promise<Script | null> {
    try {
      const script = await getScript(id);
      return script;
    } catch (error) {
      log.error("Failed to get script by ID:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * Get a script by name and version
   */
  public static async getScriptByVersion(name: string, version: string): Promise<Script | null> {
    try {
      const script = await getScriptByVersion(name, version);
      return script;
    } catch (error) {
      log.error("Failed to get script by version:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * List scripts with optional filtering
   */
  public static async listScripts(options?: {
    query?: string;
    tags?: string[];
    status?: "active" | "deprecated" | "archived";
    limit?: number;
    offset?: number;
  }): Promise<{ scripts: Script[]; total: number }> {
    try {
      const result = await listScripts(options);
      return result;
    } catch (error) {
      log.error("Failed to list scripts:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * Search scripts by text query
   */
  public static async search(query: string, limit = 20): Promise<Script[]> {
    try {
      const results = await searchScripts(query, limit);
      return results;
    } catch (error) {
      log.error("Failed to search scripts:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * Update script metadata
   */
  public static async updateScript(
    id: string,
    updates: Partial<Omit<Script, "id" | "created_at" | "created_by">>
  ): Promise<Script | null> {
    try {
      const updated = await updateScript(id, updates);
      return updated;
    } catch (error) {
      log.error("Failed to update script:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * Delete a script
   */
  public static async deleteScript(id: string): Promise<boolean> {
    try {
      const deleted = await deleteScript(id);
      return deleted;
    } catch (error) {
      log.error("Failed to delete script:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * Increment install count for a script
   */
  public static async incrementInstallCount(id: string): Promise<boolean> {
    try {
      const incremented = await incrementInstallCount(id);
      return incremented;
    } catch (error) {
      log.error("Failed to increment install count:", sanitizeErrorMessage(error));
      throw error;
    }
  }

  /**
   * Register a script with metadata
   */
  public static async registerScript(
    name: string,
    version: string,
    description: string,
    scriptContent: string,
    metadata: ScriptMetadata,
    createdBy: string = "system"
  ): Promise<Script> {
    try {
      // Validate that script isn't too large
      if (scriptContent.length > 500000) {
        // 500KB limit
        throw new Error("Script content too large. Max 500KB allowed.");
      }

      // Calculate hash for integrity
      const hash = calculateScriptHash(scriptContent);

      // Create metadata JSON string
      const metadataString = JSON.stringify({
        author: metadata.author,
        license: metadata.license,
        dependencies: metadata.dependencies,
        category: metadata.category,
        tags: metadata.tags.join(","),
        version: metadata.version,
        description: metadata.description,
      });

      // Save to the database
      const scriptData = {
        name,
        version,
        description,
        scriptContent,
        hash,
        metadata: metadataString,
        createdBy,
        tags: metadata.tags.join(","),
        status: "active" as const,
        installCount: 0,
      };

      const script = await createScript(scriptData);

      log.info(`Successfully registered script "${script.name}" version ${script.version}`);
      return script;
    } catch (error) {
      log.error("Failed to register script:", sanitizeErrorMessage(error));
      throw error;
    }
  }
}
