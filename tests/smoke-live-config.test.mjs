import assert from "node:assert/strict";
import { test } from "node:test";
import { planLiveSmoke } from "../scripts/smoke-live-config.mjs";

test("live smoke lists every skipped integration without credentials", () => {
  const { enabled, messages, skipped } = planLiveSmoke({});
  assert.deepEqual(enabled, []);
  assert.equal(skipped, 5);
  assert.match(messages[0], /SKIP Google OAuth \(missing .*GOOGLE_CLIENT_SECRET/);
  assert.match(messages[1], /SKIP Twilio SMS OTP \(missing .*SMOKE_TWILIO_PHONE/);
  assert.match(messages[2], /SKIP Resend password reset \(missing .*SMOKE_RESEND_EMAIL/);
  assert.match(messages[3], /SKIP Razorpay test checkout and refund \(missing .*SMOKE_RAZORPAY_PASSWORD/);
  assert.match(messages[4], /SKIP Twilio SMS reminder \(missing .*SMOKE_REMINDER_PHONE/);
});

test("skip diagnostics never echo partial credentials or a test number", () => {
  const values = { TWILIO_AUTH_TOKEN: "private-smoke-test-fixture", SMOKE_TWILIO_PHONE: "+12025550123" };
  const { enabled, messages } = planLiveSmoke(values);
  assert.deepEqual(enabled, []);
  assert.match(messages[1], /SKIP Twilio SMS OTP/);
  for (const value of Object.values(values)) {
    assert.ok(!messages.join("\n").includes(value));
  }
});

test("a configured service stays disabled in CI", () => {
  const values = {
    GOOGLE_CLIENT_ID: "unused",
    GOOGLE_CLIENT_SECRET: "unprinted-fixture",
    SMOKE_GOOGLE_EMAIL: "fixture@example.test",
    SMOKE_DATABASE_URL: "fixture-database",
  };
  assert.deepEqual(
    planLiveSmoke(values).enabled.map(({ key }) => key),
    ["google"],
  );
  const { enabled, messages, skipped } = planLiveSmoke({ ...values, CI: "true" });
  assert.deepEqual(enabled, []);
  assert.equal(skipped, 5);
  assert.match(messages[0], /interactive checks are disabled in CI/);
  assert.doesNotMatch(messages.join("\n"), /unprinted-fixture|fixture-database/);
});
