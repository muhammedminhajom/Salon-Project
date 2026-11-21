const integrations = [
  {
    key: "google",
    name: "Google OAuth",
    fields: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SMOKE_GOOGLE_EMAIL"],
  },
  {
    key: "twilio",
    name: "Twilio SMS OTP",
    fields: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID", "SMOKE_TWILIO_PHONE"],
    needsInput: true,
  },
  {
    key: "resend",
    name: "Resend password reset",
    fields: ["RESEND_API_KEY", "PASSWORD_RESET_FROM", "SMOKE_RESEND_EMAIL"],
    needsInput: true,
  },
  {
    key: "razorpay",
    name: "Razorpay test checkout and refund",
    fields: [
      "RAZORPAY_KEY_ID",
      "RAZORPAY_KEY_SECRET",
      "RAZORPAY_WEBHOOK_SECRET",
      "SMOKE_RAZORPAY_EMAIL",
      "SMOKE_RAZORPAY_PASSWORD",
    ],
    needsInput: true,
  },
  {
    key: "smsReminder",
    name: "Twilio SMS reminder",
    fields: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "SMOKE_REMINDER_PHONE"],
    anyFields: ["TWILIO_FROM_NUMBER", "TWILIO_MESSAGING_SERVICE_SID"],
  },
];

export const configValue = (name, env = process.env) => env[name]?.trim() || "";

export function planLiveSmoke(env) {
  if (env.CI) {
    return {
      enabled: [],
      messages: ["SKIP live integrations (interactive checks are disabled in CI)."],
      skipped: integrations.length,
    };
  }
  const enabled = [];
  const messages = [];
  for (const integration of integrations) {
    const missing = ["SMOKE_DATABASE_URL", ...integration.fields].filter((key) => !configValue(key, env));
    if (integration.anyFields && !integration.anyFields.some((key) => configValue(key, env))) {
      missing.push(integration.anyFields.join(" or "));
    }
    if (missing.length) {
      messages.push("SKIP " + integration.name + " (missing " + missing.join(", ") + ").");
    } else {
      enabled.push(integration);
    }
  }
  return { enabled, messages, skipped: messages.length };
}
