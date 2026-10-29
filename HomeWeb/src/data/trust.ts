export interface TrustLogo {
  name: string;
  src: string;
  width: number;
  height: number;
  href?: string;
  verified: true;
  permitted: true;
}

export const TRUST = {
  caption: 'GUIDED BY',
  items: ['IIA Standards', 'ISO/IEC 27001', 'ISO/IEC 42001'],
  logos: [] as TrustLogo[],
} as const;
