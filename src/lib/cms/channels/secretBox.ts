function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function key(secret: string): Promise<CryptoKey> {
  if (secret.trim() === '') throw new Error('CMS_SESSION_SECRET is required to protect channel credentials');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** AES-GCM box. OAuth/provider tokens are never stored in plaintext. */
export async function sealChannelSecret(secret: string, plaintext: string): Promise<string> {
  const aes = await key(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aes,
    new TextEncoder().encode(plaintext),
  );
  return `${toB64(iv)}.${toB64(new Uint8Array(cipher))}`;
}

export async function openChannelSecret(secret: string, sealed: string): Promise<string | null> {
  try {
    const dot = sealed.indexOf('.');
    if (dot <= 0) return null;
    const aes = await key(secret);
    const iv = fromB64(sealed.slice(0, dot));
    const cipher = fromB64(sealed.slice(dot + 1));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
