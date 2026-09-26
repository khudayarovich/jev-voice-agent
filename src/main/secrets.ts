import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Secrets kept by the app itself, not the Keychain.
 *
 * The Keychain binds what it holds to the app's code signature, and asks
 * again — blocking the app at launch, behind other windows — whenever that
 * changes. Signed ad hoc, that is every build; signed with a self-made
 * certificate, still every build, as observed. So the API keys are sealed
 * here instead: AES-256-GCM, under a key derived from this Mac's hardware id
 * and the user's name with a random salt, in a file only the user can read.
 * Not the Keychain's protection, but no prompt, ever, and nothing in plain
 * text on disk.
 *
 * Pure: no Electron, so it is tested directly.
 */

const VERSION = "s1";

/** The key for this machine and user, given the salt kept beside the secrets. */
export function deriveKey(machine: string, user: string, salt: Buffer): Buffer {
  return scryptSync(`${machine}\n${user}`, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function newSalt(): string {
  return randomBytes(16).toString("base64");
}

/** "s1.<iv>.<tag>.<ciphertext>", each base64. */
export function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

/** The text back, or null when the key is wrong or the box was tampered with. */
export function open(key: Buffer, sealed: string): string | null {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
