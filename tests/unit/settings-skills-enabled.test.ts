import test from "node:test";
import assert from "node:assert/strict";
import { resetDbInstance } from "@/lib/db/core";
import { updateSettings, type Settings } from "@/lib/db/settings";
import { getSettings } from "@/lib/db/settings";
import { validateBody } from "@/shared/validation/helpers";
import { updateSettingsSchema } from "@/shared/validation/settingsSchemas";

test("skillsEnabled default is true", async () => {
  resetDbInstance();
  const settings = await getSettings();
  assert.strictEqual(settings.skillsEnabled, true);
});

test("PATCH can set skillsEnabled to false", async () => {
  resetDbInstance();
  await updateSettings({ skillsEnabled: false }, { expectedRevision: 0 });
  const updated = await getSettings();
  assert.strictEqual(updated.skillsEnabled, false);
});

test("PATCH can set skillsEnabled to true", async () => {
  resetDbInstance();
  // After test 2, revision should be 1; we need the current revision
  const settings1 = await getSettings();
  const rev = (settings1 as Settings).settingsRevision || 1;
  await updateSettings({ skillsEnabled: true }, { expectedRevision: rev });
  const updated = await getSettings();
  assert.strictEqual(updated.skillsEnabled, true);
});

test("updateSettingsSchema accepts skillsEnabled", () => {
  assert.strictEqual(validateBody(updateSettingsSchema, { skillsEnabled: true }).success, true);
  assert.strictEqual(validateBody(updateSettingsSchema, { skillsEnabled: false }).success, true);
  assert.strictEqual(validateBody(updateSettingsSchema, {}).success, true);
});
