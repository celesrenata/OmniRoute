/**
 * importer.ts — WP3 (Skill Hub): import third-party SKILL.md skill packs.
 *
 * A skill "pack" is a directory tree (or a zip of one) where each skill is a
 * sub-directory containing a `SKILL.md` (YAML frontmatter + body) plus optional
 * `references/`, `scripts/`, `assets/`. This module reads a pack, parses each
 * skill's frontmatter, runs a security scan, and installs clean skills into the
 * agent's skill root (`~/.opencode/skills/{domain}/{skill}/`), quarantining any
 * skill that trips a hard block pattern.
 *
 * Security posture: imported skills are third-party content that may carry
 * executable scripts. We NEVER auto-execute anything here — we only copy files
 * and report scan findings. Hard-blocked skills (credential leaks, eval-of-
 * base64, etc.) are quarantined, not installed, unless `force` is set.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as yaml from "js-yaml";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ImportedSkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  domain?: string;
  subdomain?: string;
  tags?: string[];
  version?: string;
  [key: string]: unknown;
}

export interface SkillScanFinding {
  file: string;
  pattern: string;
  severity: "block" | "warn";
}

export interface ImportedSkill {
  /** Sanitized skill directory name (== frontmatter.name when present). */
  slug: string;
  /** The source domain subdirectory (from frontmatter, else pack-level default). */
  domain: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  license: string | null;
  destPath: string;
  filesCopied: number;
  quarantined: boolean;
  findings: SkillScanFinding[];
}

export interface ImportManifest {
  packName: string;
  defaultDomain: string;
  imported: ImportedSkill[];
  quarantined: ImportedSkill[];
  total: number;
  root: string;
}

// ── Security scan ────────────────────────────────────────────────────────────

/**
 * Hard block patterns — a skill matching any of these is quarantined (not
 * installed) by default. Mirrors the threat set in githubCollector.ts but
 * scoped to "credential leak / dangerous self-execution" that we must not
 * surface to an agent.
 */
const BLOCK_PATTERNS: { regex: RegExp; pattern: string }[] = [
  { regex: /eval\s*\(base64/i, pattern: "eval(base64)" },
  { regex: /-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/, pattern: "private-key-block" },
  { regex: /ghp_[a-zA-Z0-9]{36,}/, pattern: "github-pat" },
  { regex: /sk-[a-zA-Z0-9]{40,}/, pattern: "openai-key" },
  { regex: /AKIA[0-9A-Z]{16}/, pattern: "aws-access-key" },
];

/** Soft warnings — reported but do not quarantine. */
const WARN_PATTERNS: { regex: RegExp; pattern: string }[] = [
  { regex: /subprocess\.Popen\(/i, pattern: "subprocess-spawn" },
  { regex: /os\.system\(/i, pattern: "os-system" },
  { regex: /eval\s*\(/i, pattern: "eval-call" },
  { regex: /password\s*[=:]\s*['"]/i, pattern: "hardcoded-password" },
  { regex: /curl[^|]*\|\s*(ba)?sh/i, pattern: "pipe-to-shell" },
];

function scanFile(file: string, content: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  for (const { regex, pattern } of BLOCK_PATTERNS) {
    if (regex.test(content)) findings.push({ file, pattern, severity: "block" });
  }
  for (const { regex, pattern } of WARN_PATTERNS) {
    if (regex.test(content)) findings.push({ file, pattern, severity: "warn" });
  }
  return findings;
}

// ── Frontmatter parsing ──────────────────────────────────────────────────────

/**
 * Parse a SKILL.md string into { frontmatter, body }. The frontmatter is the
 * leading `---` ... `---` YAML block. Returns null frontmatter if no valid
 * block is found.
 */
export function parseSkillMarkdown(md: string): {
  frontmatter: ImportedSkillFrontmatter | null;
  body: string;
} {
  // Normalize CRLF.
  const text = md.replace(/\r\n/g, "\n");
  if (!text.startsWith("---")) return { frontmatter: null, body: text };

  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: text };

  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n+/, "");
  try {
    const parsed = yaml.load(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return { frontmatter: null, body };

    const out: ImportedSkillFrontmatter = {
      name: typeof parsed.name === "string" ? parsed.name : "",
      description: typeof parsed.description === "string" ? parsed.description : "",
    };
    if (typeof parsed.license === "string") out.license = parsed.license;
    if (typeof parsed.domain === "string") out.domain = parsed.domain;
    else {
      const meta = parsed.metadata as Record<string, unknown> | undefined;
      if (meta && typeof meta.domain === "string") out.domain = meta.domain;
      if (meta && typeof meta.version === "string") out.version = meta.version;
      if (meta && typeof meta.tags === "string")
        out.tags = meta.tags.split(",").map((t) => t.trim());
      else if (meta && Array.isArray(meta.tags)) out.tags = meta.tags.map(String);
    }
    if (typeof parsed.version === "string") out.version = parsed.version;
    return { frontmatter: out, body };
  } catch {
    return { frontmatter: null, body };
  }
}

/**
 * Sanitize a string into a safe filesystem slug: lowercase, non-alphanumeric
 * runs collapsed to a single dash, trimmed.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── Directory scan ───────────────────────────────────────────────────────────

/** Find every `SKILL.md` under `dir`, returning absolute paths. */
function findSkillMd(dir: string): string[] {
  const results: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      // Skip macOS zip artifact trees.
      if (entry.isDirectory() && entry.name === "__MACOSX") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === "SKILL.md") results.push(full);
    }
  };
  walk(dir);
  return results;
}

/** Read a text file as a string, tolerating decode errors. */
function readTextSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/**
 * Copy a skill source directory to destination using Node's native recursive
 * copy (`fs.cpSync`). A hand-rolled per-file `copyFileSync` loop proved
 * flaky on deep macOS temp paths (intermittent ENOENT on source during the
 * bulk loop); the native implementation is the supported, robust path.
 * Returns the number of files copied (recounted from the destination).
 */
function copySkillDir(srcDir: string, destDir: string): number {
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, force: true });
  return countFiles(destDir);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** Skill root to install into. Defaults to `~/.opencode/skills`. */
  root?: string;
  /** Default domain for skills whose frontmatter lacks one. */
  defaultDomain?: string;
  /** Install even skills that tripped a hard block pattern. Default false. */
  force?: boolean;
  /** Dry run: scan + report without copying files. */
  dryRun?: boolean;
}

function resolveSkillRoot(root?: string): string {
  return path.resolve(root ?? path.join(os.homedir(), ".opencode", "skills"));
}

/**
 * Import every skill found under `packDir` (a single unpacked pack directory)
 * into the skill root, organized by domain. Returns a manifest.
 */
export function importSkillDirectory(packDir: string, options: ImportOptions = {}): ImportManifest {
  const root = resolveSkillRoot(options.root);
  const defaultDomain = options.defaultDomain ?? "general";
  const force = options.force ?? false;
  const dryRun = options.dryRun ?? false;

  const manifest: ImportManifest = {
    packName: path.basename(packDir),
    defaultDomain,
    imported: [],
    quarantined: [],
    total: 0,
    root,
  };

  const skillMdPaths = findSkillMd(packDir);
  for (const skillMd of skillMdPaths) {
    const skillDir = path.dirname(skillMd);
    const raw = readTextSafe(skillMd);
    const { frontmatter } = parseSkillMarkdown(raw);

    const name = frontmatter?.name || path.basename(skillDir);
    const slug = slugify(name);
    const domain = slugify(frontmatter?.domain ?? defaultDomain) || defaultDomain;
    const destPath = path.join(root, domain, slug);

    // Scan every text file in the skill dir (frontmatter body + scripts + refs).
    const findings: SkillScanFinding[] = [];
    for (const f of walkFiles(skillDir)) {
      if (isTextFile(f)) findings.push(...scanFile(path.basename(f), readTextSafe(f)));
    }

    const hasBlock = findings.some((f) => f.severity === "block");
    const quarantined = hasBlock && !force;

    if (!quarantined && !dryRun) {
      copySkillDir(skillDir, destPath);
    }

    const imported: ImportedSkill = {
      slug,
      domain,
      name,
      description: frontmatter?.description ?? "",
      version: frontmatter?.version ?? "0.0.0",
      tags: frontmatter?.tags ?? [],
      license: frontmatter?.license ?? null,
      destPath,
      filesCopied: quarantined || dryRun ? 0 : countFiles(destPath),
      quarantined,
      findings,
    };

    manifest.total += 1;
    if (quarantined) manifest.quarantined.push(imported);
    else manifest.imported.push(imported);
  }

  return manifest;
}

/**
 * Import a `.zip` skill pack by extracting it to a temp dir, importing it, and
 * cleaning up the temp dir. Returns a manifest.
 */
export function importSkillZip(zipPath: string, options: ImportOptions = {}): ImportManifest {
  const zip = path.resolve(zipPath);
  if (!fs.existsSync(zip)) throw new Error(`Skill pack not found: ${zip}`);
  // Short temp dir under /tmp (which is a symlink to /private/var/folders/...
  // but with a much shorter top-level path), so that deep skill trees do not
  // exceed macOS's 90-char per-component path limit when nested several levels.
  const base = "/tmp";
  if (!fs.existsSync(base)) throw new Error(`temp base ${base} missing`);
  const tmp = fs.mkdtempSync(path.join(base, "omr-sk-"));
  try {
    // Use the system `unzip` binary — it handles the filename encodings and
    // path shapes that pure-JS unzip libraries can choke on.
    execFileSync("unzip", ["-o", "-qq", zipPath, "-d", tmp], { stdio: "pipe" });

    // A pack may have a single top-level directory; descend into it if so.
    // macOS zips carry a parallel `__MACOSX/` artifact tree — ignore it.
    const top = fs.readdirSync(tmp, { withFileTypes: true });
    let packDir = tmp;
    const dirs = top.filter((e) => e.isDirectory() && e.name !== "__MACOSX");
    if (dirs.length === 1) packDir = path.join(tmp, dirs[0].name);

    const manifest = importSkillDirectory(packDir, options);
    manifest.packName = path.basename(zipPath, ".zip");
    return manifest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  try {
    walk(dir);
  } catch {
    /* ignore unreadable dirs */
  }
  return out;
}

function countFiles(dir: string): number {
  try {
    return walkFiles(dir).length;
  } catch {
    return 0;
  }
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".py",
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".sh",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".html",
  ".css",
  ".csv",
]);

function isTextFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}
