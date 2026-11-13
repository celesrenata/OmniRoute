/**
 * src/lib/skills/skillAdmin.ts — single implementation of Skill Hub management
 * (install / remove / enable-disable), shared by the MCP tools
 * (`omr_skill_install|remove|set_enabled`) and the REST route `/api/skills/hub`.
 *
 * Skills are plain SKILL.md instruction skills written under the imported-skill
 * root (`OMNIROUTE_SKILL_ROOT`, default `~/.opencode/skills`) — the exact tree the
 * discovery catalog reads, so an installed skill is immediately searchable via
 * `omr_skill_search` / `GET /api/skills/catalog`. No handler code is stored, so
 * nothing installed here is executable (executable skills stay on
 * `/api/skills/install`, which is LOCAL_ONLY and needs `manage`).
 *
 * Errors are `SkillAdminError` with fixed, path-free messages; unexpected
 * failures collapse to a generic INTERNAL error (never raw fs messages/stacks).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";
import { importSkillDirectory, parseSkillMarkdown, slugify } from "@/lib/agentSkills/importer";
import { setCatalogSkillEnabled } from "@/lib/db/skillHub";
import { snapshotAfterMutation } from "@/lib/skills/snapshotBridge";
import {
  getCatalogSkill,
  invalidateCatalog,
  resolveImportedSkillRoot,
} from "@omniroute/open-sse/services/skillDiscovery";

export type SkillAdminErrorCode =
  "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "QUARANTINED" | "FORBIDDEN" | "INTERNAL";

const STATUS: Record<SkillAdminErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUARANTINED: 422,
  FORBIDDEN: 403,
  INTERNAL: 500,
};

export class SkillAdminError extends Error {
  readonly code: SkillAdminErrorCode;
  constructor(code: SkillAdminErrorCode, message: string) {
    super(message);
    this.name = "SkillAdminError";
    this.code = code;
  }
  get status(): number {
    return STATUS[this.code];
  }
}

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const SkillInstallSchema = z.object({
  name: z.string().min(1).max(64).describe("Skill name (becomes the directory slug)"),
  description: z.string().min(1).max(500),
  content: z
    .string()
    .min(1)
    .max(200_000)
    .describe("SKILL.md markdown body (frontmatter is generated; any supplied is replaced)"),
  domain: z
    .string()
    .regex(DOMAIN_RE, "domain must be lowercase letters, digits and dashes")
    .default("general"),
  version: z.string().min(1).max(32).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  overwrite: z.boolean().default(false),
});
export type SkillInstallInput = z.infer<typeof SkillInstallSchema>;

export const SkillIdSchema = z.object({
  id: z.string().min(1).max(300).describe("Catalog skill id, e.g. 'imported:devops/my-skill'"),
});

export const SkillSetEnabledSchema = SkillIdSchema.extend({
  enabled: z.boolean(),
});

/** True when another SKILL.md lives below `dir` (removing `dir` would delete sibling skills). */
function containsNestedSkill(dir: string): boolean {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, "SKILL.md")) || containsNestedSkill(child)) return true;
  }
  return false;
}

function rethrow(err: unknown): never {
  if (err instanceof SkillAdminError) throw err;
  throw new SkillAdminError("INTERNAL", "Skill operation failed");
}

function buildSkillMd(input: SkillInstallInput): string {
  const { body } = parseSkillMarkdown(input.content);
  const metadata: Record<string, unknown> = { domain: input.domain };
  if (input.version) metadata.version = input.version;
  if (input.tags?.length) metadata.tags = input.tags;
  const front = yaml.dump({ name: input.name, description: input.description, metadata });
  return `---\n${front}---\n\n${body.trim()}\n`;
}

export function installSkill(rawInput: unknown): {
  success: true;
  id: string;
  domain: string;
  snapshotId: string | null;
} {
  const parsed = SkillInstallSchema.safeParse(rawInput);
  if (!parsed.success) throw new SkillAdminError("VALIDATION", "Invalid skill install input");
  const input = parsed.data;
  const slug = slugify(input.name);
  if (!slug) throw new SkillAdminError("VALIDATION", "Skill name must contain letters or digits");

  const root = path.resolve(resolveImportedSkillRoot());
  const dest = path.join(root, input.domain, slug);
  const id = `imported:${input.domain}/${slug}`;
  let stage: string | null = null;
  try {
    if (fs.existsSync(dest) && !input.overwrite) {
      throw new SkillAdminError("CONFLICT", "A skill with this name already exists in the domain");
    }
    stage = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-install-"));
    const stagedDir = path.join(stage, slug);
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, "SKILL.md"), buildSkillMd(input), "utf8");

    // Dry run first so a quarantined skill never deletes an existing one.
    const dry = importSkillDirectory(stage, {
      root,
      defaultDomain: input.domain,
      dryRun: true,
    });
    if (dry.quarantined.length > 0) {
      throw new SkillAdminError("QUARANTINED", "Skill content tripped a security block pattern");
    }
    if (input.overwrite && fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    importSkillDirectory(stage, { root, defaultDomain: input.domain });

    setCatalogSkillEnabled(id, true); // a re-install must not stay hidden
    invalidateCatalog();
    const snapshotId = snapshotAfterMutation("skill-added");
    if (!getCatalogSkill(id)) throw new SkillAdminError("INTERNAL", "Skill operation failed");
    return { success: true, id, domain: input.domain, snapshotId };
  } catch (err) {
    return rethrow(err);
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function removeSkill(rawInput: unknown): {
  success: true;
  id: string;
  snapshotId: string | null;
} {
  const parsed = SkillIdSchema.safeParse(rawInput);
  if (!parsed.success) throw new SkillAdminError("VALIDATION", "Invalid skill id");
  const { id } = parsed.data;
  try {
    if (!id.startsWith("imported:")) {
      throw new SkillAdminError("FORBIDDEN", "Only imported skills can be removed");
    }
    const skill = getCatalogSkill(id);
    if (!skill || !skill.skillMdPath) throw new SkillAdminError("NOT_FOUND", "Skill not found");

    const root = fs.realpathSync(path.resolve(resolveImportedSkillRoot()));
    const dir = fs.realpathSync(path.dirname(skill.skillMdPath));
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new SkillAdminError("FORBIDDEN", "Skill is outside the managed skill root");
    }
    if (containsNestedSkill(dir)) {
      throw new SkillAdminError("FORBIDDEN", "Skill directory contains other skills");
    }
    fs.rmSync(dir, { recursive: true, force: true });
    // Drop the now-empty domain directory (best effort; rmdir only removes empty dirs).
    try {
      const parent = path.dirname(dir);
      if (parent !== root) fs.rmdirSync(parent);
    } catch {
      /* not empty or already gone */
    }
    setCatalogSkillEnabled(id, true); // clear any stale hidden-state row
    invalidateCatalog();
    return { success: true, id, snapshotId: snapshotAfterMutation("skill-deleted") };
  } catch (err) {
    return rethrow(err);
  }
}

export function setSkillEnabled(rawInput: unknown): {
  success: true;
  id: string;
  enabled: boolean;
} {
  const parsed = SkillSetEnabledSchema.safeParse(rawInput);
  if (!parsed.success) throw new SkillAdminError("VALIDATION", "Invalid skill id or enabled flag");
  const { id, enabled } = parsed.data;
  try {
    if (!getCatalogSkill(id)) throw new SkillAdminError("NOT_FOUND", "Skill not found");
    setCatalogSkillEnabled(id, enabled);
    invalidateCatalog();
    return { success: true, id, enabled };
  } catch (err) {
    return rethrow(err);
  }
}
