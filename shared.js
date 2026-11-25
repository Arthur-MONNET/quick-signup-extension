// Pure helpers used by the service worker (ES module, no DOM, no chrome.* calls).

// The extension works on any web page you start it on (manifest <all_urls>): there is no list of hosts and no options page.
export const DEFAULT_SETTINGS = {
    emailDomain: '', // set once in the bar (Settings), never in the code
    emailFormats: [], // see cleanFormats: the default format is always added
    defaultFormatId: 'default',
    password: '', // set once in the bar (Settings), never in the code, never logged
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
// The site offers 12-18, 19-25, 26-35, 35-50 and 50. Its age labels are approximate: 12-18 and 19-25 both return
// faces that look like minors, so only 26-35 and older are ever requested (a 24-year-old member gets a 26-35 face).
export const photoAgeRange = (age) => (age <= 35 ? '26-35' : age <= 50 ? '35-50' : '50');
export const photoQuery = (gender, age) => `time=${Date.now()}&gender=${gender === 'woman' ? 'female' : 'male'}&age=${photoAgeRange(age)}&etnic=all`;

// Test accounts are recognisable by their e-mail: test-<DDMM>-<HHmm>-<3 random chars>@domain (unique per attempt, no counter to keep).
export const EMAIL_PREFIX = 'test';

export const normalizeHost = (value) => String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');

export const isHostAllowed = (hostname, patterns) => {
    const host = normalizeHost(hostname);
    if (!host) return false;
    return (patterns || []).some((raw) => {
        const p = normalizeHost(raw);
        if (!p) return false;
        if (p === '*') return true;
        if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
        return host === p;
    });
};

// Chrome match pattern for a host entry ("*.x.com" -> "https://*.x.com/*").

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

// E-mail formats: a template with tokens, so every address is unique and recognisable. {ddmm} {hhmm} {rand3} {rand:N} {domain}.
// A template without "@" gets "@<domain>" appended. The default format reproduces the historical test-<DDMM>-<HHmm>-<3 chars>@domain.
export const DEFAULT_FORMAT_ID = 'default';
export const DEFAULT_EMAIL_FORMAT = { id: DEFAULT_FORMAT_ID, name: 'Default', template: `${EMAIL_PREFIX}-{ddmm}-{hhmm}-{rand3}@{domain}` };
export const FORMATS_LIMIT = 12;

export const renderEmail = (template, domain, date = new Date()) => {
    const out = String(template || '')
        .replace(/\{ddmm\}/gi, ddmm(date))
        .replace(/\{hhmm\}/gi, hhmm(date))
        .replace(/\{rand:(\d{1,2})\}/gi, (_, n) => randomChars(Math.max(1, Math.min(12, Number(n)))))
        .replace(/\{rand3\}/gi, () => randomChars(3))
        .replace(/\{domain\}/gi, normalizeHost(domain));
    return out.includes('@') ? out : `${out}@${normalizeHost(domain)}`;
};

// An error message, or '' when the template yields a plausible address.
export const validateTemplate = (template, domain = 'example.com') => {
    const value = String(template || '').trim();
    if (!value) return 'Enter a format.';
    if (value.length > 120) return 'Format too long (120 characters max).';
    if (/\{(?!ddmm\}|hhmm\}|rand3\}|rand:\d{1,2}\}|domain\})/i.test(value)) return 'Unknown token. Use {ddmm}, {hhmm}, {rand3}, {rand:N} or {domain}.';
    if (!/\{(rand3|rand:\d{1,2}|hhmm)\}/i.test(value)) return 'Add {rand3}, {rand:N} or {hhmm} so each address is unique.';
    const mail = renderEmail(value, domain);
    return /^[a-z0-9._%+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(mail) && mail.split('@').length === 2 ? '' : 'This does not produce a valid e-mail address.';
};

// Stored formats, sanitised; the default one always exists.
export const cleanFormats = (list) => {
    const seen = new Set();
    const out = [];
    for (const f of Array.isArray(list) ? list : []) {
        const id = String(f && f.id || '').slice(0, 40);
        const name = String(f && f.name || '').trim().slice(0, 40);
        const template = String(f && f.template || '').trim();
        if (!id || !name || seen.has(id) || validateTemplate(template)) continue;
        seen.add(id);
        out.push({ id, name, template });
    }
    if (!seen.has(DEFAULT_FORMAT_ID)) out.unshift({ ...DEFAULT_EMAIL_FORMAT });
    return out.slice(0, FORMATS_LIMIT);
};

export const buildEmail = (domain, template = DEFAULT_EMAIL_FORMAT.template, date = new Date()) => renderEmail(template, domain, date);

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

// What the bar may see: never the tokens.
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
