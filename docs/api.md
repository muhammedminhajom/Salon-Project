# Phase 1 REST API

Use JSON for request bodies unless specified. Browse and check availability without an account. Signed-in requests use the `bb-access` cookie. Retain `bb-refresh` to refresh the session. Use the configured application origin for browser writes.

| Method and path                          | Access               | Request and result                                                                                                                   |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| POST `/api/auth/register`                | Public               | `{name,email,password,type?}` → `{user,destination}`. Optional `SHOP` or `ARTIST` creates a draft provider.                          |
| POST `/api/auth/login`                   | Public               | `{email,password}` → `{user,destination}` and cookies.                                                                               |
| GET `/api/auth/me`                       | Public               | `{user}`, or `{user:null}`.                                                                                                          |
| POST `/api/auth/refresh`                 | Refresh cookie       | Rotates the refresh cookie and returns `{user}`.                                                                                     |
| POST `/api/auth/logout`                  | Any                  | Revokes the matching session and clears cookies.                                                                                     |
| POST `/api/auth/password-reset-request`  | Public               | `{email}` returns a generic HTTP 202 when email delivery is configured.                                                              |
| POST `/api/auth/password-reset-complete` | Public               | `{token,password}` updates the password, consumes the token, and revokes existing sessions.                                          |
| POST `/api/auth/otp-send`                | Public               | `{phone,name?,type?}` → `{challenge,expiresIn}`.                                                                                     |
| POST `/api/auth/otp-check`               | Public               | `{challenge,code}` → `{user,destination}` and cookies.                                                                               |
| GET `/api/auth/google`                   | Public               | Optional `next` and `type` query parameters. Redirects to Google.                                                                    |
| GET `/api/auth/google-callback`          | Google flow          | Validates the state, authorization code, nonce, and ID token and establishes a session.                                              |
| GET `/api/catalog`                       | Public               | Filters `q`, `city`, `category`, `type`, `mode`, `maxPrice` in INR, `rating`, `offers=1`, `sort`. Returns `{listings}`.              |
| GET `/api/catalog/{slug}`                | Public               | Returns `{profile}` for an approved provider.                                                                                        |
| GET `/api/provider`                      | Provider             | Returns `{studio}` for the owner’s account.                                                                                          |
| POST `/api/provider`                     | Provider             | Accepts a studio command and returns `{result}`. See supported commands below.                                                       |
| POST `/api/provider/documents`           | Provider             | Raw PDF, PNG, or JPEG, up to 3 MB. Supply `Content-Type` and `X-File-Name`. Returns `{document}`.                                    |
| GET `/api/provider/documents/{id}`       | Owner or admin       | Returns an authorized private attachment and records access.                                                                         |
| GET `/api/admin/providers`               | Admin                | Returns counts, completed booking value, and provider applications.                                                                  |
| PATCH `/api/admin/providers`             | Admin                | `{providerId,status,note?}` → `{provider}`. A note is required for rejection and suspension.                                         |
| GET `/api/admin/users?cursor={id}`       | Admin                | Lists up to 25 user summaries and supplies a cursor for the next page.                                                               |
| POST `/api/availability`                 | Public               | Selection and branch-local date → slots with the current quote.                                                                      |
| GET `/api/bookings`                      | Signed in            | Lists bookings visible to the current role.                                                                                          |
| POST `/api/bookings`                     | Customer             | Selection, start instant, request key, and optional `expectedTotalPaise` → `{booking}`.                                              |
| POST `/api/bookings/walk-in`             | Approved salon owner | `{providerId,branchId,serviceIds,staffId?,customerName,requestKey}` records an in-progress salon visit at the server's current time. |
| GET `/api/bookings/{id}?date=YYYY-MM-DD` | Participant or admin | Returns available replacement starts for the assigned staff member.                                                                  |
| PUT `/api/bookings/{id}`                 | Participant or admin | `{startsAt,staffId?}` → rescheduled `{booking}`. Staff can keep their own assignment.                                                |
| PATCH `/api/bookings/{id}`               | Participant or admin | `{status}` → `{booking}`. Customers can request `CANCELLED`.                                                                         |

## Request and response examples

Register a provider or omit `type` for a customer.

```json
{
  "name": "Liya Joseph",
  "email": "liya@example.com",
  "password": "your-unique-long-password",
  "type": "ARTIST"
}
```

```json
{
  "user": {
    "id": "user-id",
    "name": "Liya Joseph",
    "email": "liya@example.com",
    "phone": null,
    "role": "PROVIDER"
  },
  "destination": "/studio"
}
```

Studio commands use the `action` field. The `profile` command saves the public profile, pricing radius, cancellation notice, and optional payout UPI ID. `branch`, `staff`, and `service` create a record or update one when its ID is included. `schedule` replaces a staff member’s weekly windows and `time-off` blocks a specific interval. Use `remove-time-off`, `archive-staff`, `archive-branch`, and `park-service` for changes to existing records. `submit` places a completed draft or previously rejected application in the review queue.

Use `add-holiday` with `{branchId,date,reason}` to close a branch for a local calendar date and `remove-holiday` with `{branchId,date}` to reopen it. Use `delete-service` with `{serviceId}` to remove an unused service or archive a service with booking history.

```json
{
  "action": "schedule",
  "staffId": "rosewood-studio-staff-1",
  "windows": [
    { "dayOfWeek": 1, "startMinute": 600, "endMinute": 1140, "kind": "WORK" },
    { "dayOfWeek": 1, "startMinute": 780, "endMinute": 840, "kind": "BREAK" }
  ]
}
```

```json
{
  "action": "service",
  "categoryId": "hair",
  "name": "Precision haircut",
  "description": "Consultation and finish",
  "kind": "SERVICE",
  "duration": 45,
  "buffer": 15,
  "pricePaise": 79900,
  "listPaise": 109900,
  "homeEligible": false,
  "staffIds": ["rosewood-studio-staff-1"]
}
```

Look up available times. Replace the sample date with a date in the next 60 days. Omit `staffId` to check all eligible staff.

```json
{
  "providerId": "rosewood-studio",
  "branchId": "rosewood-studio-main",
  "serviceIds": ["signature-haircut"],
  "mode": "VENUE",
  "date": "2026-11-22"
}
```

```json
{
  "timeZone": "Asia/Kolkata",
  "duration": 45,
  "travelPaise": 0,
  "totalPaise": 79900,
  "slots": [{ "startsAt": "2026-11-22T04:30:00.000Z", "staffCount": 2 }]
}
```

Reserve a returned start time. Reuse the same request key and payload if a network retry is needed. For `HOME` mode, include `location` with `address`, `latitude`, and `longitude`.

```json
{
  "providerId": "rosewood-studio",
  "branchId": "rosewood-studio-main",
  "serviceIds": ["signature-haircut"],
  "mode": "VENUE",
  "startsAt": "2026-11-22T04:30:00.000Z",
  "requestKey": "c94dc114-a2c6-4c44-b846-bd573cd3cb33",
  "expectedTotalPaise": 79900
}
```

The response includes the appointment, assigned professional, and item price snapshots.

```json
{
  "booking": {
    "id": "booking-id",
    "status": "CONFIRMED",
    "startsAt": "2026-11-22T04:30:00.000Z",
    "endsAt": "2026-11-22T05:15:00.000Z",
    "timeZone": "Asia/Kolkata",
    "totalPaise": 79900,
    "staff": { "name": "Mia Mathew" },
    "items": [
      { "name": "Signature haircut", "duration": 45, "buffer": 15, "pricePaise": 79900, "position": 0 }
    ]
  }
}
```

A stale appointment returns the following error.

```json
{ "error": "That time is no longer available. Choose another time.", "code": "SLOT_UNAVAILABLE" }
```

A newly created booking returns HTTP 201. An idempotent replay returns HTTP 200 with the same booking. Request failures return a JSON error and machine-readable code, with HTTP 409 for stale availability or a conflicting idempotency key. The complete validated input definitions are in `src/lib/schemas.ts` and `src/lib/provider.ts`.
