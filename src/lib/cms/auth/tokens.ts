import { hashSessionToken } from './session.ts';

const TOKEN_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newOneTimeToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export function hashOneTimeToken(token: string, secret: string): Promise<string> {
  return hashSessionToken(token, secret);
}
