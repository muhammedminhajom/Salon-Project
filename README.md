# Bloom & Blush

Bloom & Blush is a salon and freelance beauty artist marketplace for Kochi. It includes the Phase 1 marketplace and booking foundation plus Phase 2 payments, refunds, finance, invoices, coupons, rewards, reviews, and notifications.

## Run locally

Use Node.js 24 LTS and npm. Copy `.env.example` to `.env` and set `AUTH_SECRET` and `DATA_SECRET` to different random values. Run this command twice to generate the values.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Install the locked dependencies.

```sh
npm ci
```

### Option 1 · Native PostgreSQL

Start PostgreSQL 17 or later and connect as the local PostgreSQL administrator with `psql -U postgres`. Create the app role and database. The `\password` command prompts for the local password.

```sql
CREATE ROLE bloom LOGIN;
\password bloom
CREATE DATABASE bloom OWNER bloom;
\connect bloom
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

Set `DATABASE_URL` in `.env` to `postgresql://bloom:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:5432/bloom?connection_limit=5`. Use the actual local port if it differs. [PostgreSQL installation](https://www.postgresql.org/download/)

### Option 2 · PostgreSQL in Docker

```sh
docker compose up -d --wait db
```

Set `DATABASE_URL` in `.env` to `postgresql://bloom:bloom@127.0.0.1:55432/postgres?connection_limit=5` for the account and port in `compose.yaml`.

### Option 3 · Embedded PGlite preview

Use the `DATABASE_URL` in `.env.example`. Start the preview in a separate terminal before migrating or starting the app.

```sh
npm run db:local
```

Wait for the listening message and keep that terminal open while using the app. The preview stores data under `.data/postgres`. The Docker database and the preview both default to port `55432`, so run one of them on that port. [PGlite socket documentation](https://pglite.dev/docs/pglite-socket)

### Start the app

```sh
npm run db:deploy
npm run db:seed
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). If Prisma reports that it cannot reach the database, start the database selected above and refresh the page.

If npm extraction fails in a synced Windows folder, use an unsynced checkout with a short path, such as `C:\src\bloom`.

### Demo accounts

Set `DEMO_SEED=true` with a loopback database and loopback `APP_URL` before running `npm run db:seed`. Demo listings, names, ratings, and provider photos are illustrative. Each demo account uses `DemoBeauty2026!` in local development.

| Portal           | Account                    |
| ---------------- | -------------------------- |
| Customer         | `customer@bloomblush.test` |
| Salon owner      | `studio@bloomblush.test`   |
| Freelance artist | `artist@bloomblush.test`   |
| Salon staff      | `staff@bloomblush.test`    |
| Admin            | `admin@bloomblush.test`    |

To try an artist home visit with the seed data, enter a sample Fort Kochi address using latitude `9.9650` and longitude `76.2430`. The booking requests manual confirmation in the artist portal. Rosewood Studio confirms automatically.

## Environment variables

| Variable                                                                         | Purpose                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                   | PostgreSQL connection URL. Use `connection_limit=1&pgbouncer=true` for the embedded preview so Prisma resets prepared statements when switching clients.                            |
| `APP_URL`                                                                        | Canonical origin used for request-origin checks and Google OAuth callbacks. Use HTTPS in production.                                                                                |
| `AUTH_SECRET`, `DATA_SECRET`                                                     | Separate random values of at least 32 characters for session signing and KYC/payout encryption. Replace both example values before deployment. Back up the encryption key securely. |
| `COOKIE_SECURE`                                                                  | Set `true` for HTTPS. Set `false` for local HTTP builds.                                                                                                                            |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                       | Enable Google sign-in. Register `APP_URL/api/auth/google-callback` as the exact OAuth redirect URI.                                                                                 |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`           | Enable SMS OTP using Twilio Verify.                                                                                                                                                 |
| `OTP_DEV_CODE`                                                                   | Optional 4–8 digit verification code for loopback development.                                                                                                                      |
| `RESEND_API_KEY`, `PASSWORD_RESET_FROM`                                          | Enable email password reset through Resend. Use a verified sending address.                                                                                                         |
| `NOTIFICATION_EMAIL_FROM`                                                        | Optional verified sender for booking, invoice, and notification email. Falls back to `PASSWORD_RESET_FROM`.                                                                         |
| `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM_NUMBER`                             | Optional Twilio SMS sender for notifications. Configure one of these, alongside the Twilio account credentials.                                                                     |
| `TWILIO_WHATSAPP_FROM`, `WHATSAPP_PROVIDER`                                      | Optional Twilio WhatsApp sender. Set `WHATSAPP_PROVIDER=TWILIO`.                                                                                                                    |
| `META_WHATSAPP_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_GRAPH_API_VERSION` | Optional Meta WhatsApp Cloud API sender. Set `WHATSAPP_PROVIDER=META`.                                                                                                              |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`              | Razorpay checkout, payment verification, and webhook handling. Use test-mode keys for local checkout.                                                                               |
| `TRUSTED_CLIENT_IP_HEADER`                                                       | Optional header your edge proxy strips and rewrites to the trusted client IP. Enables IP-level rate limits alongside account-level limits.                                          |
| `DEMO_SEED`                                                                      | Creates sample accounts and listings on a loopback database with a loopback app URL in development. Set `false` on live environments.                                               |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`                                                  | Optional initial admin. Provide both before seeding a live database and remove the password from the deployment environment afterward.                                              |
| `TEST_DATABASE_URL`                                                              | Optional migrated, disposable PostgreSQL database for integration tests. Without it, tests use an in-memory PostgreSQL engine.                                                      |
| `LOCAL_DB_PORT`                                                                  | Optional override for the embedded database listener, default `55432`.                                                                                                              |

Google and Twilio sign-in controls appear when configured. Email and password sign-in uses the database and app secrets. Password recovery sends a short-lived, single-use link to the account email when Resend is configured. [Google OpenID Connect](https://developers.google.com/identity/openid-connect/reference) · [Twilio Verify](https://www.twilio.com/docs/verify/api) · [Resend Send Email API](https://resend.com/docs/api-reference/emails/send-email)

## Project layout

```text
src/app/                Next.js pages and REST route handlers
src/app/api/            Auth, catalog, studio, availability, bookings, admin
src/components/         Marketplace, appointment, studio, and admin interfaces
src/components/ui/      Shared shadcn-style UI primitives
src/lib/                Auth, access control, booking, scheduling, and catalog
prisma/                 Schema, versioned migrations, and demo seeding
public/images/          Optimized marketplace imagery
tests/                  Slot, booking, and authentication regression tests
docs/                   Architecture, ER diagram, API examples, and image prompts
```

## Verification

```sh
npm run check
npm run build
```

`npm run check` runs ESLint, Prettier's formatting check, TypeScript, and the tests in that order. Use `npm run lint:fix` and `npm run format` for local fixes. In a Git checkout, `npm ci` installs the Husky hook. The pre-commit hook runs ESLint and Prettier on staged files through lint-staged.

### PGlite and native test modes

With `TEST_DATABASE_URL` unset, `npm test` creates disposable in-memory PGlite databases and applies the SQL migrations. This mode needs no running database and is suitable for the slot, booking, and auth regression suite.

To exercise the exclusion constraint across two independent database connections, use a disposable native PostgreSQL database with at least two available connections. Run `npm run db:deploy` against it first, then export its URL as `TEST_DATABASE_URL` in your shell and run `npm run check`. The native database can run directly on the machine or in Docker. GitHub Actions provisions PostgreSQL 17, installs the lockfile, migrates, seeds, and runs `check` and `build`.

## Live integration testing

The opt-in runner launches an isolated local app from your production build. It uses a disposable native PostgreSQL database, applies the migrations, and skips each service with missing settings. GitHub Actions runs the regular checks. The live runner immediately skips when `CI` is set.

1. Create a disposable database on your local PostgreSQL server. For example, run `psql -U postgres -c "CREATE DATABASE bloom_smoke OWNER bloom;"` after creating the role in the native setup above. Set `SMOKE_DATABASE_URL` in `.env` to that database URL. The runner requires a database distinct from `DATABASE_URL`.
2. Copy the relevant settings below into your local `.env`. Keep credentials and one-time codes in your local environment and terminal.

   | Service       | Settings                                                                                                                                                                                                                                                                                                                                                                                                                                                |
   | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Google OAuth  | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` from a Google Cloud **Web application** OAuth client. Set `SMOKE_GOOGLE_EMAIL` to the Google account you control. Add it to the consent screen's test users if required. Register `http://127.0.0.1:3014/api/auth/google-callback` as an **authorized redirect URI**.                                                                                                                                        |
   | Twilio Verify | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` from the Twilio Console, `TWILIO_VERIFY_SERVICE_SID` from **Verify > Services**, and `SMOKE_TWILIO_PHONE` for an SMS-capable number you control in E.164 format. Use a number verified for the account if required by your Twilio trial.                                                                                                                                                                      |
   | Resend        | `RESEND_API_KEY` from **API Keys**, `PASSWORD_RESET_FROM` on a verified sending domain, and `SMOKE_RESEND_EMAIL` for an inbox you control. Use an address unused in the smoke database and distinct from the Google test address.                                                                                                                                                                                                                       |
   | Razorpay      | `RAZORPAY_KEY_ID` must start with `rzp_test_`; add the matching `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`. Set a fresh `SMOKE_RAZORPAY_EMAIL` and `SMOKE_RAZORPAY_PASSWORD` (14 or more characters). The runner creates a booking/order and waits for you to sign in and finish payment with a Razorpay test card. It then checks server-side payment signature verification, signed webhook replay, cancellation refund, and refund webhook. |
   | SMS reminder  | Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`. `SMOKE_REMINDER_PHONE` must be an SMS-capable E.164 number you control. The runner sends one test reminder and verifies its delivery log.                                                                                                                                                                                             |

   The default origin is `http://127.0.0.1:3014`. If you use `SMOKE_APP_URL` to choose another port, register its exact Google callback URI. [Google redirect URIs](https://developers.google.com/identity/protocols/oauth2/web-server) · [Twilio Verify](https://www.twilio.com/docs/verify/api) · [Resend sender domains](https://resend.com/docs/dashboard/domains/introduction)

3. Build the app and run the smoke command in an interactive terminal.

   ```sh
   npm run build
   npm run smoke:live
   ```

4. Follow the prompts for each configured service.
   - **Google** · Open the printed local sign-in URL in your regular browser. Choose the test account and complete sign-in. The runner verifies the callback configuration, the Google-linked Customer record, and a newly issued session.
   - **Twilio** · Enter the received codes at the hidden prompts. The test sends three SMS messages, verifies sign-in and resend throttling, waits five minutes to verify expiry, and checks the per-challenge verification limit.
   - **Resend** · Copy the entire link from the delivered reset email and paste it at the hidden prompt. The runner redeems it once, verifies that a replay fails, checks the old password and session, and signs in with the replacement password.
   - **Razorpay** · The runner creates a disposable Customer, approved salon booking, and test-mode order. Sign in at the local app with the `SMOKE_RAZORPAY_EMAIL` and password in `.env`, open **My bookings**, and pay the pending order with a test-mode card. Keep that browser tab open. The runner waits up to five minutes for server-side signature verification, sends a locally signed `payment.captured` event twice to verify replay handling, cancels the fixture, requests a test-mode refund, and checks a signed/replayed `refund.processed` event. It removes the fixture afterward.
   - **SMS reminder** · The job worker sends a real reminder to the configured test number. It sends no appointment booking and prints only the number's final two digits.

The runner publishes per-service `PASS`, `FAIL`, or `SKIP` and exits nonzero if a configured check fails. A skip leaves that service's live verification pending. The Google and SMS test accounts can be reused in the disposable database. The runner removes the temporary password-reset fixture it creates.

### Studio operations

Use **Locations & availability** to add branch holidays or staff time-off. The appointment calendar shows a selected branch and date. Salon owners can record an in-progress walk-in for a named guest. The slot engine applies the same availability, duration, buffer, and overlap rules as online bookings.

Deleting an unused service removes it. Deleting a service referenced by a booking archives it and retains its history. Approved listings and appointment availability exclude archived services.

## Deploy

1. Provision PostgreSQL with the `btree_gist` extension available to the migration role. Configure HTTPS and the environment variables above.
2. Run `npm ci` and `npm run db:deploy` against the target database. Run `npm run db:seed` with `DEMO_SEED=false` to load categories and create the optional first administrator.
3. On Vercel, import the project as a Next.js application and set the runtime environment. PostgreSQL can run on Railway or a managed service. Use the migration step in CI before deploying application code.
4. For a standalone container, run `docker build -t bloom-blush .` and start it with `docker run --env-file .env.production -p 3000:3000 bloom-blush`. The database URL must be reachable from the running container. You can build the `migrate` target to run migrations from a release job.

For deployment details, see [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) and [Prisma production migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production).

## Phase 2 modules and API examples

All monetary API values are integer paise and use `INR`. Protected endpoints use the signed session cookie and enforce the role shown below. Payment, cancellation, coupon reservation, payout, and review mutations use request keys or unique database constraints for replay safety.

| Module                               | Main endpoints                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checkout, wallet, and Razorpay       | `POST /api/payments` (`quote`, `order`, `verify`); `GET /api/payments`; `POST /api/webhooks/razorpay`                                                                                                        |
| Cancellation, refund, and reschedule | `GET /api/bookings/{id}/cancel` (refund preview); `POST /api/bookings/{id}/cancel`; `PUT /api/bookings/{id}`; `POST /api/admin/refunds`                                                                      |
| Provider payment settings            | `GET` and `PUT /api/provider/payment-settings` configure deposit and GST details.                                                                                                                            |
| Provider finance and payouts         | `GET` and `POST /api/provider/finance`; `PUT /api/provider/finance/payout-details`; `GET` and `PUT /api/admin/finance`; `GET` and `PATCH /api/admin/finance/payouts`; `PATCH /api/admin/finance/commissions` |
| Invoices                             | `GET /api/invoices/{id}` returns a PDF to the owning customer, provider, or admin                                                                                                                            |
| Coupons and discounts                | `POST /api/coupons/validate`; `GET`, `POST`, and `PATCH /api/provider/coupons`; `GET`, `POST`, and `PATCH /api/admin/coupons`                                                                                |
| Reviews                              | `POST /api/reviews`; `GET /api/providers/{slug}/reviews?page=1`; `GET /api/provider/reviews`; `PATCH /api/provider/reviews/{id}`; `POST /api/reviews/{id}/reports`; `GET` and `PATCH /api/admin/reviews`     |
| Notifications                        | `GET` and `PATCH /api/notifications`; `GET` and `PUT /api/notifications/preferences`; `GET /api/admin/notifications/deliveries`; `GET`, `PUT`, and `POST /api/admin/notifications/templates`                 |

Example online checkout request and response:

```http
POST /api/payments
Content-Type: application/json

{"action":"order","bookingId":"booking-id"}
```

```json
{ "orderId": "order_test_id", "amount": 120000, "currency": "INR", "keyId": "rzp_test_public_id" }
```

The customer checkout sends the Razorpay order, payment, and signature back to `POST /api/payments` with `action: "verify"`. The app validates the signature on the server. Razorpay webhooks use the raw request body and `X-Razorpay-Signature`; replayed event IDs with an identical body return a duplicate acknowledgement.

Example coupon validation request and response:

```json
{
  "providerId": "provider-id",
  "branchId": "branch-id",
  "staffId": "staff-id",
  "mode": "VENUE",
  "serviceIds": ["service-id"],
  "startsAt": "2026-12-10T05:30:00.000Z",
  "couponCode": "WELCOME10",
  "loyaltyPoints": 0
}
```

```json
{
  "quote": {
    "currency": "INR",
    "subtotalPaise": 120000,
    "discountPaise": 12000,
    "taxPaise": 0,
    "totalPaise": 108000,
    "gatewayAmountPaise": 108000,
    "dueAtVenuePaise": 0
  }
}
```

Example provider payout request:

```http
POST /api/provider/finance
Content-Type: application/json

{ "requestKey": "8b2b01ab-3501-48ca-8897-bbb87c93c194", "amountPaise": 50000 }
```

```json
{
  "payout": {
    "id": "payout-id",
    "amountPaise": 50000,
    "status": "PENDING",
    "eligibleAt": "2026-12-17T02:00:00.000Z"
  }
}
```

Example admin batch approval:

```http
PATCH /api/admin/finance/payouts
Content-Type: application/json

{ "payoutIds": ["payout-id"], "action": "APPROVE" }
```

```json
{ "payouts": [{ "id": "payout-id", "status": "APPROVED" }] }
```

The payout cycle defaults to seven days. A request becomes eligible for admin approval after the configured cycle delay; the admin can approve eligible requests in batches and records the external bank/UPI transfer reference when marking a batch paid. A failed payout can be retried. Refunds that exceed remaining provider payable create a negative balance which reduces later availability.

`npm run jobs:work` runs the PostgreSQL-backed queue for expired payment holds, due refunds, scheduled notifications, retries, and reminders. It claims work with row locks and `SKIP LOCKED`; Redis/BullMQ is not required. Run one worker per deployment process group and monitor the admin delivery log.

The demo seed now includes platform and provider coupon examples, cancellation/deposit settings, a completed appointment with a published review, its invoices and ledger settlement, and sample loyalty data. The seed is repeatable and preserves existing demo records. `npm run db:deploy` applies a fresh schema or upgrades a database that has already recorded earlier migrations; integration tests apply the ordered migration chain from an empty database, while CI migrates and seeds PostgreSQL 17 before checks.

### Phase 2 verification

```sh
npm run check
npm run build
npm run smoke:live
```

The live runner is opt-in, skipped by CI, and requires dedicated test-mode Razorpay credentials plus the existing Google, Twilio, and Resend values for the services selected. The Razorpay check creates a disposable booking and order, then waits for a test payment through the browser before verifying the captured payment, a signed replay-protected webhook, and a test refund. The SMS reminder check sends a reminder to the configured test number through the notification worker. See [Live integration testing](#live-integration-testing) for the exact settings.

[System architecture and ER diagram](docs/architecture.md) · [REST API examples](docs/api.md)
