/**
 * GRC TOTP. The CMS product already carries the RFC 6238 core (ported from the
 * source 20_mfa.gs); the two products reuse one implementation so the scheme
 * cannot drift, exactly as the password hasher reuses Engineering Rhythm's.
 * The CMS module is imported, not modified. The otpauth URI lives in
 * ./otpauth (import-free) so it stays directly unit-testable.
 */
export { totpAt, verifyTotp, generateSecret, base32Decode } from '@cms/auth/totp';
export { otpauthUrl } from './otpauth';
