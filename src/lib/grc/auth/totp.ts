/**
 * GRC TOTP. The RFC 6238 core is shared code (src/lib/shared/totp.ts, ported
 * from the source 20_mfa.gs); every product that needs TOTP reuses the one
 * implementation so the scheme cannot drift, exactly as the password hasher
 * reuses Engineering Rhythm's. The shared module is imported, not modified. The
 * otpauth URI lives in ./otpauth (import-free) so it stays directly
 * unit-testable.
 */
export { totpAt, verifyTotp, generateSecret, base32Decode } from '@shared/totp';
export { otpauthUrl } from './otpauth';
