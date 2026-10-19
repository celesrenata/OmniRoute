#!/usr/bin/env tsx
/**
 * import-skills.ts — WP3 (Skill Hub): import third-party skill packs.
 *
 * Usage:
 *   node --import tsx/esm scripts/skills/import-skills.ts [options]
 *
 * Options:
 *   --dir <path>     Import every .zip in <path> (default: <repo>/skills-import)
 *   --zip <file>     Import a single .zip file
 *   --root <path>    Skill root (default: ~/.opencode/skills)
 *   --dry-run        Scan + report without copying
 *   --force          Install skills that trip a hard security block
 *   --domain <name>  Default domain for skills missing one
 *   --json           Print the aggregate manifest as JSON
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importSkillZip, type ImportManifest } from "../../src/lib/agentSkills/importer";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        args[key] = argv[++i];
      } else {
        args[key] = "1";
      }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const root = args.root
    ? path.resolve(args.root)
    : path.join(process.env.HOME!, ".opencode", "skills");
  const dryRun = Boolean(args["dry-run"]);
  const options = {
    root,
    dryRun,
    force: Boolean(args.force),
    defaultDomain: args.domain ?? "general",
  };

  let packs: string[] = [];
  if (args.zip) {
    packs = [path.resolve(args.zip)];
  } else {
    const dir = path.resolve(args.dir ?? path.join(repoRoot, "skills-import"));
    if (!fs.existsSync(dir)) {
      console.error(`Pack directory not found: ${dir}`);
      process.exit(1);
    }
    packs = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".zip"))
      .map((f) => path.join(dir, f));
  }

  if (packs.length === 0) {
    console.error("No .zip packs found to import.");
    process.exit(1);
  }

  const manifests: ImportManifest[] = [];
  for (const pack of packs) {
    process.stdout.write(`Importing ${path.basename(pack)} ... `);
    try {
      const mf = importSkillZip(pack, options);
      manifests.push(mf);
      console.log(
        `${mf.imported.length} imported, ${mf.quarantined.length} quarantined (${mf.total} scanned)`
      );
    } catch (err) {
      console.log(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const totalImported = manifests.reduce((n, m) => n + m.imported.length, 0);
  const totalQuarantined = manifests.reduce((n, m) => n + m.quarantined.length, 0);

  const quarantinedByName = manifests.flatMap((m) =>
    m.quarantined.map((s) => ({
      pack: m.packName,
      name: s.name,
      patterns: s.findings.map((f) => f.pattern),
    }))
  );

  if (args.json) {
    console.log(
      JSON.stringify({ root, dryRun, manifests, quarantined: quarantinedByName }, null, 2)
    );
  }

  if (totalQuarantined > 0) {
    console.log(`\n⚠ ${totalQuarantined} skill(s) quarantined by the security scan:`);
    for (const q of quarantinedByName.slice(0, 20)) {
      console.log(`  - [${q.pack}] ${q.name}: ${q.patterns.join(", ")}`);
    }
    if (quarantinedByName.length > 20)
      console.log(`  ... and ${quarantinedByName.length - 20} more`);
  }

  console.log(
    `\n${dryRun ? "[dry-run] Would install" : "Installed"} ${totalImported} skills into ${root}`
  );
  if (!dryRun)
    console.log(
      "Note: imported skills are third-party content — review before executing any bundled scripts."
    );
}

main();
