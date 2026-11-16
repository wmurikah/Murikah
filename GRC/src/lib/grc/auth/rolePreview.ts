/**
 * Signed, session-length role preview for a platform owner or instance super
 * admin. The cookie is only a request; middleware validates the role and
 * affiliate against the acting organisation on every request. Ordinary users
 * never read or honour it.
 */
import { SignJWT, jwtVerify } from 'jose';

export const GRC_ROLE_PREVIEW_COOKIE = '__Host-grc_role_preview';
export const GRC_ROLE_PREVIEW_COOKIE_LEGACY = 'grc_role_preview';
const MAX_AGE_SECONDS = 12 * 60 * 60;

export interface RequestedRolePreview {
  roleCode: string;
  affiliateCode: string | null;
}

function keyFromSecret(secret: string): Uint8Array {
  const binary = atob(secret);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function readRolePreview(
  request: Request,
  secret: string,
): Promise<RequestedRolePreview | null> {
  const token =
    readCookie(request, GRC_ROLE_PREVIEW_COOKIE) ??
    readCookie(request, GRC_ROLE_PREVIEW_COOKIE_LEGACY);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keyFromSecret(secret), {
      algorithms: ['HS256'],
    });
    if (typeof payload.role !== 'string' || payload.role.trim() === '') return null;
    return {
      roleCode: payload.role,
      affiliateCode: typeof payload.aff === 'string' && payload.aff !== '' ? payload.aff : null,
    };
  } catch {
    return null;
  }
}

export async function createRolePreviewCookie(
  preview: RequestedRolePreview,
  secret: string,
  secure: boolean,
): Promise<string> {
  const token = await new SignJWT({
    role: preview.roleCode,
    aff: preview.affiliateCode ?? '',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(keyFromSecret(secret));
  const secureAttr = secure ? '; Secure' : '';
  const name = secure ? GRC_ROLE_PREVIEW_COOKIE : GRC_ROLE_PREVIEW_COOKIE_LEGACY;
  return `${name}=${token}; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearRolePreviewCookie(secure: boolean): string {
  const secureAttr = secure ? '; Secure' : '';
  const name = secure ? GRC_ROLE_PREVIEW_COOKIE : GRC_ROLE_PREVIEW_COOKIE_LEGACY;
  return `${name}=; HttpOnly${secureAttr}; SameSite=Lax; Path=/; Max-Age=0`;
}

export function clearRolePreviewCookies(secure: boolean): string[] {
  if (!secure) return [clearRolePreviewCookie(false)];
  return [
    clearRolePreviewCookie(true),
    `${GRC_ROLE_PREVIEW_COOKIE_LEGACY}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  ];
}
