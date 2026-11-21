import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, cp } from "node:fs/promises";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { configValue, planLiveSmoke } from "./smoke-live-config.mjs";

const checks = { google, twilio, resend, razorpay, smsReminder };
const minute = 60_000;

class SmokeError extends Error {}

function requireCondition(condition, message) {
  if (!condition) throw new SmokeError(message);
}

function parseUrl(value, message) {
  try {
    return new URL(value);
  } catch {
    throw new SmokeError(message);
  }
}

function getTarget() {
  const host = "127.0.0.1";
  const origin = parseUrl(configValue("SMOKE_APP_URL") || "http://127.0.0.1:3014", "Invalid SMOKE_APP_URL.");
  requireCondition(
    origin.protocol === "http:" &&
      origin.hostname === host &&
      Number(origin.port) > 0 &&
      origin.pathname === "/" &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash,
    "SMOKE_APP_URL must be a loopback HTTP origin with an explicit port on 127.0.0.1.",
  );
  const databaseUrl = configValue("SMOKE_DATABASE_URL");
  const database = parseUrl(databaseUrl, "Invalid SMOKE_DATABASE_URL.");
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  requireCondition(
    ["postgres:", "postgresql:"].includes(database.protocol) &&
      loopback.has(database.hostname) &&
      database.pathname.length > 1 &&
      !database.searchParams.has("host"),
    "SMOKE_DATABASE_URL must name a disposable local PostgreSQL database.",
  );
  const primaryUrl = configValue("DATABASE_URL");
  if (primaryUrl) {
    const primary = parseUrl(primaryUrl, "Invalid DATABASE_URL. Check the project environment.");
    requireCondition(
      !loopback.has(primary.hostname) ||
        (primary.port || "5432") !== (database.port || "5432") ||
        decodeURIComponent(primary.pathname) !== decodeURIComponent(database.pathname),
      "Choose a different database for SMOKE_DATABASE_URL than the one used by the app.",
    );
  }
  return { host, origin: origin.origin, port: Number(origin.port), databaseUrl };
}

async function checkPort({ host, port }) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", () =>
      reject(new SmokeError("The smoke app port is unavailable. Check SMOKE_APP_URL.")),
    );
    probe.listen(port, host, () => probe.close(resolve));
  });
}

function startNode(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: "ignore", windowsHide: true });
  const stopped = new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
  return { child, stopped };
}

async function stopNode({ child, stopped }) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await stopped;
}

async function waitFor(read, timeout, signal) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    signal.throwIfAborted();
    const result = await read();
    if (result) return result;
    await delay(1000, undefined, { signal });
  }
  return null;
}

function httpClient(origin, signal) {
  const jar = new Map();
  return async (path, body) => {
    const headers = { Cookie: [...jar].map(([name, value]) => name + "=" + value).join("; ") };
    if (body) {
      headers.Origin = origin;
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body && JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    for (const entry of response.headers.getSetCookie()) {
      const cookie = entry.split(";")[0];
      const separator = cookie.indexOf("=");
      if (separator >= 0) jar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
    }
    let data;
    if (response.headers.get("content-type")?.includes("application/json")) data = await response.json();
    else await response.body?.cancel();
    return { status: response.status, data, location: response.headers.get("location") };
  };
}

function expectReply(reply, status, operation, code) {
  requireCondition(
    reply.status === status && (!code || reply.data?.code === code),
    operation + " returned HTTP " + reply.status + " (expected " + status + ").",
  );
  return reply.data;
}

async function privateInput(message, signal, onInterrupt, timeout = 5 * minute) {
  console.log(message);
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const prompt = createInterface({ input: process.stdin, output: silent, terminal: true, historySize: 0 });
  prompt.once("SIGINT", onInterrupt);
  try {
    const answer = await prompt.question("", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    return answer.trim();
  } finally {
    prompt.close();
    silent.end();
  }
}

async function google({ origin, db, signal, client }) {
  const email = configValue("SMOKE_GOOGLE_EMAIL").toLowerCase();
  const before = await db.user.findUnique({
    where: { email },
    select: { id: true, googleSub: true, role: true, sessions: { select: { id: true } } },
  });
  requireCondition(
    !before || (before.googleSub && before.role === "CUSTOMER"),
    "Use a fresh Google test email or one already linked to a Customer by Google in the smoke database.",
  );
  const existingSessionIds = new Set(before?.sessions.map(({ id }) => id));
  const signInPath = "/api/auth/google?next=/appointments";
  const redirect = await client()(signInPath);
  expectReply(redirect, 302, "Starting Google sign-in");
  const authorize = parseUrl(redirect.location, "Google sign-in returned an invalid redirect.");
  requireCondition(
    authorize.origin === "https://accounts.google.com" &&
      authorize.searchParams.get("client_id") === configValue("GOOGLE_CLIENT_ID") &&
      authorize.searchParams.get("redirect_uri") === origin + "/api/auth/google-callback" &&
      authorize.searchParams.get("response_type") === "code",
    "Google client ID or callback URI does not match the smoke app configuration.",
  );
  console.log(
    "Open " +
      origin +
      signInPath +
      " in your regular browser and sign in with the configured Google test account.",
  );
  const signedIn = await waitFor(
    async () => {
      const user = await db.user.findUnique({
        where: { email },
        select: {
          id: true,
          googleSub: true,
          role: true,
          passwordHash: true,
          phone: true,
          customer: { select: { userId: true } },
          sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } },
        },
      });
      if (user?.sessions.some(({ id }) => !existingSessionIds.has(id))) return user;
      return null;
    },
    5 * minute,
    signal,
  );
  requireCondition(
    signedIn,
    "Google sign-in timed out. Check the registered callback URI, client secret, and consent settings.",
  );
  requireCondition(
    signedIn.googleSub &&
      signedIn.customer &&
      signedIn.role === "CUSTOMER" &&
      !signedIn.passwordHash &&
      !signedIn.phone &&
      (!before || (before.id === signedIn.id && before.googleSub === signedIn.googleSub)),
    "Google did not create or reuse the expected Customer account and session.",
  );
  return (
    "the real callback " +
    (before ? "reused the linked Customer" : "created a Customer") +
    " and issued a session"
  );
}

async function twilio({ signal, client, onInterrupt }) {
  const phone = configValue("SMOKE_TWILIO_PHONE");
  requireCondition(/^\+[1-9]\d{7,14}$/.test(phone), "SMOKE_TWILIO_PHONE must be in E.164 format.");
  const request = client();
  const send = async () => {
    const result = expectReply(await request("/api/auth/otp-send", { phone }), 200, "Sending the live SMS");
    requireCondition(result?.challenge && result.expiresIn === 300, "Expected a five-minute OTP challenge.");
    return { challenge: result.challenge, received: Date.now() };
  };
  const verify = (challenge, code) => request("/api/auth/otp-check", { challenge, code });
  async function readCode(message) {
    const code = await privateInput(message + " Input is hidden.", signal, onInterrupt, 4 * minute);
    requireCondition(/^\d{4,8}$/.test(code), "Enter the digits from the received SMS.");
    return code;
  }

  const first = await send();
  expectReply(await request("/api/auth/otp-send", { phone }), 429, "Immediate SMS resend", "RATE_LIMITED");
  const validCode = await readCode(
    "Enter the first SMS code for the test number ending **" + phone.slice(-2) + ".",
  );
  const verified = expectReply(await verify(first.challenge, validCode), 200, "Verifying the delivered code");
  requireCondition(
    verified?.user?.role === "CUSTOMER" && verified.user.phone === phone,
    "SMS sign-in did not return the expected Customer.",
  );
  const viewer = expectReply(await request("/api/auth/me"), 200, "Reading the live SMS session");
  requireCondition(viewer?.user?.id === verified.user.id, "SMS sign-in did not establish a session.");
  expectReply(await verify(first.challenge, validCode), 400, "Reusing the consumed OTP", "INVALID_CODE");

  await delay(Math.max(0, first.received + 46_000 - Date.now()), undefined, { signal });
  const expiring = await send();
  const expiringCode = await readCode("Enter the second SMS code for the expiry test.");
  console.log("Waiting for the five-minute application challenge to expire.");
  await delay(Math.max(0, expiring.received + 301_000 - Date.now()), undefined, { signal });
  expectReply(
    await verify(expiring.challenge, expiringCode),
    400,
    "Verifying an expired challenge",
    "INVALID_CODE",
  );

  const limited = await send();
  const latestCode = await readCode(
    "Enter the third SMS code so the runner can derive a guaranteed incorrect attempt.",
  );
  const wrongCode = String((Number(latestCode[0]) + 1) % 10) + latestCode.slice(1);
  for (let attempt = 0; attempt < 5; attempt++) {
    const reply = await verify(limited.challenge, wrongCode);
    requireCondition(
      (reply.status === 400 && reply.data?.code === "INVALID_CODE") ||
        (reply.status === 429 && reply.data?.code !== "RATE_LIMITED"),
      "An incorrect OTP did not reach the expected verification path.",
    );
  }
  expectReply(
    await verify(limited.challenge, latestCode),
    429,
    "The sixth verification attempt",
    "RATE_LIMITED",
  );
  return "real SMS delivery, sign-in, resend cooldown, single use, expiry and the five-attempt limit";
}

async function resend({ origin, client, db, signal, onInterrupt }) {
  const email = configValue("SMOKE_RESEND_EMAIL").toLowerCase();
  requireCondition(
    !(await db.user.findUnique({ where: { email }, select: { id: true } })),
    "Use a dedicated Resend recipient that is unused in the smoke database.",
  );
  const request = client();
  const original = randomBytes(32).toString("base64url");
  const replacement = randomBytes(32).toString("base64url");
  const registration = expectReply(
    await request("/api/auth/register", { name: "Live reset smoke fixture", email, password: original }),
    201,
    "Creating the reset fixture",
  );
  requireCondition(
    registration?.user?.id && registration.user.role === "CUSTOMER",
    "The reset fixture was not created.",
  );
  try {
    expectReply(
      await request("/api/auth/password-reset-request", { email }),
      202,
      "Requesting a real reset email",
    );
    const pasted = await privateInput(
      "Paste the complete reset link received in the configured inbox. Input is hidden.",
      signal,
      onInterrupt,
      10 * minute,
    );
    const url = parseUrl(pasted, "The pasted reset link is invalid.");
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    requireCondition(
      url.origin === origin &&
        url.pathname === "/account/reset-password" &&
        !url.search &&
        !url.username &&
        !url.password &&
        /^[A-Za-z0-9_-]{43}$/.test(token || ""),
      "The link does not match this smoke app or is missing the reset token.",
    );
    expectReply(await request(url.pathname), 200, "Opening the reset page");
    const resetPath = "/api/auth/password-reset-complete";
    expectReply(
      await request(resetPath, { token, password: replacement }),
      200,
      "Redeeming the emailed link",
    );
    expectReply(
      await request(resetPath, { token, password: original }),
      400,
      "Reusing the same reset link",
      "INVALID_RESET_TOKEN",
    );
    const viewer = expectReply(await request("/api/auth/me"), 200, "Reading the old session");
    requireCondition(viewer?.user === null, "The password reset did not revoke the old session.");
    expectReply(
      await request("/api/auth/login", { email, password: original }),
      401,
      "Signing in with the original password",
    );
    expectReply(
      await request("/api/auth/login", { email, password: replacement }),
      200,
      "Signing in with the new password",
    );
    return "the real email arrived, the link worked once, and the previous password and session were rejected";
  } finally {
    await db.user.deleteMany({ where: { id: registration.user.id, email } });
  }
}

async function postSignedWebhook(origin, eventId, payload, signal) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = createHmac("sha256", configValue("RAZORPAY_WEBHOOK_SECRET")).update(body).digest("hex");
  const response = await fetch(origin + "/api/webhooks/razorpay", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Event-Id": eventId,
      "X-Razorpay-Signature": signature,
    },
    body,
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  let data;
  if (response.headers.get("content-type")?.includes("application/json")) data = await response.json();
  else await response.body?.cancel();
  return { status: response.status, data };
}

async function runOneShotJobs(env, signal) {
  const worker = startNode(["--import", "tsx", "scripts/jobs.ts"], env);
  const stop = () => worker.child.kill();
  signal.addEventListener("abort", stop, { once: true });
  try {
    const code = await worker.stopped;
    signal.throwIfAborted();
    requireCondition(code === 0, "The isolated notification or refund worker failed.");
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

async function removeRazorpayFixture(db, fixture) {
  if (!fixture) return;
  const bookingIds = fixture.bookingId ? [fixture.bookingId] : [];
  const providerIds = fixture.providerId ? [fixture.providerId] : [];
  const customerIds = fixture.customerId ? [fixture.customerId] : [];
  const ownerIds = fixture.ownerId ? [fixture.ownerId] : [];
  const userIds = [...customerIds, ...ownerIds];
  const notificationFilters = [
    ...(bookingIds.length ? [{ bookingId: { in: bookingIds } }] : []),
    ...(customerIds.length ? [{ userId: { in: customerIds } }] : []),
  ];
  if (notificationFilters.length) await db.notifications.deleteMany({ where: { OR: notificationFilters } });
  if (bookingIds.length) {
    await db.couponUsage.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await db.review.deleteMany({ where: { bookingId: { in: bookingIds } } });
    await db.invoice.deleteMany({ where: { bookingId: { in: bookingIds }, parentInvoiceId: { not: null } } });
    await db.invoice.deleteMany({ where: { bookingId: { in: bookingIds } } });
  }
  const ledgerFilters = [
    ...(bookingIds.length ? [{ bookingId: { in: bookingIds } }] : []),
    ...(providerIds.length ? [{ providerId: { in: providerIds } }] : []),
  ];
  if (ledgerFilters.length) {
    const entries = await db.ledgerEntry.findMany({
      where: { OR: ledgerFilters },
      select: { batchId: true },
    });
    const batchIds = [...new Set(entries.map(({ batchId }) => batchId))];
    if (batchIds.length) {
      await db.ledgerEntry.deleteMany({ where: { batchId: { in: batchIds } } });
      await db.ledgerBatch.deleteMany({ where: { id: { in: batchIds } } });
    }
  }
  if (bookingIds.length) {
    const paymentIds = await db.payment.findMany({
      where: { bookingId: { in: bookingIds } },
      select: { gatewayPaymentId: true },
    });
    const gatewayPaymentIds = paymentIds.flatMap(({ gatewayPaymentId }) =>
      gatewayPaymentId ? [gatewayPaymentId] : [],
    );
    if (gatewayPaymentIds.length)
      await db.gatewayEvent.deleteMany({ where: { gatewayPaymentId: { in: gatewayPaymentIds } } });
  }
  const auditFilters = [
    ...(bookingIds.length || providerIds.length
      ? [{ targetId: { in: [...bookingIds, ...providerIds] } }]
      : []),
    ...(userIds.length ? [{ actorId: { in: userIds } }] : []),
  ];
  if (auditFilters.length) await db.auditLog.deleteMany({ where: { OR: auditFilters } });
  if (bookingIds.length) await db.booking.deleteMany({ where: { id: { in: bookingIds } } });
  if (providerIds.length) {
    await db.payoutRequest.deleteMany({ where: { providerId: { in: providerIds } } });
    await db.service.deleteMany({ where: { providerId: { in: providerIds } } });
    await db.staff.deleteMany({ where: { providerId: { in: providerIds } } });
    await db.branch.deleteMany({ where: { providerId: { in: providerIds } } });
    await db.providerProfile.deleteMany({ where: { id: { in: providerIds } } });
  }
  if (fixture.categoryId) await db.serviceCategory.deleteMany({ where: { id: fixture.categoryId } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function razorpay({ origin, client, db, signal }) {
  requireCondition(
    configValue("RAZORPAY_KEY_ID").startsWith("rzp_test_"),
    "Razorpay live smoke accepts test-mode keys only. Set RAZORPAY_KEY_ID to an rzp_test_ key.",
  );
  requireCondition(
    configValue("SMOKE_RAZORPAY_EMAIL").includes("@") && configValue("SMOKE_RAZORPAY_PASSWORD").length >= 14,
    "Set a fresh SMOKE_RAZORPAY_EMAIL and a password of at least 14 characters.",
  );
  const email = configValue("SMOKE_RAZORPAY_EMAIL").toLowerCase();
  requireCondition(
    !(await db.user.findUnique({ where: { email }, select: { id: true } })),
    "Use a fresh Razorpay smoke email that is unused in the disposable smoke database.",
  );
  let fixture;
  const request = client();
  try {
    const registration = expectReply(
      await request("/api/auth/register", {
        name: "Razorpay payment smoke",
        email,
        password: configValue("SMOKE_RAZORPAY_PASSWORD"),
      }),
      201,
      "Creating the disposable payment customer",
    );
    requireCondition(
      registration?.user?.id && registration.user.role === "CUSTOMER",
      "The Razorpay smoke customer was not created as a Customer.",
    );
    fixture = { customerId: registration.user.id };
    const owner = await db.user.create({ data: { name: "Payment smoke provider", role: "PROVIDER" } });
    fixture.ownerId = owner.id;
    const category = await db.serviceCategory.create({
      data: { id: "smoke-" + randomUUID(), name: "Payment smoke", position: 9000 },
    });
    fixture.categoryId = category.id;
    const provider = await db.providerProfile.create({
      data: {
        ownerId: owner.id,
        slug: "payment-smoke-" + randomUUID(),
        type: "SHOP",
        status: "APPROVED",
        displayName: "Payment smoke salon",
        city: "Kochi",
        autoConfirm: true,
        freeRefundHours: 24,
        noRefundHours: 0,
        cancellationFeeBps: 0,
      },
    });
    fixture.providerId = provider.id;
    const branch = await db.branch.create({
      data: { providerId: provider.id, name: "Smoke branch", address: "Kochi", timeZone: "Asia/Kolkata" },
    });
    const staff = await db.staff.create({
      data: {
        providerId: provider.id,
        branchId: branch.id,
        name: "Smoke stylist",
        windows: {
          create: Array.from({ length: 7 }, (_, index) => ({
            dayOfWeek: index + 1,
            startMinute: 600,
            endMinute: 1140,
          })),
        },
      },
    });
    const service = await db.service.create({
      data: {
        providerId: provider.id,
        categoryId: category.id,
        name: "Test-mode checkout",
        duration: 45,
        pricePaise: 120_000,
        staff: { create: { staffId: staff.id } },
      },
    });
    await db.financeSetting.upsert({ where: { id: "platform" }, update: {}, create: { id: "platform" } });
    const startsAt = new Date(Date.now() + 3 * 86_400_000);
    startsAt.setUTCHours(5, 30, 0, 0);
    if (startsAt.getTime() < Date.now() + 2 * 86_400_000) startsAt.setUTCDate(startsAt.getUTCDate() + 1);
    const booking = expectReply(
      await request("/api/bookings", {
        providerId: provider.id,
        branchId: branch.id,
        staffId: staff.id,
        serviceIds: [service.id],
        mode: "VENUE",
        paymentMode: "FULL_ONLINE",
        startsAt: startsAt.toISOString(),
        requestKey: randomUUID(),
      }),
      201,
      "Creating a disposable full-online booking",
    );
    fixture.bookingId = booking.booking.id;
    const order = expectReply(
      await request("/api/payments", { action: "order", bookingId: fixture.bookingId }),
      200,
      "Creating a Razorpay test-mode order",
    );
    requireCondition(
      order?.orderId && order.currency === "INR" && order.amount === 120_000,
      "The Razorpay test-mode order did not match the INR booking amount.",
    );
    console.log(
      "Sign in at " +
        origin +
        "/account using SMOKE_RAZORPAY_EMAIL and its local .env password, then open /appointments and pay the pending booking with a Razorpay test card. Keep the checkout tab open while this runner waits.",
    );
    const captured = await waitFor(
      async () =>
        db.payment
          .findUnique({
            where: { bookingId: fixture.bookingId },
            select: {
              status: true,
              gatewayOrderId: true,
              gatewayPaymentId: true,
              gatewayCapturedPaise: true,
              gatewayFeePaise: true,
            },
          })
          .then((payment) => (payment?.status === "CAPTURED" && payment.gatewayPaymentId ? payment : null)),
      5 * minute,
      signal,
    );
    requireCondition(
      captured && captured.gatewayOrderId && captured.gatewayCapturedPaise === order.amount,
      "The test checkout was not captured before its payment hold expired.",
    );
    const paymentEntity = {
      id: captured.gatewayPaymentId,
      order_id: captured.gatewayOrderId,
      amount: captured.gatewayCapturedPaise,
      currency: "INR",
      status: "captured",
      fee: captured.gatewayFeePaise,
    };
    const paymentEventId = "smoke-payment-" + randomUUID();
    const paymentEvent = { event: "payment.captured", payload: { payment: { entity: paymentEntity } } };
    const firstPaymentWebhook = await postSignedWebhook(origin, paymentEventId, paymentEvent, signal);
    requireCondition(
      firstPaymentWebhook.status === 200 && firstPaymentWebhook.data?.duplicate === false,
      "The signed payment.captured webhook was not accepted.",
    );
    const replayPaymentWebhook = await postSignedWebhook(origin, paymentEventId, paymentEvent, signal);
    requireCondition(
      replayPaymentWebhook.status === 200 && replayPaymentWebhook.data?.duplicate === true,
      "The repeated payment webhook was not safely recognized as a replay.",
    );
    const preview = expectReply(
      await request("/api/bookings/" + fixture.bookingId + "/cancel"),
      200,
      "Previewing the test booking refund",
    );
    requireCondition(
      preview?.preview?.refundPaise === captured.gatewayCapturedPaise,
      "The disposable booking does not qualify for its full test-mode refund.",
    );
    expectReply(
      await request("/api/bookings/" + fixture.bookingId + "/cancel", {
        requestKey: randomUUID(),
        destination: "ORIGINAL",
        expectedRefundPaise: preview.preview.refundPaise,
      }),
      200,
      "Requesting a test-mode refund to the original payment method",
    );
    await runOneShotJobs(
      {
        ...process.env,
        DATABASE_URL: configValue("SMOKE_DATABASE_URL"),
        APP_URL: origin,
        AUTH_SECRET: randomBytes(32).toString("hex"),
        DATA_SECRET: randomBytes(32).toString("hex"),
        COOKIE_SECURE: "false",
        NODE_ENV: "production",
        RAZORPAY_KEY_ID: configValue("RAZORPAY_KEY_ID"),
        RAZORPAY_KEY_SECRET: configValue("RAZORPAY_KEY_SECRET"),
        RAZORPAY_WEBHOOK_SECRET: configValue("RAZORPAY_WEBHOOK_SECRET"),
        RESEND_API_KEY: configValue("RESEND_API_KEY"),
        PASSWORD_RESET_FROM: configValue("PASSWORD_RESET_FROM"),
        NOTIFICATION_EMAIL_FROM: configValue("NOTIFICATION_EMAIL_FROM"),
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
      },
      signal,
    );
    const processedRefund = await waitFor(
      () =>
        db.refund.findFirst({
          where: { payment: { bookingId: fixture.bookingId }, status: "PROCESSED" },
          select: {
            id: true,
            gatewayRefundId: true,
            gatewayPaise: true,
            payment: { select: { gatewayPaymentId: true } },
          },
        }),
      60_000,
      signal,
    );
    requireCondition(
      processedRefund?.gatewayRefundId && processedRefund.gatewayPaise === captured.gatewayCapturedPaise,
      "Razorpay did not process the test-mode refund.",
    );
    const refundEventId = "smoke-refund-" + randomUUID();
    const refundEvent = {
      event: "refund.processed",
      payload: {
        refund: {
          entity: {
            id: processedRefund.gatewayRefundId,
            payment_id: processedRefund.payment.gatewayPaymentId,
            amount: processedRefund.gatewayPaise,
            currency: "INR",
            status: "processed",
            notes: { refund_id: processedRefund.id },
          },
        },
      },
    };
    const firstRefundWebhook = await postSignedWebhook(origin, refundEventId, refundEvent, signal);
    requireCondition(
      firstRefundWebhook.status === 200 && firstRefundWebhook.data?.duplicate === false,
      "The signed refund.processed webhook was not accepted.",
    );
    const replayRefundWebhook = await postSignedWebhook(origin, refundEventId, refundEvent, signal);
    requireCondition(
      replayRefundWebhook.status === 200 && replayRefundWebhook.data?.duplicate === true,
      "The repeated refund webhook was not safely recognized as a replay.",
    );
    return "a live test-mode order, browser capture and signature verification, replay-protected payment/refund webhooks, and a gateway refund";
  } finally {
    await removeRazorpayFixture(db, fixture);
  }
}

async function smsReminder({ db, signal }) {
  const phone = configValue("SMOKE_REMINDER_PHONE");
  requireCondition(/^\+[1-9]\d{7,14}$/.test(phone), "SMOKE_REMINDER_PHONE must be in E.164 format.");
  let user = await db.user.findUnique({ where: { phone }, select: { id: true, role: true } });
  let createdUser = false;
  if (user) {
    requireCondition(user.role === "CUSTOMER", "Use a reminder number linked to a Customer account.");
  } else {
    user = await db.user.create({
      data: {
        name: "SMS reminder smoke",
        phone,
        role: "CUSTOMER",
        customer: { create: {} },
      },
      select: { id: true, role: true },
    });
    createdUser = true;
  }
  const notification = await db.notifications.create({
    data: {
      userId: user.id,
      eventType: "BOOKING_REMINDER",
      channel: "SMS",
      idempotencyKey: "smoke-reminder:" + randomUUID(),
      title: "Appointment reminder",
      subject: "",
      body: "Bloom & Blush test reminder. No appointment was booked.",
    },
  });
  try {
    await runOneShotJobs(
      {
        ...process.env,
        DATABASE_URL: configValue("SMOKE_DATABASE_URL"),
        APP_URL: configValue("SMOKE_APP_URL") || "http://127.0.0.1:3014",
        AUTH_SECRET: randomBytes(32).toString("hex"),
        DATA_SECRET: randomBytes(32).toString("hex"),
        COOKIE_SECURE: "false",
        NODE_ENV: "production",
        TWILIO_ACCOUNT_SID: configValue("TWILIO_ACCOUNT_SID"),
        TWILIO_AUTH_TOKEN: configValue("TWILIO_AUTH_TOKEN"),
        TWILIO_FROM_NUMBER: configValue("TWILIO_FROM_NUMBER"),
        TWILIO_MESSAGING_SERVICE_SID: configValue("TWILIO_MESSAGING_SERVICE_SID"),
        RESEND_API_KEY: "",
      },
      signal,
    );
    const sent = await db.notifications.findUniqueOrThrow({
      where: { id: notification.id },
      select: { status: true, deliveries: { select: { status: true } } },
    });
    requireCondition(
      sent.status === "SENT" && sent.deliveries.some((delivery) => delivery.status === "SENT"),
      "The SMS reminder was not recorded as sent by the notification worker.",
    );
    return "a real reminder SMS was sent to the number ending **" + phone.slice(-2);
  } finally {
    await db.notifications.delete({ where: { id: notification.id } });
    if (createdUser) await db.user.delete({ where: { id: user.id } });
  }
}

function report({ passed, failed, skipped }) {
  console.log("Live smoke summary: " + passed + " passed, " + failed + " failed, " + skipped + " skipped.");
}

async function main() {
  const { enabled, messages, skipped } = planLiveSmoke(process.env);
  for (const message of messages) console.log(message);
  const counts = { passed: 0, failed: 0, skipped };
  if (!enabled.length) {
    report(counts);
    return;
  }
  requireCondition(
    !enabled.some(({ needsInput }) => needsInput) || (process.stdin.isTTY && process.stdout.isTTY),
    "Run live SMS and email checks in an interactive terminal so codes and links can be entered privately.",
  );

  const target = getTarget();
  await checkPort(target);
  const standalone = ".next/standalone";
  await access(standalone + "/server.js").catch(() => {
    throw new SmokeError("Run npm run build before starting credentialed live checks.");
  });
  await cp("public", standalone + "/public", { recursive: true });
  await cp(".next/static", standalone + "/.next/static", { recursive: true });
  const controller = new AbortController();
  const signal = controller.signal;
  const onInterrupt = () => controller.abort();
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  const env = {
    ...process.env,
    DATABASE_URL: target.databaseUrl,
    APP_URL: target.origin,
    HOSTNAME: target.host,
    PORT: String(target.port),
    AUTH_SECRET: randomBytes(32).toString("hex"),
    DATA_SECRET: randomBytes(32).toString("hex"),
    COOKIE_SECURE: "false",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    OTP_DEV_CODE: "",
    DEMO_SEED: "false",
    TRUSTED_CLIENT_IP_HEADER: "",
    GOOGLE_CLIENT_ID: configValue("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: configValue("GOOGLE_CLIENT_SECRET"),
    RAZORPAY_KEY_ID: configValue("RAZORPAY_KEY_ID"),
    RAZORPAY_KEY_SECRET: configValue("RAZORPAY_KEY_SECRET"),
    RAZORPAY_WEBHOOK_SECRET: configValue("RAZORPAY_WEBHOOK_SECRET"),
    TWILIO_ACCOUNT_SID: configValue("TWILIO_ACCOUNT_SID"),
    TWILIO_AUTH_TOKEN: configValue("TWILIO_AUTH_TOKEN"),
    TWILIO_VERIFY_SERVICE_SID: configValue("TWILIO_VERIFY_SERVICE_SID"),
    TWILIO_FROM_NUMBER: configValue("TWILIO_FROM_NUMBER"),
    TWILIO_MESSAGING_SERVICE_SID: configValue("TWILIO_MESSAGING_SERVICE_SID"),
    TWILIO_WHATSAPP_FROM: configValue("TWILIO_WHATSAPP_FROM"),
    WHATSAPP_PROVIDER: configValue("WHATSAPP_PROVIDER"),
    META_WHATSAPP_TOKEN: configValue("META_WHATSAPP_TOKEN"),
    META_WHATSAPP_PHONE_NUMBER_ID: configValue("META_WHATSAPP_PHONE_NUMBER_ID"),
    META_GRAPH_API_VERSION: configValue("META_GRAPH_API_VERSION"),
    RESEND_API_KEY: configValue("RESEND_API_KEY"),
    PASSWORD_RESET_FROM: configValue("PASSWORD_RESET_FROM"),
    NOTIFICATION_EMAIL_FROM: configValue("NOTIFICATION_EMAIL_FROM"),
  };
  let app;
  let db;
  try {
    const migration = startNode(["node_modules/prisma/build/index.js", "migrate", "deploy"], env);
    const interruptMigration = () => migration.child.kill();
    signal.addEventListener("abort", interruptMigration, { once: true });
    const migrated = await migration.stopped;
    signal.removeEventListener("abort", interruptMigration);
    signal.throwIfAborted();
    requireCondition(
      migrated === 0,
      "Could not migrate the isolated database. Check SMOKE_DATABASE_URL and database permissions.",
    );
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient({ datasourceUrl: target.databaseUrl });
    app = startNode([standalone + "/server.js"], env);
    const client = () => httpClient(target.origin, signal);
    const ready = await waitFor(
      async () => {
        requireCondition(
          app.child.exitCode === null && app.child.signalCode === null,
          "The isolated smoke app exited.",
        );
        try {
          return (await client()("/api/auth/me")).status === 200;
        } catch {
          return false;
        }
      },
      45_000,
      signal,
    );
    requireCondition(ready, "The isolated smoke app did not become ready.");
    for (const { name, key } of enabled) {
      signal.throwIfAborted();
      try {
        const evidence = await checks[key]({ origin: target.origin, client, db, signal, onInterrupt });
        console.log("PASS " + name + " (" + evidence + ").");
        counts.passed++;
      } catch (error) {
        signal.throwIfAborted();
        console.error(
          "FAIL " +
            name +
            " (" +
            (error instanceof SmokeError
              ? error.message
              : "The check did not complete. Check the test inbox or provider configuration.") +
            ")",
        );
        counts.failed++;
      }
    }
  } finally {
    if (app) await stopNode(app);
    if (db) await db.$disconnect();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
  report(counts);
  if (counts.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    "FAIL live smoke (" +
      (error instanceof SmokeError
        ? error.message
        : "The runner did not complete. Check its setup and try again.") +
      ")",
  );
  process.exitCode = 1;
});
