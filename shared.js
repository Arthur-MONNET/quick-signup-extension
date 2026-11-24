// Pure helpers shared by the service worker and the options page (ES module, no DOM, no chrome.* calls).

// Hosts the extension may act on. Preprod first. The list is editable in the options page; hosts outside the
// manifest "host_permissions" need an extra permission that the options page requests when saving.
export const DEFAULT_HOSTS = [
    'www-preprod.candyshop.com',
    'preprod-meet.candyshop.com',
    'secure-preprod.evo2pay.com',
    'www.candyshop.com',
    'meet.candyshop.com',
    'secure.evo2pay.com',
    // The candyshop flow can hand over to another brand of the network (seen: preprod-480052.rencontre-ronde.fr).
    '*.rencontre-ronde.fr',
    // Spiice (member.md): not verified with this extension yet.
    'www-preprod.spiice.com',
    'www.spiice.com',
    '*.members.spiice.com',
];

export const DEFAULT_SETTINGS = {
    emailDomain: '', // set in the options page, never in the code
    password: '', // set in the options page, never in the code, never logged
    allowedHosts: DEFAULT_HOSTS,
};

// Age and city are drawn at random for every account (never a setting).
export const CITIES = ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Nantes', 'Bordeaux', 'Lille', 'Strasbourg', 'Rennes', 'Montpellier', 'Grenoble', 'Dijon', 'Angers', 'Toulon'];
const randomInt = (min, max) => {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return min + (buffer[0] % (max - min + 1));
};
export const randomProfile = () => ({ age: randomInt(24, 46), city: CITIES[randomInt(0, CITIES.length - 1)] });
// The city autocomplete lists "City, Department, France": take the entry that starts with the typed city.
export const citySuggestionPattern = (city) => `^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},.*France`;

// Profile photo: an AI-generated face from this-person-does-not-exist.com (fetched by the service worker only).
export const PHOTO_ORIGIN = 'https://this-person-does-not-exist.com';
// The site offers 12-18, 19-25, 26-35, 35-50 and 50: members are adults, so the lowest bucket is never used.
export const photoAgeRange = (age) => (age <= 25 ? '19-25' : age <= 35 ? '26-35' : age <= 50 ? '35-50' : '50');
export const photoQuery = (gender, age) => `time=${Date.now()}&gender=${gender === 'woman' ? 'female' : 'male'}&age=${photoAgeRange(age)}&etnic=all`;

// Test accounts are recognisable by their e-mail: test-<DDMM>-<HHmm>-<3 random chars>@domain (unique per attempt, no counter to keep).
export const EMAIL_PREFIX = 'test';

// Built-in hosts are always allowed (so new defaults reach existing installs); the saved list only adds to them.
export const effectiveHosts = (stored) => [...new Set([...DEFAULT_HOSTS, ...((stored && stored.allowedHosts) || [])])];

export const normalizeHost = (value) => String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');

export const isHostAllowed = (hostname, patterns) => {
    const host = normalizeHost(hostname);
    if (!host) return false;
    return (patterns || []).some((raw) => {
        const p = normalizeHost(raw);
        if (!p) return false;
        if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
        return host === p;
    });
};

// Chrome match pattern for a host entry ("*.x.com" -> "https://*.x.com/*").
export const originPattern = (raw) => `https://${normalizeHost(raw)}/*`;

// "www-preprod.candyshop.com" -> "candyshop.com": the key under which a journey is remembered (prod and preprod share it).
export const siteKeyOf = (hostname) => normalizeHost(hostname).split('.').slice(-2).join('.');

const pad = (n) => String(n).padStart(2, '0');
export const ddmm = (date = new Date()) => `${pad(date.getDate())}${pad(date.getMonth() + 1)}`;
export const hhmm = (date = new Date()) => `${pad(date.getHours())}${pad(date.getMinutes())}`;

const randomChars = (length) => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (i, l, o, 0, 1)
    const buffer = new Uint32Array(length);
    crypto.getRandomValues(buffer);
    return [...buffer].map((n) => alphabet[n % alphabet.length]).join('');
};

export const buildEmail = (domain, date = new Date()) => `${EMAIL_PREFIX}-${ddmm(date)}-${hhmm(date)}-${randomChars(3)}@${normalizeHost(domain)}`;

// ---- Saved accounts -----------------------------------------------------------------------------------------------------
// Test accounts created with the extension (or signed in when it is started) are remembered in chrome.storage.local, with the
// member's refresh token so that a "login gateway" link can sign the account in again. The token never leaves the service
// worker except inside such a link, is never logged, and is stripped from everything shown in the bar (see publicAccount).
export const ACCOUNTS_LIMIT = 60;

// Payload of a JWT (no signature check: only used to read userId and exp), or null.
export const decodeJwt = (jwt) => {
    try {
        const part = String(jwt || '').split('.')[1];
        if (!part) return null;
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
        return payload && typeof payload === 'object' ? payload : null;
    } catch {
        return null;
    }
};
export const looksLikeJwt = (value) => typeof value === 'string' && value.length < 4096 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value);

// A CSS colour as read from computed styles (rgb()/rgba()/hex): anything else is dropped before it reaches a style attribute.
export const safeColor = (value) => (typeof value === 'string' && /^(rgba?\([\d\s.,%/]{3,40}\)|#[0-9a-f]{3,8})$/i.test(value.trim()) ? value.trim() : '');

export const envOf = (host) => (/preprod/i.test(host || '') ? 'preprod' : 'prod');
export const accountId = (origin, userId) => `${origin}|${userId}`;
// Format used by the admin: <member origin>/vision/#/logingateway/?rt=<refresh token>
export const loginLink = (origin, rt) => `${origin}/vision/#/logingateway/?rt=${encodeURIComponent(rt)}`;

// Merge what the page just showed into the saved list (pure). A newer value wins, an empty one never erases what is known.
export const upsertAccount = (list, incoming, now = Date.now()) => {
    const index = list.findIndex((a) => a.id === incoming.id);
    const previous = index >= 0 ? list[index] : null;
    const merged = { ...(previous || {}), createdAt: previous ? previous.createdAt : now, updatedAt: now };
    for (const [key, value] of Object.entries(incoming)) {
        if (value !== undefined && value !== null && value !== '') merged[key] = value;
    }
    // "created" is the stronger origin: a later capture on a logged-in page does not demote it.
    if (previous && previous.source === 'created') merged.source = 'created';
    const rest = list.filter((a) => a.id !== incoming.id);
    return [merged, ...rest].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, ACCOUNTS_LIMIT);
};

// What the bar and the options page may see: never the tokens.
export const publicAccount = (account, brand, now = Date.now()) => ({
    id: account.id,
    pseudo: account.pseudo || '',
    email: account.email || '',
    host: account.host,
    env: envOf(account.host),
    title: (brand && brand.title) || account.title || account.host,
    logo: (brand && (brand.logo || brand.logoUrl)) || '',
    bg: (brand && brand.bg) || '',
    avatar: account.avatar || '',
    createdAt: account.createdAt,
    source: account.source,
    gender: account.gender || '',
    age: account.age || null,
    city: account.city || '',
    linkable: Boolean(account.rt),
    daysLeft: account.rtExp ? Math.floor((account.rtExp * 1000 - now) / 86400000) : null,
});
