import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.env.LOCAL_DB_PORT ?? 55432);
await mkdir(".data", { recursive: true });
const db = await PGlite.create(".data/postgres", { extensions: { btree_gist } });
await db.exec(
  "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bloom') THEN CREATE ROLE bloom LOGIN SUPERUSER PASSWORD 'bloom'; END IF; END $$",
);
const server = new PGLiteSocketServer({ db, host: "127.0.0.1", port, maxConnections: 1 });
await server.start();
console.log(
  `Local PostgreSQL preview is listening at 127.0.0.1:${port}. Use database postgres, connection_limit=1, and pgbouncer=true.`,
);

async function stop() {
  await server.stop();
  await db.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
