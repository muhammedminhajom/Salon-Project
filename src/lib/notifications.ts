import { NotificationChannel, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { notificationPreferenceSchema, notificationTemplateSchema } from "@/lib/schemas";
import type { z } from "zod";

type Tx = Prisma.TransactionClient;
type Channel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

function configured(channel: Channel, user: { email: string | null; phone: string | null }) {
  if (channel === "IN_APP") return true;
  if (channel === "EMAIL")
    return Boolean(
      user.email &&
      process.env.RESEND_API_KEY &&
      (process.env.NOTIFICATION_EMAIL_FROM || process.env.PASSWORD_RESET_FROM),
    );
  if (channel === "SMS")
    return Boolean(
      user.phone &&
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID),
    );
  if (process.env.WHATSAPP_PROVIDER === "TWILIO")
    return Boolean(
      user.phone &&
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_FROM,
    );
  return Boolean(
    user.phone &&
    process.env.WHATSAPP_PROVIDER === "META" &&
    process.env.META_WHATSAPP_TOKEN &&
    process.env.META_WHATSAPP_PHONE_NUMBER_ID &&
    process.env.META_GRAPH_API_VERSION,
  );
}

function render(template: string, variables: Record<string, string> = {}) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => variables[key] ?? "");
}

export async function enqueueEvent(
  tx: Tx,
  input: {
    userId: string;
    eventType: string;
    title: string;
    subject?: string;
    body: string;
    idempotencyKey: string;
    bookingId?: string;
    scheduledAt?: Date;
    channels?: Channel[];
    variables?: Record<string, string>;
  },
) {
  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { name: true, email: true, phone: true },
  });
  if (!user) return [];
  const candidates = input.channels ?? ["IN_APP", "EMAIL", "SMS", "WHATSAPP"];
  const channels = candidates.filter((channel) => configured(channel, user));
  if (!channels.length) return [];
  const preferences = await tx.notificationPreference.findMany({
    where: { userId: input.userId, eventType: input.eventType, channel: { in: channels } },
    select: { channel: true, enabled: true },
  });
  const disabled = new Set(
    preferences.filter((preference) => !preference.enabled).map((preference) => preference.channel),
  );
  const templates = await tx.notificationTemplate.findMany({
    where: { eventType: input.eventType, channel: { in: channels }, enabled: true },
  });
  const scheduledAt = input.scheduledAt ?? new Date();
  const created = [];
  for (const channel of channels) {
    if (disabled.has(channel)) continue;
    const template = templates.find((entry) => entry.channel === channel);
    const variables = { name: user.name, ...input.variables };
    const subject = render(template?.subject || input.subject || input.title, variables);
    const body = render(template?.body || input.body, variables);
    created.push(
      await tx.notifications.upsert({
        where: { idempotencyKey: `${input.idempotencyKey}:${channel}` },
        create: {
          userId: input.userId,
          bookingId: input.bookingId,
          eventType: input.eventType,
          channel,
          idempotencyKey: `${input.idempotencyKey}:${channel}`,
          title: render(input.title, variables),
          subject,
          body,
          scheduledAt,
          ...(channel === "IN_APP" && scheduledAt <= new Date()
            ? { status: "SENT", sentAt: new Date() }
            : {}),
        },
        update: {},
      }),
    );
  }
  return created;
}

export async function notifyBooking(
  tx: Tx,
  bookingId: string,
  input: { eventType: string; title: string; body: string; actorId?: string; eventKey?: string },
) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      provider: { select: { ownerId: true, displayName: true } },
      customer: { include: { user: { select: { name: true } } } },
      staff: { select: { userId: true } },
    },
  });
  if (!booking) return;
  const recipients = new Set([
    booking.customerId,
    booking.provider.ownerId,
    ...(booking.staff.userId ? [booking.staff.userId] : []),
  ]);
  for (const userId of recipients) {
    await enqueueEvent(tx, {
      userId,
      bookingId,
      eventType: input.eventType,
      title: input.title,
      body: input.body,
      idempotencyKey: `${input.eventType.toLowerCase()}:${bookingId}:${input.eventKey ?? booking.updatedAt.toISOString()}:${userId}`,
      variables: {
        customerName: booking.customer.user.name,
        providerName: booking.provider.displayName,
        appointmentAt: booking.startsAt.toISOString(),
      },
    });
  }
}

export async function scheduleBookingReminders(tx: Tx, bookingId: string) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: { provider: { select: { ownerId: true } }, staff: { select: { userId: true } } },
  });
  if (!booking) return;
  await tx.notifications.updateMany({
    where: { bookingId, eventType: "BOOKING_REMINDER", status: "QUEUED" },
    data: { status: "CANCELLED" },
  });
  if (booking.status !== "CONFIRMED" || booking.holdExpiresAt) return;
  const recipients = new Set([
    booking.customerId,
    booking.provider.ownerId,
    ...(booking.staff.userId ? [booking.staff.userId] : []),
  ]);
  for (const hours of [24, 2]) {
    const scheduledAt = new Date(booking.startsAt.getTime() - hours * 3_600_000);
    if (scheduledAt <= new Date()) continue;
    for (const userId of recipients) {
      await enqueueEvent(tx, {
        userId,
        bookingId,
        eventType: "BOOKING_REMINDER",
        title: `${hours}-hour appointment reminder`,
        body: `Your Bloom & Blush appointment is scheduled in about ${hours} hours.`,
        idempotencyKey: `booking-reminder:${bookingId}:${booking.startsAt.toISOString()}:${hours}:${userId}`,
        scheduledAt,
      });
    }
  }
}

export async function notificationCenter(userId: string) {
  const [notifications, unreadCount] = await Promise.all([
    db.notifications.findMany({
      where: { userId, channel: "IN_APP", status: "SENT", scheduledAt: { lte: new Date() } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    db.notifications.count({
      where: { userId, channel: "IN_APP", status: "SENT", scheduledAt: { lte: new Date() }, readAt: null },
    }),
  ]);
  return { notifications, unreadCount };
}

export async function markNotificationsRead(userId: string, ids: string[]) {
  const result = await db.notifications.updateMany({
    where: { id: { in: ids }, userId, channel: "IN_APP", readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: result.count };
}

export async function getNotificationPreferences(userId: string) {
  return db.notificationPreference.findMany({
    where: { userId },
    orderBy: [{ eventType: "asc" }, { channel: "asc" }],
  });
}

export async function saveNotificationPreferences(
  userId: string,
  input: z.infer<typeof notificationPreferenceSchema>,
) {
  return db.$transaction(async (tx) =>
    Promise.all(
      input.preferences.map((preference) =>
        tx.notificationPreference.upsert({
          where: {
            userId_eventType_channel: {
              userId,
              eventType: preference.eventType,
              channel: preference.channel,
            },
          },
          create: { userId, ...preference },
          update: { enabled: preference.enabled },
        }),
      ),
    ),
  );
}

export async function listNotificationTemplates() {
  return db.notificationTemplate.findMany({ orderBy: [{ eventType: "asc" }, { channel: "asc" }] });
}

export async function saveNotificationTemplate(
  actorId: string,
  input: z.infer<typeof notificationTemplateSchema>,
) {
  return db.$transaction(async (tx) => {
    const template = await tx.notificationTemplate.upsert({
      where: { eventType_channel: { eventType: input.eventType, channel: input.channel } },
      create: input,
      update: { subject: input.subject, body: input.body, enabled: input.enabled },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        targetId: template.id,
        action: "ADMIN_NOTIFICATION_TEMPLATE_CHANGED",
        metadata: { eventType: input.eventType, channel: input.channel },
      },
    });
    return template;
  });
}

async function sendEmail(
  notification: { idempotencyKey: string; subject: string; body: string },
  email: string,
  fetcher: typeof fetch,
) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_EMAIL_FROM || process.env.PASSWORD_RESET_FROM;
  if (!key || !from) throw new Error("RESEND_NOT_CONFIGURED");
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": notification.idempotencyKey,
    },
    body: JSON.stringify({ from, to: [email], subject: notification.subject, text: notification.body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`RESEND_HTTP_${response.status}`);
}

async function sendTwilioMessage(
  to: string,
  from: string,
  body: string,
  fetcher: typeof fetch,
  serviceSid?: string,
) {
  const account = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  if (!account || !auth) throw new Error("TWILIO_NOT_CONFIGURED");
  const fields: Record<string, string> = { To: to, Body: body };
  if (serviceSid) fields.MessagingServiceSid = serviceSid;
  else fields.From = from;
  const response = await fetcher(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account)}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${account}:${auth}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`TWILIO_HTTP_${response.status}`);
}

async function sendSms(body: string, phone: string, fetcher: typeof fetch) {
  const from = process.env.TWILIO_FROM_NUMBER;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!from && !service) throw new Error("TWILIO_MESSAGING_NOT_CONFIGURED");
  await sendTwilioMessage(phone, from ?? "", body, fetcher, service);
}

async function sendWhatsapp(body: string, phone: string, fetcher: typeof fetch) {
  if (process.env.WHATSAPP_PROVIDER === "TWILIO") {
    const from = process.env.TWILIO_WHATSAPP_FROM;
    if (!from) throw new Error("TWILIO_WHATSAPP_NOT_CONFIGURED");
    return sendTwilioMessage(`whatsapp:${phone}`, from, body, fetcher);
  }
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.META_GRAPH_API_VERSION;
  if (!token || !phoneId || !version) throw new Error("META_WHATSAPP_NOT_CONFIGURED");
  const response = await fetcher(
    `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(phoneId)}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone.replaceAll("+", ""),
        type: "text",
        text: { body },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`META_WHATSAPP_HTTP_${response.status}`);
}

async function sendExternal(
  notification: NonNullable<Awaited<ReturnType<typeof db.notifications.findUnique>>> & {
    user: { email: string | null; phone: string | null };
  },
  fetcher: typeof fetch,
) {
  if (notification.channel === "IN_APP") return;
  if (notification.channel === "EMAIL") {
    if (!notification.user.email) throw new Error("RECIPIENT_EMAIL_MISSING");
    return sendEmail(notification, notification.user.email, fetcher);
  }
  if (!notification.user.phone) throw new Error("RECIPIENT_PHONE_MISSING");
  if (notification.channel === "SMS") return sendSms(notification.body, notification.user.phone, fetcher);
  if (notification.channel === "WHATSAPP")
    return sendWhatsapp(notification.body, notification.user.phone, fetcher);
}

export async function processDueNotifications(now = new Date(), fetcher: typeof fetch = fetch) {
  const ids = await db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Notifications"
      WHERE "status" = 'QUEUED' AND "scheduledAt" <= ${now}
      ORDER BY "scheduledAt" ASC
      LIMIT 25 FOR UPDATE SKIP LOCKED
    `;
    for (const row of due) {
      await tx.notifications.updateMany({
        where: { id: row.id, status: "QUEUED" },
        data: { status: "SENDING", attempts: { increment: 1 } },
      });
    }
    return due.map((row) => row.id);
  });
  let processed = 0;
  for (const id of ids) {
    const notification = await db.notifications.findUnique({
      where: { id },
      include: { user: { select: { email: true, phone: true } } },
    });
    if (!notification) continue;
    try {
      await sendExternal(notification, fetcher);
      await db.$transaction(async (tx) => {
        await tx.notifications.update({
          where: { id },
          data: { status: "SENT", sentAt: now, lastError: null },
        });
        await tx.notificationDelivery.create({
          data: { notificationId: id, attempt: notification.attempts, status: "SENT" },
        });
      });
    } catch (cause) {
      const code =
        cause instanceof Error && /^[A-Z0-9_]{1,40}$/.test(cause.message) ? cause.message : "DELIVERY_FAILED";
      const exhausted = notification.attempts >= 5;
      const backoff = Math.min(3600, 30 * 2 ** Math.max(0, notification.attempts - 1));
      await db.$transaction(async (tx) => {
        await tx.notifications.update({
          where: { id },
          data: {
            status: exhausted ? "FAILED" : "QUEUED",
            scheduledAt: exhausted ? notification.scheduledAt : new Date(now.getTime() + backoff * 1000),
            lastError: code,
          },
        });
        await tx.notificationDelivery.create({
          data: { notificationId: id, attempt: notification.attempts, status: "FAILED", errorCode: code },
        });
      });
    }
    processed += 1;
  }
  return processed;
}

export async function previewNotificationTemplate(input: z.infer<typeof notificationTemplateSchema>) {
  return {
    subject: render(input.subject, {
      name: "Asha",
      providerName: "Rosewood Studio",
      appointmentAt: "2026-12-10 15:00",
    }),
    body: render(input.body, {
      name: "Asha",
      providerName: "Rosewood Studio",
      appointmentAt: "2026-12-10 15:00",
    }),
  };
}

export { NotificationChannel };
