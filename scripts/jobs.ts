import { setTimeout as delay } from "node:timers/promises";
import { db } from "../src/lib/db";
import { expirePaymentHolds } from "../src/lib/payment-records";
import { processDueRefunds } from "../src/lib/refunds";
import { processDueNotifications } from "../src/lib/notifications";

const loop = process.argv.includes("--watch");
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function main() {
  do {
    try {
      const released = await expirePaymentHolds();
      if (released) console.log("Released payment holds: " + released);
      const refunds = await processDueRefunds();
      if (refunds) console.log("Processed refunds: " + refunds);
      const notifications = await processDueNotifications();
      if (notifications) console.log("Processed notification deliveries: " + notifications);
    } catch {
      console.error("Payment job failed.");
      if (!loop) {
        process.exitCode = 1;
        break;
      }
    }
    if (loop) await delay(30_000, undefined, { signal: controller.signal }).catch(() => undefined);
  } while (loop && !controller.signal.aborted);
}

main().finally(async () => {
  await db.$disconnect();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
});
