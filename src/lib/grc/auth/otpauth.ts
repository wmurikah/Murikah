/**
 * The otpauth:// provisioning URI an authenticator app enrols from. Import-free
 * so node strips types and unit-tests it directly; the TOTP core itself is the
 * shared CMS implementation, re-exported by ./totp for app code.
 */

const ISSUER = 'Assurance OS';

/** The otpauth provisioning URI for an account, rendered as the enrolment QR. */
export function otpauthUrl(accountEmail: string, secretBase32: string): string {
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(accountEmail)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
}
