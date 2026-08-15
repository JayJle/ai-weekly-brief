import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText, isPrivateAddress, normalizeUrl, validatePublicUrl } from "../src/fetch/safe-fetch.js";

test("URL normalization removes tracking but preserves meaningful parameters", () => {
  assert.equal(
    normalizeUrl("https://Example.com:443/news?id=12&utm_source=x&fbclid=y#section"),
    "https://example.com/news?id=12",
  );
});

test("private network addresses are rejected", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.2"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  await assert.rejects(validatePublicUrl("http://127.0.0.1/private"), /私有/u);
  await assert.rejects(validatePublicUrl("file:///tmp/secret"), /HTTP/u);
});

test("HTML cleaner removes scripts and preserves readable text", () => {
  const text = htmlToText("<header>nav</header><p>Hello&nbsp;world</p><script>bad()</script><p>第二段</p>");
  assert.match(text, /Hello world/u);
  assert.match(text, /第二段/u);
  assert.doesNotMatch(text, /bad/u);
});
