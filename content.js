// Glue between the page engine (engine.js) and the service worker. Injected programmatically by the service worker, only on an
// allowed host and only while a run is active for this tab. It resumes the run after every full page load (redirects).
(async () => {
    if (globalThis.__qsLoop) return;
    globalThis.__qsLoop = true;
    // Identifies this page instance: after a redirect the service worker ignores what the replaced page still sends.
    const from = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // After the extension is reloaded, the script left in an open page loses its connection: sendMessage then THROWS (it does not reject),
    // so a promise .catch is not enough. That orphaned script stops itself instead of logging errors.
    let orphaned = false;
    const send = async (message) => {
        if (orphaned) return undefined;
        try {
            return await chrome.runtime.sendMessage({ ...message, from });
        } catch (error) {
            if (!chrome.runtime || !chrome.runtime.id) orphaned = true;
            return undefined;
        }
    };

    const hello = await send({ kind: 'hello' });
    if (!hello || !hello.resume) {
        globalThis.__qsLoop = false;
        return;
    }
    // The engine file is fresh from disk, the service worker is only refreshed by "reload" in the extensions page: refuse to mix them.
    if (hello.build !== globalThis.__qs.BUILD) {
        const message = 'The extension was updated on disk but not reloaded: reload it in the extensions page, then click the icon again.';
        send({ kind: 'finish', status: 'error', message });
        globalThis.__qs.island.render({ vars: {}, pseudo: '' }, { state: 'error', message, step: undefined });
        globalThis.__qsLoop = false;
        return;
    }
    let cancelledByUser = false;
    const ctx = {
        vars: hello.vars,
        needsSetup: Boolean(hello.setup),
        needsChoice: Boolean(hello.choose),
        prefs: hello.prefs || {},
        hasPassword: Boolean(hello.hasPassword),
        pseudo: hello.pseudo,
        history: hello.history || [],
        learned: hello.learned || {},
        settings: hello.settings,
        get cancelled() {
            return orphaned || cancelledByUser;
        },
        set cancelled(value) {
            cancelledByUser = value;
        },
        send,
        // The password is fetched only at the Password step, only when the run asked for it, and never logged.
        getPhoto: async () => (await send({ kind: 'photo' })) || { error: 'no answer from the service worker' },
        getPassword: async () => (await send({ kind: 'password' }))?.password || '',
    };
    // What the page-side observer saw of the registration call (plain fields only; a page script could post the same shape, which
    // only changes what the bar displays).
    window.addEventListener('message', (event) => {
        const data = event.source === window && event.data;
        if (data && data.source === 'quick-signup' && data.kind === 'promo-register' && ctx.onPromo) ctx.onPromo(data);
    });
    chrome.runtime.onMessage.addListener((message) => {
        if (message && message.kind === 'stop') ctx.cancelled = true;
        if (message && message.kind === 'reveal' && globalThis.__qs) globalThis.__qs.island.reveal();
    });
    try {
        await globalThis.__qs.run(ctx);
    } finally {
        globalThis.__qsLoop = false;
    }
})();
