import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
const currentPasswordVersion = "scrypt-v2";
const currentScrypt = { cost: 2 ** 15, blockSize: 8, parallelization: 3, maxmem: 64 * 1024 * 1024 };

function derivePassword(password: string, salt: string, legacy = false) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, legacy ? {} : currentScrypt, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export const token = (length = 32) => randomBytes(length).toString("base64url");
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function secret(name: string) {
  const value = process.env[name];
  if (
    !value ||
    value.length < 32 ||
    (process.env.NODE_ENV === "production" && value.startsWith("replace-with-"))
  ) {
    throw new Error(`${name} needs a configured random secret of at least 32 characters.`);
  }
  return value;
}

export async function hashPassword(password: string) {
  const salt = token(16);
  const key = await derivePassword(password, salt);
  return `${currentPasswordVersion}.${salt}.${key.toString("hex")}`;
}

export async function checkPassword(password: string, stored?: string | null) {
  const parts = stored?.split(".") ?? [];
  const legacy = parts.length === 2;
  const validVersion = legacy || (parts.length === 3 && parts[0] === currentPasswordVersion);
  const [salt, encoded] = legacy ? parts : parts.slice(1);
  const valid = validVersion && Boolean(salt) && /^[0-9a-f]{128}$/i.test(encoded ?? "");
  const candidate = await derivePassword(password, valid ? salt : "unregistered-account", valid && legacy);
  return valid && timingSafeEqual(candidate, Buffer.from(encoded, "hex"));
}

function dataKey() {
  return createHash("sha256").update(secret("DATA_SECRET")).digest();
}

export function seal(data: Buffer, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function unseal(value: Uint8Array, context: string) {
  const data = Buffer.from(value);
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}
