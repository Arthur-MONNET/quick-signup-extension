// Service worker: starts a run (click on the icon or keyboard shortcut), keeps the per-tab run state in chrome.storage.session
// (survives the worker sleeping and page redirects, cleared when the browser closes), re-injects the engine after every
// full page load while a run is active, and remembers the journeys seen per site in chrome.storage.local.
import { DEFAULT_SETTINGS, PHOTO_ORIGIN, accountId, buildEmail, citySuggestionPattern, decodeJwt, effectiveHosts, isHostAllowed, loginLink, looksLikeJwt, normalizeHost, originPattern, photoQuery, publicAccount, randomProfile, safeColor, siteKeyOf, upsertAccount } from './shared.js';

const local = chrome.storage.local;
const session = chrome.storage.session;
const LOG_LIMIT = 40;
// Must equal BUILD in engine.js: the engine is read from disk on every page, the worker only when the extension is reloaded.
const BUILD = '15';
// A run waits for the first-use setup ('setup'), then for the choice of the account to create ('choose'), then runs.
const ACTIVE = ['setup', 'choose', 'running'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runKey = (tabId) => `run:${tabId}`;

const getSettings = async () => {
    const stored = (await local.get('settings')).settings || {};
    return { ...DEFAULT_SETTINGS, ...stored, allowedHosts: effectiveHosts(stored) };
};
const getPrefs = async () => ({ fillPassword: true, gender: 'man', usePhoto: true, stopAtPayment: false, ...((await local.get('prefs')).prefs || {}) });
const getRun = async (tabId) => (await session.get(runKey(tabId)))[runKey(tabId)] || null;

// Updates are serialised per tab: several messages arrive in a row from the page.
const queues = new Map();
const updateRun = (tabId, mutate) => {
    const next = (queues.get(tabId) || Promise.resolve()).then(async () => {
        const run = await getRun(tabId);
        if (!run) return null;
        const result = (await mutate(run)) ?? run;
        await session.set({ [runKey(tabId)]: run });
        return result;
    });
    queues.set(tabId, next.catch(() => undefined));
    return next;
};

let journeyQueue = Promise.resolve();
const updateJourney = (siteKey, mutate) => {
    const next = journeyQueue.then(async () => {
        const { journeys = {} } = await local.get('journeys');
        const journey = journeys[siteKey] || { steps: {}, runs: 0, ok: 0 };
        mutate(journey);
        journey.updated = new Date().toISOString().slice(0, 10);
        journeys[siteKey] = journey;
        await local.set({ journeys });
    });
    journeyQueue = next.catch(() => undefined);
    return next;
};

const BADGES = { choose: ['…', '#2563eb'], setup: ['…', '#2563eb'], running: ['…', '#2563eb'], done: ['OK', '#15803d'], stopped: ['■', '#6b7280'], unknown: ['?', '#b45309'], stuck: ['!', '#b91c1c'], error: ['!', '#b91c1c'] };
const setBadge = (tabId, status) => {
    const [text, color] = BADGES[status] || ['', '#000'];
    chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
    chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
};

const hostOf = (url) => {
    try {
        const u = new URL(url);
        return /^https?:$/.test(u.protocol) ? u.hostname : '';
    } catch {
        return '';
    }
};

const finishRun = async (tabId, status, message, unknown, blockedHost) => {
    const run = await getRun(tabId);
    if (!run) return;
    await updateRun(tabId, (r) => {
        r.status = status;
        r.message = message;
        r.unknown = unknown || null;
        r.blockedHost = blockedHost || null;
        r.endedAt = Date.now();
    });
    setBadge(tabId, status);
    await updateJourney(run.siteKey, (j) => {
        j.runs += 1;
        if (status === 'done') j.ok += 1;
    });
};

const inject = async (tabId) => {
    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['engine.js', 'content.js'] });
            return;
        } catch (err) {
            // A page that redirects while loading can drop the frame under the injection: try again once.
            if (attempt === 0) {
                await sleep(800);
                continue;
            }
            const run = await getRun(tabId);
            // An engine that already answered on this page (a later injection won): nothing is wrong, do not end the run.
            if (run && run.helloAt && run.helloAt >= started) return;
            await finishRun(tabId, 'error', `Cannot inject into this page (host permission missing?): ${err.message}`);
        }
    }
};

// One generated face per run, fetched here (the page could not: cross-origin) and handed to the engine as base64.
// The generated images carry a "this-person-does-not-exist.com" watermark, either top-left or bottom-left (1024 px square).
// Cut the same band at the top and the bottom, then keep the centred square: both cases lose the text, the face stays whole.
const cropWatermark = async (bytes, type) => {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    if (bitmap.width < 600 || Math.abs(bitmap.width - bitmap.height) > 8) throw new Error(`unexpected size ${bitmap.width}x${bitmap.height}`);
    const margin = Math.round(bitmap.height * 0.0625);
    const side = Math.min(bitmap.width, bitmap.height - 2 * margin);
    const canvas = new OffscreenCanvas(side, side);
    canvas.getContext('2d').drawImage(bitmap, Math.round((bitmap.width - side) / 2), margin, side, side, 0, 0, side, side);
    if (bitmap.close) bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return new Uint8Array(await blob.arrayBuffer());
};

const fetchPhoto = async (gender, age) => {
    // Returns { photo } or { error }: the error text is shown in the bar so a failure is never silent.
    const stage = { value: 'new' };
    try {
        const metaResponse = await fetch(`${PHOTO_ORIGIN}/new?${photoQuery(gender, age)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!metaResponse.ok) return { error: `/new answered HTTP ${metaResponse.status}` };
        const meta = await metaResponse.json();
        if (!/^\/img\/[\w.-]+\.jpe?g$/.test(meta.src || '')) return { error: `/new gave an unexpected answer (${JSON.stringify(meta).slice(0, 80)})` };
        stage.value = 'image';
        const response = await fetch(`${PHOTO_ORIGIN}${meta.src}`, { cache: 'no-store' });
        let type = response.headers.get('content-type') || '';
        if (!response.ok) return { error: `image answered HTTP ${response.status}` };
        let bytes = new Uint8Array(await response.arrayBuffer());
        if (!type.startsWith('image/') || bytes.length > 2_000_000 || bytes.length < 1000) return { error: `image not usable (${type || 'no type'}, ${bytes.length} bytes)` };
        let note = '';
        stage.value = 'crop';
        try {
            bytes = await cropWatermark(bytes, type);
            type = 'image/jpeg';
        } catch (err) {
            note = `watermark NOT cropped (${err && err.message ? err.message : err})`;
        }
        stage.value = 'encode';
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
        return { photo: { name: meta.name || 'photo.jpg', type, b64: btoa(binary) }, note };
    } catch (err) {
        return { error: `${stage.value} step failed: ${err && err.message ? err.message : err}` };
    }
};


// ---- Saved accounts -------------------------------------------------------------------------------------------------------
// accounts: [{ id: "<member origin>|<userId>", rt, rtExp, email, pseudo, host, origin, createdAt, updatedAt, source, ... }]
// brands: { "<host>": { title, logoUrl, logo (data URL) } }. The refresh token (rt) stays here: the bar only gets publicAccount().
let accountsQueue = Promise.resolve();
const withAccounts = (work) => {
    const next = accountsQueue.then(async () => {
        const stored = await local.get(['accounts', 'brands']);
        const state = { accounts: stored.accounts || [], brands: stored.brands || {} };
        const result = await work(state);
        await local.set({ accounts: state.accounts, brands: state.brands });
        return result;
    });
    accountsQueue = next.catch(() => undefined);
    return next;
};

// A small image as a data URL (brand logo, member photo): the page of another site could not load it (CSP) nor read it (CORS).
const fetchLogo = async (url, maxBytes = 150_000) => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return '';
        const response = await fetch(parsed.href, { cache: 'force-cache' });
        const type = response.headers.get('content-type') || '';
        if (!response.ok || !type.startsWith('image/')) return '';
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length < 50 || bytes.length > maxBytes) return '';
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
        return `data:${type};base64,${btoa(binary)}`;
    } catch {
        return '';
    }
};

const saveAccount = async (message, sender) => {
    const url = new URL(sender.tab.url || sender.url);
    const origin = url.origin;
    const host = url.hostname;
    const rt = looksLikeJwt(message.rt) ? message.rt : '';
    const access = looksLikeJwt(message.access) ? message.access : '';
    const claims = decodeJwt(rt) || decodeJwt(access) || {};
    const userId = Number(claims.userId);
    if (!Number.isFinite(userId) || userId <= 0) return { ok: false, error: 'no user id in the session' };
    const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const brandIn = message.brand || {};
    const logoUrl = /^https:\/\//.test(brandIn.logoUrl || '') ? String(brandIn.logoUrl).slice(0, 500) : '';
    const title = text(brandIn.title, 60);
    // Download the images outside the storage queue: it can take a moment.
    const stored = await local.get(['brands', 'accounts']);
    const known = (stored.brands || {})[host] || {};
    const logo = logoUrl && (logoUrl !== known.logoUrl || !known.logo) ? await fetchLogo(logoUrl) : known.logo || '';
    const bg = safeColor(brandIn.bg) || known.bg || '';
    const id = accountId(origin, userId);
    const previous = (stored.accounts || []).find((a) => a.id === id) || {};
    const avatarUrl = /^https:\/\//.test(message.avatarUrl || '') ? String(message.avatarUrl).slice(0, 500) : '';
    const avatar = avatarUrl && (avatarUrl !== previous.avatarUrl || !previous.avatar) ? await fetchLogo(avatarUrl, 60_000) : previous.avatar || '';
    const created = Number(message.createdAt);
    return withAccounts((state) => {
        if (title || logoUrl || logo) state.brands[host] = { title: title || known.title || '', logoUrl: logoUrl || known.logoUrl || '', logo, bg };
        const isNew = !state.accounts.some((a) => a.id === id);
        state.accounts = upsertAccount(state.accounts, {
            id,
            userId,
            origin,
            host,
            rt,
            rtExp: Number(decodeJwt(rt)?.exp) || undefined,
            email: text(message.email, 120),
            pseudo: text(message.pseudo, 60),
            gender: message.gender === 'woman' ? 'woman' : message.gender === 'man' ? 'man' : '',
            age: Number.isFinite(Number(message.age)) ? Number(message.age) : undefined,
            city: text(message.city, 60),
            avatarUrl: avatarUrl || undefined,
            avatar: avatar || undefined,
            createdAt: Number.isFinite(created) && created > 1e12 && created <= Date.now() ? created : undefined,
            source: message.source === 'captured' ? 'captured' : 'created',
        });
        return { ok: true, isNew, count: state.accounts.length };
    });
};

const handleAccounts = async (message, sender) => {
    switch (message.kind) {
        case 'accountSave':
            return saveAccount(message, sender);
        case 'accountList':
            return withAccounts((state) => ({ ok: true, accounts: state.accounts.map((a) => publicAccount(a, state.brands[a.host])) }));
        case 'accountLink':
        case 'accountOpen': {
            const account = await withAccounts((state) => state.accounts.find((a) => a.id === message.id) || null);
            if (!account || !account.rt) return { ok: false, error: 'No login link for this account (no refresh token was saved).' };
            const link = loginLink(account.origin, account.rt);
            if (message.kind === 'accountLink') return { ok: true, link };
            await chrome.tabs.create({ url: link, active: true, index: (sender.tab.index || 0) + 1 });
            return { ok: true };
        }
        case 'accountRemove':
            return withAccounts((state) => {
                state.accounts = state.accounts.filter((a) => a.id !== message.id);
                return { ok: true, count: state.accounts.length };
            });
        default:
            return { ok: false };
    }
};

const startRun = async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    const host = hostOf(tab.url || '');
    const settings = await getSettings();
    if (!host || !isHostAllowed(host, settings.allowedHosts)) return { ok: false, error: 'host-not-allowed', host };
    const previous = await getRun(tabId);
    if (previous && ACTIVE.includes(previous.status)) {
        await chrome.tabs.sendMessage(tabId, { kind: 'stop' }).catch(() => undefined);
        await sleep(700);
    }
    // First use: no e-mail domain yet. The bar asks for it in the page, then the run goes on (see 'saveSettings').
    const needsSetup = !settings.emailDomain;
    const run = {
        status: needsSetup ? 'setup' : 'choose',
        host,
        siteKey: siteKeyOf(host),
        startedAt: Date.now(),
        vars: {},
        pseudo: null,
        fillPassword: false,
        gender: null,
        usePhoto: false,
        stopAtPayment: false,
        age: null,
        city: null,
        citySuggestion: null,
        log: [],
        sigCounts: {},
        message: '',
        unknown: null,
    };
    await session.set({ [runKey(tabId)]: run });
    setBadge(tabId, needsSetup ? 'setup' : 'choose');
    await inject(tabId);
    return { ok: true, needsSetup };
};

// Domain and password: set once, global to every site, changed only by the user.
const handleSettings = async (message, tabId, run) => {
    const current = await getSettings();
    if (message.kind === 'settings') return { emailDomain: current.emailDomain, hasPassword: Boolean(current.password) };
    const domain = normalizeHost(message.emailDomain || current.emailDomain);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return { ok: false, error: 'Enter a valid domain, for example mailbox.example.com.' };
    const password = message.password ? String(message.password) : current.password;
    const stored = (await local.get('settings')).settings || {};
    await local.set({ settings: { ...stored, emailDomain: domain, password } });
    if (run && run.status === 'setup') {
        await updateRun(tabId, (r) => {
            r.status = 'choose';
        });
        setBadge(tabId, 'choose');
    }
    return { ok: true, hasPassword: Boolean(password) };
};

// Messages from the content scripts (the bar in the page).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;

    // From a content script: always carries sender.tab.
    if (sender.tab) {
        const tabId = sender.tab.id;
        (async () => {
            const run = await getRun(tabId);
            // The settings (domain, password) are global and reachable from any allowed page, run active or not.
            if (['settings', 'saveSettings'].includes(message.kind)) {
                if (!isHostAllowed(hostOf(sender.tab.url || sender.url), (await getSettings()).allowedHosts)) return { ok: false, error: 'This host is not allowed.' };
                return handleSettings(message, tabId, run);
            }
            // Saved accounts: available on any allowed page, run active or not.
            if (message.kind && message.kind.startsWith('account')) {
                if (!isHostAllowed(hostOf(sender.tab.url || sender.url), (await getSettings()).allowedHosts)) return { ok: false, error: 'This host is not allowed.' };
                return handleAccounts(message, sender);
            }
            // Messages of an older page instance (the page was replaced by a redirect) must not end or drive the run of the new one.
            if (run && run.engine && message.from && message.kind !== 'hello' && message.from !== run.engine) return { resume: false, error: `stale page instance ignored (message "${message.kind}")` };
            if (!run || !ACTIVE.includes(run.status)) return { resume: false, error: `no active run for this tab (${run ? `status: ${run.status}, reason: ${String(run.message || 'none').slice(0, 140)}` : 'none stored'}; tab ${tabId}; message "${message.kind}")` };
            const allowedBefore = { setup: ['hello', 'finish'], choose: ['hello', 'choose', 'finish'] };
            if (run.status !== 'running' && !(allowedBefore[run.status] || []).includes(message.kind)) return { resume: false, error: `run is "${run.status}", message "${message.kind}" refused` };
            switch (message.kind) {
                case 'hello': {
                    const settings = await getSettings();
                    if (!isHostAllowed(hostOf(sender.tab.url || sender.url), settings.allowedHosts)) return { resume: false };
                    await updateRun(tabId, (r) => {
                        r.engine = message.from || null;
                        r.helloAt = Date.now();
                    });
                    const { journeys = {} } = await local.get('journeys');
                    return {
                        resume: true,
                        build: BUILD,
                        setup: run.status === 'setup',
                        choose: run.status === 'setup' || run.status === 'choose',
                        prefs: await getPrefs(),
                        hasPassword: Boolean(settings.password),
                        vars: run.vars,
                        pseudo: run.pseudo,
                        history: run.log.map((entry) => entry.type),
                        learned: (journeys[run.siteKey] || {}).steps || {},
                        settings: { age: run.age, gender: run.gender, city: run.city, citySuggestion: run.citySuggestion, fillPassword: run.fillPassword, usePhoto: run.usePhoto, stopAtPayment: run.stopAtPayment },
                    };
                }
                case 'step': {
                    let count = 0;
                    await updateRun(tabId, (r) => {
                        const key = `${message.fp}|${message.route}`;
                        r.sigCounts[key] = (r.sigCounts[key] || 0) + 1;
                        count = r.sigCounts[key];
                        r.log = [...r.log, { t: Date.now(), type: message.type, fp: message.fp, route: message.route, note: message.note || '' }].slice(-LOG_LIMIT);
                    });
                    await updateJourney(run.siteKey, (j) => {
                        const step = j.steps[message.fp] || { type: message.type, slots: {}, seen: 0 };
                        step.seen += 1;
                        j.steps[message.fp] = step;
                    });
                    return { count };
                }
                case 'learn':
                    await updateJourney(run.siteKey, (j) => {
                        const step = j.steps[message.fp] || { type: message.type, slots: {}, seen: 0 };
                        step.slots = { ...step.slots, ...message.slots };
                        j.steps[message.fp] = step;
                    });
                    return {};
                case 'unlearn':
                    await updateJourney(run.siteKey, (j) => {
                        delete j.steps[message.fp];
                    });
                    return {};
                case 'vars':
                    await updateRun(tabId, (r) => {
                        r.pseudo = message.pseudo;
                    });
                    return {};
                case 'finish':
                    await finishRun(tabId, message.status, message.message, message.unknown);
                    return {};
                case 'photoHook': {
                    // Lets the page's own "add photo" click receive the generated image instead of opening the native file dialog.
                    if (!run.usePhoto || !message.photo || !message.photo.b64) return { ok: false };
                    await chrome.scripting.executeScript({
                        target: { tabId },
                        world: 'MAIN',
                        args: [{ name: String(message.photo.name), type: String(message.photo.type), b64: String(message.photo.b64) }],
                        func: (photo) => {
                            window.__qsPhoto = photo;
                            if (window.__qsHooked) return;
                            window.__qsHooked = true;
                            const original = HTMLInputElement.prototype.click;
                            HTMLInputElement.prototype.click = function () {
                                const p = window.__qsPhoto;
                                if (this.type !== 'file' || !p) return original.call(this);
                                window.__qsPhoto = null; // one use
                                const bytes = Uint8Array.from(atob(p.b64), (ch) => ch.charCodeAt(0));
                                const transfer = new DataTransfer();
                                transfer.items.add(new File([bytes], p.name, { type: p.type }));
                                this.files = transfer.files;
                                this.dispatchEvent(new Event('input', { bubbles: true }));
                                this.dispatchEvent(new Event('change', { bubbles: true }));
                            };
                        },
                    });
                    return { ok: true };
                }
                case 'photo':
                    return run.usePhoto ? await fetchPhoto(run.gender, run.age) : { error: 'photo option is off' };
                case 'choose': {
                    // Asked in the bar before every account: which gender to create, and the two optional extras.
                    const gender = message.gender === 'woman' ? 'woman' : 'man';
                    let current = await getSettings();
                    if (message.password) {
                        // Entered in the bar because none was saved yet: kept once for every site.
                        const stored = (await local.get('settings')).settings || {};
                        await local.set({ settings: { ...stored, password: String(message.password) } });
                        current = await getSettings();
                    }
                    const choice = { gender, usePhoto: Boolean(message.usePhoto), fillPassword: Boolean(current.password) && (message.fillPassword !== false), stopAtPayment: Boolean(message.stopAtPayment) };
                    await local.set({ prefs: choice });
                    let vars = {};
                    const profile = randomProfile();
                    await updateRun(tabId, (r) => {
                        Object.assign(r, choice, { age: profile.age, city: profile.city, citySuggestion: citySuggestionPattern(profile.city) });
                        r.vars = { email: buildEmail(current.emailDomain) };
                        r.status = 'running';
                        vars = r.vars;
                    });
                    setBadge(tabId, 'running');
                    return { ok: true, vars, hasPassword: Boolean(current.password), settings: { gender, usePhoto: choice.usePhoto, fillPassword: choice.fillPassword, stopAtPayment: choice.stopAtPayment, age: profile.age, city: profile.city, citySuggestion: citySuggestionPattern(profile.city) } };
                }
                case 'password':
                    // Only when this run asked for it; the value goes straight to the Password step and is never stored in the run.
                    return { password: run.fillPassword ? (await getSettings()).password : '' };
                default:
                    return {};
            }
        })()
            .catch((err) => ({ error: `worker exception in "${message && message.kind}": ${err && err.message ? err.message : err}` }))
            .then(sendResponse);
        return true;
    }

    return false;
});

// A full page load while a run is active (redirect to another step or host): resume there, or stop if the host is not allowed.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    const run = await getRun(tabId);
    if (!run || !ACTIVE.includes(run.status)) return;
    const host = hostOf(tab.url || '');
    const settings = await getSettings();
    if (!host || !isHostAllowed(host, settings.allowedHosts)) {
        await finishRun(tabId, 'stopped', `Left the allowed hosts (${host || 'unknown'}): run stopped. Click the extension icon on that page to allow it and resume.`, null, host);
        return;
    }
    await inject(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    session.remove(runKey(tabId));
});

// A short notice in the page when nothing can start (injected with the temporary access the click gives, never the engine).
const notice = (tabId, text) =>
    chrome.scripting
        .executeScript({
            target: { tabId },
            args: [text],
            func: (message) => {
                const host = document.createElement('div');
                host.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;';
                const shadow = host.attachShadow({ mode: 'closed' });
                const box = document.createElement('div');
                box.textContent = message;
                box.style.cssText = 'background:#1b1e24;color:#e8eaed;font:12.5px/1.45 -apple-system,system-ui,sans-serif;padding:8px 16px;border:1px solid #2d3139;border-top:0;border-radius:0 0 12px 12px;box-shadow:0 6px 22px rgba(0,0,0,.3);max-width:min(94vw,460px)';
                shadow.append(box);
                document.documentElement.append(host);
                setTimeout(() => host.remove(), 6000);
            },
        })
        .catch(() => undefined);

// One click on the icon (or the shortcut) starts everything: the bar in the page takes it from there.
const trigger = async (tab) => {
    if (!tab || tab.id === undefined) return;
    // Asked first, in the click's user gesture: some browsers keep an unpacked extension's site access on demand. No prompt when granted.
    chrome.permissions.request({ origins: [`${PHOTO_ORIGIN}/*`] }).catch(() => false);
    const host = hostOf(tab.url || '');
    const run = await getRun(tab.id);
    if (run && ACTIVE.includes(run.status)) {
        // Already running here: just bring the bar into view (Stop lives in the bar).
        await chrome.tabs.sendMessage(tab.id, { kind: 'reveal' }).catch(() => undefined);
        return;
    }
    if (run && run.blockedHost && run.blockedHost === host) {
        // The flow was handed over to this host and stopped: allow it (the browser asks for the permission) and resume.
        if (await chrome.permissions.request({ origins: [originPattern(host)] }).catch(() => false)) {
            const stored = (await local.get('settings')).settings || {};
            await local.set({ settings: { ...stored, allowedHosts: [...new Set([...effectiveHosts(stored), host])] } });
            await updateRun(tab.id, (r) => {
                r.status = 'running';
                r.blockedHost = null;
                r.message = '';
            });
            setBadge(tab.id, 'running');
            await inject(tab.id);
            return;
        }
    }
    const result = await startRun(tab.id).catch((err) => ({ ok: false, error: err.message }));
    if (!result.ok) {
        setBadge(tab.id, 'error');
        await notice(tab.id, result.error === 'host-not-allowed' ? `Quick Signup: ${result.host || 'this page'} is not in the allowed hosts. Add it in the extension options.` : `Quick Signup could not start: ${result.error}`);
    }
};

chrome.action.onClicked.addListener(trigger);
chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'quick-signup') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await trigger(tab);
});
