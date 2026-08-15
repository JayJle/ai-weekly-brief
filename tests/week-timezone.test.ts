import assert from "node:assert/strict";
import test from "node:test";
import { currentIsoWeek, isoWeekInTimezone, previousIsoWeekInTimezone } from "../src/events/event-repository.js";

test("ISO week helpers use configured local date and previous completed week", () => {
  const sundayUtc = new Date("2026-08-16T16:30:00Z");
  assert.equal(currentIsoWeek(sundayUtc), "2026-W33");
  assert.equal(isoWeekInTimezone("Asia/Shanghai", sundayUtc), "2026-W34");
  assert.equal(previousIsoWeekInTimezone("Asia/Shanghai", sundayUtc), "2026-W33");
});
