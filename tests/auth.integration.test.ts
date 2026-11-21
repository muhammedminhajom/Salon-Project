import assert from "node:assert/strict";
import { randomUUID, scryptSync } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { SignJWT } from "jose";

test("versioned password hashes preserve legacy verification", async () => {
  const { checkPassword, hashPassword } = await import("../src/lib/secrets");
  const password = "Long test password";
  const salt = "legacySalt012345678901";
  const legacy = `${salt}.${scryptSync(password, salt, 64).toString("hex")}`;
  const hash = await hashPassword(password);
  assert.match(hash, /^scrypt-v2\.[A-Za-z0-9_-]{22}\.[0-9a-f]{128}$/);
  assert.notEqual(hash, await hashPassword(password));
  assert.equal(await checkPassword(password, hash), true);
  assert.equal(await checkPassword(password, legacy), true);
  assert.equal(await checkPassword("Different password", hash), false);
  assert.equal(await checkPassword(password, "invalid.hash"), false);
});

test("demo credentials require a local non-production app and the production secret rejects placeholders", async () => {
  const { localDemoAllowed } = await import("../src/lib/local-demo");
  const { secret } = await import("../src/lib/secrets");
  const environment: Record<string, string | undefined> = process.env;
  const { APP_URL, NODE_ENV, AUTH_SECRET } = environment;
  try {
    environment.NODE_ENV = "development";
    environment.APP_URL = "https://marketplace.example.test";
    assert.equal(localDemoAllowed(), false);
    environment.APP_URL = "http://127.0.0.1:3000";
    assert.equal(localDemoAllowed(), true);
    environment.NODE_ENV = "production";
    environment.AUTH_SECRET = "replace-with-an-example-secret-placeholder";
    assert.equal(localDemoAllowed(), false);
    assert.throws(() => secret("AUTH_SECRET"), /configured random secret/);
  } finally {
    for (const [key, value] of Object.entries({ APP_URL, NODE_ENV, AUTH_SECRET })) {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
  }
});

test("password recovery and logout keep account credentials and sessions consistent", async (suite) => {
  const external = process.env.TEST_DATABASE_URL;
  const oldSecret = process.env.AUTH_SECRET;
  const oldDatabaseUrl = process.env.DATABASE_URL;
  let pg: PGlite | undefined;
  let server: PGLiteSocketServer | undefined;
  const users: string[] = [];
  const database = (async () => {
    process.env.AUTH_SECRET = "synthetic-session-signing-secret-for-tests";
    if (external) {
      process.env.DATABASE_URL = external;
    } else {
      pg = await PGlite.create({ extensions: { btree_gist } });
      const root = "prisma/migrations";
      const directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const directory of directories)
        await pg.exec(await readFile(join(root, directory, "migration.sql"), "utf8"));
      server = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0, maxConnections: 1 });
      await server.start();
      process.env.DATABASE_URL = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1`;
    }
    return (await import("../src/lib/db")).db;
  })();
  suite.after(async () => {
    const db = await database.catch(() => undefined);
    try {
      if (external && users.length) await db?.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await db?.$disconnect();
      await server?.stop();
      await pg?.close();
      if (oldSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = oldSecret;
      if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = oldDatabaseUrl;
    }
  });
  const db = await database;
  const { checkPassword, digest, hashPassword, token } = await import("../src/lib/secrets");
  const { jwtKey, revokeSession } = await import("../src/lib/auth");
  const { completePasswordReset, deliverPasswordReset, issuePasswordReset } =
    await import("../src/lib/password-reset");
  const password = "Old synthetic password";
  const user = await db.user.create({
    data: {
      name: "Reset test user",
      email: `${randomUUID()}@example.test`,
      passwordHash: await hashPassword(password),
      role: "CUSTOMER",
    },
  });
  users.push(user.id);
  const delivered: { recipient: string; resetToken: string }[] = [];
  const collect = async (recipient: string, resetToken: string) => {
    delivered.push({ recipient, resetToken });
  };
  const session = {
    id: randomUUID(),
    userId: user.id,
    tokenHash: digest(token()),
    expiresAt: new Date(Date.now() + 60_000),
  };
  await db.session.create({ data: session });

  await suite.test(
    "only password accounts receive a reset email and the database stores a hash",
    async () => {
      await issuePasswordReset(`${randomUUID()}@example.test`, collect);
      assert.equal(delivered.length, 0);
      await issuePasswordReset(user.email!, collect);
      assert.equal(delivered[0].recipient, user.email);
      const raw = delivered[0].resetToken;
      assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(await db.passwordResetToken.findUnique({ where: { tokenHash: raw } }), null);
      assert.equal(
        (await db.passwordResetToken.findUnique({ where: { tokenHash: digest(raw) } }))?.userId,
        user.id,
      );
    },
  );

  await suite.test("expired reset tokens cannot change a password", async () => {
    const expired = token();
    await db.passwordResetToken.create({
      data: { tokenHash: digest(expired), userId: user.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await assert.rejects(completePasswordReset(expired, "Replacement test password"), {
      code: "INVALID_RESET_TOKEN",
    });
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
      user.passwordHash,
    );
  });

  await suite.test("only one concurrent reset succeeds and pre-existing sessions are revoked", async () => {
    await issuePasswordReset(user.email!, collect);
    const nextPassword = "New synthetic password";
    const attempts = await Promise.allSettled(
      delivered.map(({ resetToken }) => completePasswordReset(resetToken, nextPassword)),
    );
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = attempts.find((item) => item.status === "rejected");
    assert.equal(rejected?.reason.code, "INVALID_RESET_TOKEN");
    const current = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(await checkPassword(nextPassword, current.passwordHash), true);
    assert.equal(await checkPassword(password, current.passwordHash), false);
    assert.equal(await db.passwordResetToken.count({ where: { userId: user.id, usedAt: null } }), 0);
    assert.ok((await db.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt);
  });

  await suite.test("logout revokes a session whose refresh cookie was rotated", async () => {
    const id = randomUUID();
    await db.session.create({ data: { ...session, id, tokenHash: digest(token()) } });
    const signed = await new SignJWT({ sid: id })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("bloom-and-blush")
      .setAudience("web-session")
      .setSubject(user.id)
      .setExpirationTime("5m")
      .sign(jwtKey());
    await revokeSession(signed, `${id}.${token()}`);
    assert.ok((await db.session.findUniqueOrThrow({ where: { id } })).revokedAt);
  });

  await suite.test("the email gateway sends the token inside a URL fragment", async (current) => {
    const resetToken = token();
    const sends = current.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(input, "https://api.resend.com/emails");
        assert.equal(init?.method, "POST");
        const body = JSON.parse(init?.body as string);
        assert.deepEqual(body.to, [user.email]);
        assert.ok(
          body.text.includes(`https://marketplace.example.test/account/reset-password#token=${resetToken}`),
        );
        return new Response("{}", { status: 200 });
      },
    );
    await deliverPasswordReset(
      { apiKey: "synthetic-test-key", from: "test@example.test", origin: "https://marketplace.example.test" },
      user.email!,
      resetToken,
    );
    assert.equal(sends.mock.callCount(), 1);
  });
});
