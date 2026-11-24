import { DEFAULT_HOSTS, DEFAULT_SETTINGS, normalizeHost, originPattern } from './shared.js';

const $ = (id) => document.getElementById(id);
const BUILT_IN = new Set(chrome.runtime.getManifest().host_permissions.map((p) => p.replace(/^https:\/\//, '').replace(/\/\*$/, '')));

let savedPassword = '';

const syncAllowAll = () => {
    $('allowedHosts').disabled = $('allowAll').checked;
    $('resetHosts').disabled = $('allowAll').checked;
};

const load = async () => {
    const settings = { ...DEFAULT_SETTINGS, ...((await chrome.storage.local.get('settings')).settings || {}) };
    savedPassword = settings.password || '';
    $('emailDomain').value = settings.emailDomain;
    $('allowedHosts').value = settings.allowedHosts.join('\n');
    $('allowAll').checked = settings.allowAllHosts !== false;
    syncAllowAll();
    $('password').value = '';
    $('passwordState').textContent = savedPassword ? 'A password is saved (hidden). Type a new one to replace it.' : 'No password saved.';
};

const save = async () => {
    $('error').hidden = true;
    $('saved').textContent = '';
    const hosts = [...new Set($('allowedHosts').value.split('\n').map(normalizeHost).filter(Boolean))];
    if (!$('allowAll').checked && !hosts.length) return fail('Add at least one host, or allow all sites.');
    // Must run first: the permission prompt needs the click's user gesture.
    // Every https site is already granted by the manifest ('*'); a narrower manifest would still ask here.
    const extra = BUILT_IN.has('*') ? [] : hosts.filter((h) => !BUILT_IN.has(h)).map(originPattern);
    if (extra.length && !(await chrome.permissions.request({ origins: extra }))) return fail('Permission refused: those hosts cannot be used without it.');

    const typed = $('password').value;
    await chrome.storage.local.set({
        settings: {
            emailDomain: normalizeHost($('emailDomain').value),
            password: typed || savedPassword,
            allowAllHosts: $('allowAll').checked,
            allowedHosts: hosts.length ? hosts : DEFAULT_HOSTS,
        },
    });
    await load();
    $('saved').textContent = 'Saved.';
};

const fail = (message) => {
    $('error').hidden = false;
    $('error').textContent = message;
};

$('allowAll').addEventListener('change', syncAllowAll);
$('save').addEventListener('click', save);
$('resetHosts').addEventListener('click', () => {
    $('allowedHosts').value = DEFAULT_HOSTS.join('\n');
});
$('forgetJourneys').addEventListener('click', async () => {
    await chrome.storage.local.remove('journeys');
    $('forgetJourneys').textContent = 'Forgotten';
});
$('clearPassword').addEventListener('click', async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, password: '' } });
    await load();
});

const loadAccounts = async () => {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    $('accountsState').textContent = accounts.length ? `${accounts.length} saved account${accounts.length > 1 ? 's' : ''}.` : 'No saved account.';
    $('forgetAccounts').disabled = !accounts.length;
};
$('forgetAccounts').addEventListener('click', async () => {
    await chrome.storage.local.remove(['accounts', 'brands']);
    await loadAccounts();
});

load();
loadAccounts();
