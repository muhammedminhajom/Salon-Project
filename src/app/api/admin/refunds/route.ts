import { limit, requireUser } from "@/lib/auth";
import { json, respond, route } from "@/lib/http";
import { overrideRefund } from "@/lib/refunds";
import { adminRefundSchema } from "@/lib/schemas";

export const POST = route(async (request) => {
  const admin = await requireUser("ADMIN");
  await limit("admin-refund", admin.id, 30, 300);
  const input = await json(request, adminRefundSchema);
  const refund = await overrideRefund(admin.id, input);
  return respond({
    refund: {
      id: refund.id,
      status: refund.status,
      amountPaise: refund.amountPaise,
      currency: refund.currency,
    },
  });
});
