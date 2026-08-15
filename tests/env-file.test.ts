import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvFile, serializeEnv } from "../src/env-file.js";

test("env parser handles comments, quotes and equals signs", () => {
  const parsed = parseEnvFile([
    "# comment",
    "MODEL_PROVIDER=mock",
    "TOKEN=abc=123",
    "NAME=\"含 空格\"",
  ].join("\n"));
  assert.deepEqual(parsed, {
    MODEL_PROVIDER: "mock",
    TOKEN: "abc=123",
    NAME: "含 空格",
  });
});

test("serialized env can be parsed back", () => {
  const values = { SIMPLE: "value", COMPLEX: "中文 value", EMPTY: "" };
  assert.deepEqual(parseEnvFile(serializeEnv(values)), values);
});
