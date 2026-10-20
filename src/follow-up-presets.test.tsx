import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpPreset } from "../shared/follow-up-presets";
import { localTimeInput } from "../shared/commitment-dates";

test("follow-up presets use local calendar days through DST, month and year rollover", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    for (const [from, expected, elapsedHours] of [
      ["2026-03-07T09:00", "2026-03-08T09:00", 23],
      ["2026-10-31T09:00", "2026-11-01T09:00", 25],
      ["2026-12-31T09:00", "2027-01-01T09:00", 24],
      ["2028-02-28T09:00", "2028-02-29T09:00", 24],
    ] as const) {
      const now = new Date(from).getTime();
      const at = followUpPreset("tomorrow", now)!;
      assert.equal(localTimeInput(at), expected);
      assert.equal((at - now) / 3600000, elapsedHours);
    }
    assert.equal(localTimeInput(followUpPreset("monday", new Date("2026-10-19T08:00").getTime())!), "2026-10-26T09:00", "Monday always means next Monday");
    assert.equal(localTimeInput(followUpPreset("monday", new Date("2026-10-18T23:59").getTime())!), "2026-10-19T09:00");
    assert.equal(localTimeInput(followUpPreset("later", new Date("2026-10-18T16:59").getTime())!), "2026-10-18T17:00");
    assert.equal(followUpPreset("later", new Date("2026-10-18T17:00").getTime()), undefined);
    assert.equal(followUpPreset("later", new Date("2026-10-18T23:59").getTime()), undefined);
    for (const zone of ["Pacific/Kiritimati", "Asia/Bangkok", "America/Los_Angeles"]) {
      process.env.TZ = zone;
      assert.equal(localTimeInput(followUpPreset("tomorrow", new Date("2026-12-31T23:59").getTime())!), "2027-01-01T09:00");
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
