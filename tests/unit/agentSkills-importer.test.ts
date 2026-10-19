/**
 * WP3 (Skill Hub) — importer regression tests.
 *
 * Locks in the security posture of the skill-pack importer through its public
 * surface: hard-block content is quarantined, warning content reports findings,
 * and clean skills install cleanly. These invariants are what the WP4
 * discovery layer will build on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { parseSkillMarkdown, slugify, importSkillDirectory } =
  await import("../../src/lib/agentSkills/importer.ts");

// ─── parseSkillMarkdown ─────────────────────────────────────────────────────

test("parseSkillMarkdown — extracts YAML frontmatter + body", () => {
  const md = [
    "---",
    "name: my-skill",
    "description: A demo skill",
    "license: MIT",
    "metadata:",
    "  domain: devops",
    "  version: 1.0.0",
    "  tags: demo,test",
    "---",
    "",
    "# My Skill",
    "",
    "Do the thing.",
    "",
  ].join("\n");

  const { frontmatter, body } = parseSkillMarkdown(md);
  assert.ok(frontmatter);
  assert.equal(frontmatter.name, "my-skill");
  assert.equal(frontmatter.description, "A demo skill");
  assert.equal(frontmatter.license, "MIT");
  assert.equal(frontmatter.domain, "devops");
  assert.equal(frontmatter.version, "1.0.0");
  assert.deepEqual(frontmatter.tags, ["demo", "test"]);
  assert.ok(body.startsWith("# My Skill"));
});

test("parseSkillMarkdown — returns null frontmatter when block is missing", () => {
  const { frontmatter, body } = parseSkillMarkdown("no frontmatter here\njust body");
  assert.equal(frontmatter, null);
  assert.equal(body, "no frontmatter here\njust body");
});

test("parseSkillMarkdown — tolerates CRLF line endings", () => {
  const md = ["---", "name: crlf", "description: crlf body", "---", "body"].join("\r\n");
  const { frontmatter } = parseSkillMarkdown(md);
  assert.ok(frontmatter);
  assert.equal(frontmatter.name, "crlf");
});

// ─── slugify ────────────────────────────────────────────────────────────────

test("slugify — lowercases, trims, replaces unsafe chars", () => {
  assert.equal(slugify("  My Cool Skill  "), "my-cool-skill");
  assert.equal(slugify("with/slash:colon"), "with-slash-colon");
});

// ─── importSkillDirectory ───────────────────────────────────────────────────

function makePack(tmpRoot: string, entries: Record<string, string>): string {
  const pack = fs.mkdtempSync(path.join(tmpRoot, "pack-"));
  for (const [rel, content] of Object.entries(entries)) {
    const p = path.join(pack, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return pack;
}

test("importSkillDirectory — clean skill installs to target root", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-importer-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const pack = makePack(tmpRoot, {
    "clean-skill/SKILL.md": ["---", "name: clean-skill", "description: benign", "---", "body"].join(
      "\n"
    ),
  });
  const destRoot = path.join(tmpRoot, "dest");
  fs.mkdirSync(destRoot, { recursive: true });

  const manifest = importSkillDirectory(pack, { root: destRoot, dryRun: false });
  assert.equal(manifest.total, 1);
  assert.equal(manifest.imported.length, 1);
  assert.equal(manifest.quarantined.length, 0);
  const installed = manifest.imported[0];
  assert.equal(installed.name, "clean-skill");
  assert.ok(fs.existsSync(installed.destPath));
});

test("importSkillDirectory — hard-block skill is quarantined, not installed", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-importer-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const leakToken = `ghp_${"A".repeat(36)}`;
  const pack = makePack(tmpRoot, {
    "evil-skill/SKILL.md": [
      "---",
      "name: evil-skill",
      "description: not benign",
      "---",
      `token = "${leakToken}"`,
    ].join("\n"),
  });
  const destRoot = path.join(tmpRoot, "dest");
  fs.mkdirSync(destRoot, { recursive: true });

  const manifest = importSkillDirectory(pack, { root: destRoot, dryRun: false, force: false });
  assert.equal(manifest.total, 1);
  assert.equal(manifest.imported.length, 0);
  assert.equal(manifest.quarantined.length, 1);
  assert.equal(manifest.quarantined[0].name, "evil-skill");
  assert.ok(manifest.quarantined[0].findings.some((f) => f.severity === "block"));
  // No files copied for the quarantined skill.
  assert.equal(fs.readdirSync(destRoot).length, 0);
});

test("importSkillDirectory — dryRun leaves no files behind", (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp3-importer-"));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const pack = makePack(tmpRoot, {
    "clean-skill/SKILL.md": ["---", "name: clean-skill", "description: ok", "---", "body"].join(
      "\n"
    ),
  });
  const destRoot = path.join(tmpRoot, "dest");
  fs.mkdirSync(destRoot, { recursive: true });

  const manifest = importSkillDirectory(pack, { root: destRoot, dryRun: true });
  assert.equal(manifest.imported.length, 1);
  assert.equal(fs.readdirSync(destRoot).length, 0);
});
