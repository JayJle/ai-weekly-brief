import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MODEL_PROVIDER_DEFINITIONS } from "../src/config.js";

test("every configured provider default model exists in the pinned Pi catalog", async () => {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  for (const [provider, definition] of Object.entries(MODEL_PROVIDER_DEFINITIONS)) {
    if (provider === "mock") continue;
    assert.ok(runtime.getModel(provider, definition.mainModel), `${provider}/${definition.mainModel}`);
    assert.ok(runtime.getModel(provider, definition.researchModel), `${provider}/${definition.researchModel}`);
  }
});
