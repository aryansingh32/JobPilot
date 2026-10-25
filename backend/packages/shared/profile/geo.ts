import net from 'node:net';

// Where a person is, from the address they connect from: country → nationality as a first guess the person can edit.
// One small lookup per person (cached), public addresses only.

const DEMONYM: Record<string, string> = {
  IN: 'Indian', US: 'American', GB: 'British', CA: 'Canadian', AU: 'Australian', DE: 'German', FR: 'French', SG: 'Singaporean',
  AE: 'Emirati', NL: 'Dutch', IE: 'Irish', NZ: 'New Zealander', ES: 'Spanish', IT: 'Italian', SE: 'Swedish', CH: 'Swiss',
  JP: 'Japanese', BR: 'Brazilian', PK: 'Pakistani', BD: 'Bangladeshi', LK: 'Sri Lankan', NP: 'Nepali', PH: 'Filipino',
  ID: 'Indonesian', MY: 'Malaysian', ZA: 'South African', NG: 'Nigerian', KE: 'Kenyan', EG: 'Egyptian', SA: 'Saudi',
};

export const nationalityOf = (code: string) => DEMONYM[code.toUpperCase()] ?? '';

const cache = new Map<string, { country: string; nationality: string } | null>();

const isPublic = (ip: string) =>
  net.isIP(ip) > 0 && !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80)/i.test(ip);

export async function geoFromIp(ip: string): Promise<{ country: string; nationality: string } | null> {
  const clean = ip.replace(/^::ffff:/, '');
  if (!isPublic(clean)) return null;
  if (cache.has(clean)) return cache.get(clean) ?? null;
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(clean)}/country/`, { signal: AbortSignal.timeout(3000) });
    const code = (await res.text()).trim().toUpperCase();
    const out = res.ok && /^[A-Z]{2}$/.test(code) ? { country: code, nationality: DEMONYM[code] ?? '' } : null;
    cache.set(clean, out);
    return out;
  } catch {
    return null;
  }
}
