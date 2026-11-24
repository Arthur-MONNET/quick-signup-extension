// Registration engine: recognises the current step of a multi-step sign-up form from field attributes (language independent),
// fills it, advances, and stops with a clear report when a screen is not recognised.
// Logic derived from ~/.claude/skills/test-preprod/toolkit.js (probe / setValue / ops) and flows.json (candyshop flow).
// Classic script, injected by the service worker together with content.js. It never touches chrome.* itself: content.js
// passes a context object. Safety rules baked in:
//  - it never types anything on a payment page (the only action there is the "close the payment page" link);
//  - it only ticks the two known required boxes and stops on any other checkbox;
//  - the pseudo is a realistic first name + digits and never contains claude/test/bot/qa/fake/demo/tmp.
(() => {
    if (globalThis.__qs) return;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const OVERLAY_ID = 'qs-overlay';
    const BUILD = '21'; // see background.js

    // ---- Page helpers -------------------------------------------------------------------------------------------------
    const shown = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
    const inBanner = (e) => !!e.closest('[id*=didomi],[class*=didomi],[id*=cookie],[class*=cookie-banner]');
    const text = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
    const isBox = (e) => /^(checkbox|radio)$/.test(e.type);
    // Plain fields must be shown themselves (multi-step forms toggle the field, the wrapper stays visible). Custom checkboxes
    // and radios are display:none inside a visible label: those count when their parent is shown.
    const fields = () =>
        [...document.querySelectorAll('input,select,textarea')].filter((e) => e.type !== 'hidden' && !inBanner(e) && (shown(e) || (isBox(e) && shown(e.parentElement))));
    const buttons = () => [...document.querySelectorAll('button,a[href],[role=button],input[type=submit]')].filter((e) => shown(e) && !inBanner(e));
    const heading = () => text([...document.querySelectorAll('h1,h2,h3,legend,[class*=title]')].find((e) => shown(e) && !inBanner(e) && text(e)) || document.body).slice(0, 60);
    const routeKey = () => `${location.hostname}${location.pathname}${location.hash.split('?')[0]}`;
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Native setter + events: works on Vue/React controlled inputs.
    const setValue = (e, v) => {
        const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, v);
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Simulated keyboard typing (focus, then keydown/keypress/input/keyup per character): autocompletions such as the city
    // typeahead do not react to a plain native setter.
    const typeText = async (e, value) => {
        e.focus();
        e.click();
        setValue(e, '');
        let current = '';
        for (const ch of value) {
            const key = { key: ch, bubbles: true, cancelable: true };
            e.dispatchEvent(new KeyboardEvent('keydown', key));
            e.dispatchEvent(new KeyboardEvent('keypress', key));
            current += ch;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, current);
            e.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
            e.dispatchEvent(new KeyboardEvent('keyup', key));
            await sleep(70 + Math.random() * 60);
        }
        e.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // ---- Selectors (CSS, or "text:<regex>" over buttons/links/list items) ---------------------------------------------
    const stableId = (id) => id && !/\d{5,}/.test(id) && /^[A-Za-z][\w-]*$/.test(id);
    const selectorFor = (e) => {
        const tag = e.tagName.toLowerCase();
        if (e.name && /^[\w.-]+$/.test(e.name)) return `${tag}[name="${e.name}"]`;
        if (stableId(e.id)) return `${tag}#${e.id}`;
        if (e.tagName === 'A' && /\/payment\/later/.test(e.getAttribute('href') || '')) return 'a[href*="/payment/later"]';
        // A class that matches exactly one visible element beats the label (language independent, survives text changes).
        for (const cls of e.classList) {
            const sel = `${tag}.${cls}`;
            if (/^[A-Za-z][\w-]*$/.test(cls) && [...document.querySelectorAll(sel)].filter(shown).length === 1) return sel;
        }
        // Never build a selector from the text of a field: its value is what we type.
        if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName)) return null;
        const label = text(e).slice(0, 40);
        return label ? `text:^${escapeRe(label)}$` : null;
    };
    const resolve = (sel, all = false) => {
        if (!sel) return all ? [] : null;
        if (sel.startsWith('text:')) {
            const re = new RegExp(sel.slice(5), 'i');
            const hits = [...document.querySelectorAll('button,a,[role=button],[role=option],li')].filter((e) => shown(e) && !inBanner(e) && re.test(text(e)));
            return all ? hits : hits[0] || null;
        }
        let hits;
        try {
            hits = [...document.querySelectorAll(sel)].filter((e) => !inBanner(e) && (shown(e) || (isBox(e) && shown(e.parentElement))));
        } catch {
            hits = [];
        }
        return all ? hits : hits[0] || null;
    };

    // ---- Step recognition ---------------------------------------------------------------------------------------------
    const LATER_RE = /^(later|plus tard|pi[uù] tardi|m[aá]s tarde|sp[aä]ter|mais tarde|skip|passer|ignorer)$/i;
    const CARD_RE = /cc-|card|cvv|cvc|expir/i;
    const NAME_USER_RE = /^(login|username|pseudo|nickname|displayname)$/i;
    // Legacy registration forms use displayName for the signup pseudo.
    const isUserField = (e) => NAME_USER_RE.test(e.name) || NAME_USER_RE.test(e.id);
    const isEmailField = (e) => e.type === 'email' || e.name === 'email';
    const isAgeSelect = (e) => e.tagName === 'SELECT' && (e.name === 'birthdate' || e.options.length > 60);
    const isGenderField = (e) => (e.tagName === 'SELECT' && (e.name === 'gender' || e.name === 'genderSelect' || [...e.options].some((o) => /^(male|female)$/i.test(o.value)))) || (e.type === 'radio' && e.name === 'gender');
    const campaignQuestion = (field) => {
        const prompt = field?.parentElement?.previousElementSibling;
        return shown(prompt) ? text(prompt) : '';
    };
    const PREFERENCE_RE = /^(Which body type do you prefer|What hair color are you looking for|Quelle morphologie préférez-vous|Quelle couleur de cheveux recherchez-vous)\s*\?$/i;
    const CAMPAIGN_CITY_RE = /^(Where do you live|Où habitez-vous)\s*\?$/i;
    const CAMPAIGN_PSEUDO_RE = /^(Choose a username|Choisissez un pseudo)$/i;
    const CAMPAIGN_AGE_RE = /^(Select your age|What is the ideal age for you|Sélectionnez votre âge|Quel est l'âge idéal pour vous)\s*\??$/i;
    const isCampaignPseudo = (field) => field.type === 'text' && CAMPAIGN_PSEUDO_RE.test(campaignQuestion(field));

    // Entry controls, as the portals' own configs (src/portals/*/*/<alias>.json, promoToolsConfig) name them. Registration triggers:
    // #signUp, .signUp, .registerBtn, .js-register. Log-in triggers: #loginBtn, .loginBtn, #mobile-login, #desktop-login. Google
    // sign-up: .bt-google-signup(2). Only the first group is ever a way into the sign-up.
    const LOGIN_SEL = '#loginBtn,.loginBtn,#mobile-login,#desktop-login';
    const THIRD_PARTY_SEL = '.bt-google-signup,.bt-google-signup2,[class*=google-signup]';
    const REGISTER_SEL = '#signUp,.signUp,#registerBtn,.registerBtn,.js-register';
    // A control that logs an existing member in, or signs up through a third party: told by the config selectors above, by its id, name,
    // classes and data attributes, by what it opens (a /login address) and, as a safety net only, by its label. Used to EXCLUDE.
    const LOGIN_RE = /log[-_ ]?in|sign[-_ ]?in|connexion|\bconnection\b|connecter|already a member|déjà (membre|inscrit)|bereits mitglied|anmelden|iniciar sesi|accedi|entrar|inloggen/i;
    const THIRD_PARTY_RE = /google|facebook|apple[-_ ]?id|oauth|(continue|continuer|sign in|se connecter|inscrire) (with|avec)/i;
    const isLoginControl = (e) => {
        if (!e) return false;
        if (e.matches(`${LOGIN_SEL},${THIRD_PARTY_SEL}`) || e.closest(`${LOGIN_SEL},${THIRD_PARTY_SEL}`)) return true;
        const attrs = [e.id, e.name, String(e.className || ''), e.getAttribute('data-testid'), e.getAttribute('data-action'), e.getAttribute('aria-controls'), e.getAttribute('href'), e.getAttribute('aria-label')].filter(Boolean).join(' ');
        return LOGIN_RE.test(attrs) || LOGIN_RE.test(text(e)) || THIRD_PARTY_RE.test(attrs) || THIRD_PARTY_RE.test(text(e)) || /login|signin|connexion/i.test(e.getAttribute('formaction') || '');
    };
    // The registration entry button of a landing page, among the visible triggers of REGISTER_SEL (never a log-in or third-party one).
    const ctaButton = () => [resolve('button#signUp'), ...[...document.querySelectorAll(REGISTER_SEL)].filter((e) => shown(e) && !inBanner(e))].find((e) => e && !isLoginControl(e)) || null;
    const classify = () => {
        const fs = fields();
        const has = (f) => fs.some(f);
        const h = heading();
        const campaignField = fs.length === 1 ? fs[0] : null;
        const question = campaignQuestion(campaignField);
        let type = 'unknown';
        const later = [...document.querySelectorAll('a[href*="/payment/later"]')].find((e) => shown(e));
        if (later) type = 'payment-later';
        else if (has((e) => e.type === 'password')) type = 'password';
        else if (has((e) => CARD_RE.test(`${e.name} ${e.autocomplete}`))) type = 'payment';
        else if (has((e) => e.type === 'file')) type = 'photo';
        else if (has((e) => e.type === 'tel')) type = 'phone';
        // Promotool register form on one screen (spiice landing paths such as /d7W/ve2): any two or more of gender, age, e-mail and pseudo
        // together. The promotool options (with_gender, birthdate list/none, with_cgu...) decide which are there, so no fixed combination.
        else if ([has(isEmailField), has(isUserField), has(isAgeSelect), has(isGenderField)].filter(Boolean).length >= 2) type = 'onepage';
        // The same form with its fields revealed one by one: only the first is there yet, but a legal consent box on the same screen
        // says it is the whole sign-up (the separate gender / age steps never carry one).
        else if ((has(isGenderField) || has(isAgeSelect)) && has((e) => e.type === 'checkbox' && CONSENT_RE.test(`${e.name} ${e.id}`))) type = 'onepage';
        else if (has((e) => e.type === 'email' || e.name === 'email')) type = 'email';
        else if (has((e) => e.tagName === 'SELECT' && (e.name === 'birthdate' || e.options.length > 60))) type = 'age';
        else if (has(isUserField) || (campaignField && isCampaignPseudo(campaignField))) type = 'username';
        else if (has(isGenderField)) type = 'gender';
        else if (campaignField?.tagName === 'SELECT' && PREFERENCE_RE.test(question)) type = 'preference';
        else if (campaignField?.type === 'text' && CAMPAIGN_CITY_RE.test(question)) type = 'campaign-city';
        else if (has((e) => e.type === 'text' && (e.classList.contains('location-input') || e.closest('[class*=typehead],[class*=typeahead]'))) || (fs.length && /live in|habite|ville|city|where/i.test(h))) type = 'city';
        // Interests screen: clickable chips next to a hidden "hobbies" input (the chips are not form fields).
        else if (!fs.length && document.querySelector('input[type=hidden][name^=hobbies]')) type = 'hobbies';
        // Checkbox-only screens of the registration funnel, told apart by the VALUE of their boxes (not by their text):
        // "I am looking for" (criteria slugs, keep the preselection) and "also register on" (registration links, tick nothing).
        else if (fs.length >= 2 && fs.every((e) => e.type === 'checkbox') && fs.every((e) => /^https?:\/\//.test(e.value))) type = 'crossreg';
        else if (fs.length >= 2 && fs.every((e) => e.type === 'checkbox') && fs.every((e) => /^criteriaValue-\d+$/.test(e.value))) type = 'criteria';
        // Badge (mood) screen: a carousel next to a hidden "relationshipTag" input; the site preselects one.
        else if (!fs.length && document.querySelector('input[type=hidden][name=relationshipTag]')) type = 'badge';
        // Icebreaker screen: a carousel of predefined messages next to a hidden "predefinedWelcomeMessage" input; one is preselected.
        else if (!fs.length && document.querySelector('input[type=hidden][name=predefinedWelcomeMessage],input[type=hidden][name*=welcome i],textarea[name=msg],textarea[name*=welcome i]')) type = 'welcome';
        else if (!fs.length && ctaButton()) type = 'cta';
        const names = [...new Set(fs.map((e) => e.name || e.type))].sort().join(',');
        const stepQuestion = type === 'preference' || (type === 'age' && CAMPAIGN_AGE_RE.test(question)) ? question : '';
        const fp = `${type}:${names}${stepQuestion ? `:${stepQuestion}` : type === 'unknown' ? `|${h}` : ''}`.slice(0, 120);
        return { type, fp, sig: `${fp}|${routeKey()}`, h, fs };
    };

    const pageMessages = () => [...document.querySelectorAll('[class*=error],[class*=invalid],[role=alert]')].filter((e) => shown(e) && !inBanner(e) && text(e)).slice(0, 3).map((e) => text(e).slice(0, 90));
    const describeUnknown = (st) => ({
        fp: st.fp,
        heading: st.h,
        route: routeKey(),
        fields: st.fs.slice(0, 8).map((e) => `${e.tagName.toLowerCase()}[${e.type}]${e.name ? `:${e.name}` : ''}`),
        buttons: buttons().slice(0, 6).map((e) => text(e).slice(0, 28)).filter(Boolean),
        // Hidden inputs and non-visible textareas carry the step's data name: what recognises screens that have no visible field.
        hidden: [...document.querySelectorAll('input[type=hidden],textarea')].filter((e) => !shown(e) && !inBanner(e)).slice(0, 8).map((e) => `${e.tagName.toLowerCase()}:${e.name || e.id || '?'}`),
        // What the page itself says (validation errors, alerts): the most useful clue when a step does not move.
        messages: pageMessages(),
    });

    // ---- Random pseudo ------------------------------------------------------------------------------------------------
    const BANNED_RE = /claude|test|bot|qa|fake|demo|tmp/i;
    const pick = (chars) => {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return chars[buf[0] % chars.length];
    };
    // Realistic pseudo: a first name matching the chosen gender plus digits (e.g. "Lucas92", "camille_87"), redrawn if it ever holds a banned word.
    const NAMES = {
        man: ['Lucas', 'Hugo', 'Louis', 'Jules', 'Arthur', 'Nathan', 'Thomas', 'Maxime', 'Antoine', 'Alexis', 'Julien', 'Romain', 'Kevin', 'Mathieu', 'Adrien', 'Florian', 'Clement', 'Damien', 'Vincent', 'Olivier', 'Nicolas', 'Pierre', 'Guillaume', 'Fabien', 'Yoann', 'Benjamin', 'Theo', 'Rayan', 'Gabriel', 'Enzo'],
        woman: ['Emma', 'Lea', 'Chloe', 'Camille', 'Manon', 'Ines', 'Sarah', 'Julie', 'Laura', 'Marion', 'Pauline', 'Clara', 'Lola', 'Jade', 'Zoe', 'Anais', 'Alice', 'Lucie', 'Oceane', 'Mathilde', 'Elodie', 'Amandine', 'Justine', 'Charlotte', 'Margaux', 'Eva', 'Noemie', 'Romane', 'Axelle', 'Salome'],
    };
    const digits = (n) => Array.from({ length: n }, () => pick('0123456789')).join('');
    const genPseudo = (gender) => {
        const names = NAMES[gender === 'woman' ? 'woman' : 'man'];
        for (let i = 0; i < 200; i++) {
            const name = names[crypto.getRandomValues(new Uint32Array(1))[0] % names.length];
            const style = crypto.getRandomValues(new Uint32Array(1))[0] % 3;
            const p = style === 0 ? `${name}${digits(2)}` : style === 1 ? `${name}${pick('123456789')}${digits(2)}` : `${name.toLowerCase()}_${digits(2)}`;
            if (!BANNED_RE.test(p)) return p;
        }
        throw new Error('could not generate a pseudo');
    };

    // ---- The island: a black bar stuck to the top edge of the page (notch style), shadow DOM so the page CSS cannot touch it and
    // the step recognition never sees it. Compact while running, opens on hover or click, opens by itself when the run ends.
    // [type, label, optional]: an optional step is listed only once the run has met it (the flows differ from site to site).
    const STEPS = [
        ['cta', 'Start'],
        ['onepage', 'Sign-up form', true],
        ['gender', 'Gender'],
        ['age', 'Age'],
        ['preference', 'Profile preference', true],
        ['email', 'E-mail'],
        ['username', 'Pseudo'],
        ['campaign-city', 'City on landing page', true],
        ['criteria', 'Looking for', true],
        ['city', 'City'],
        ['photo', 'Photo'],
        ['hobbies', 'Hobbies'],
        ['badge', 'Badge'],
        ['welcome', 'Message'],
        ['crossreg', 'Other sites', true],
        ['phone', 'Phone'],
        ['payment-later', 'Payment page'],
        ['password', 'Password'],
    ];
    const STATE_LABELS = { running: 'Signing up', done: 'Account ready', unknown: 'Unknown screen', stuck: 'Step not moving', error: 'Error', stopped: 'Stopped', setup: 'First-time setup', settings: 'Settings', choose: 'New account' };
    // Geometry of the notch. RADIUS is used twice on purpose: the bottom corners of the panel, and the concave fillets that join its
    // sides to the full-width rail (the exact inverse curve, so the rail flows into the panel).
    const RADIUS = 12;
    const RAIL = 4;
    const INK = '#1b1e24';
    const ISLAND_CSS = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .line { position: fixed; top: 0; left: 0; right: 0; height: ${RAIL}px; background: ${INK}; z-index: 2147483647; pointer-events: none; }
        .trace { position: fixed; left: 0; top: 0; pointer-events: none; overflow: visible; z-index: 2147483647; }
        .trace path { fill: none; stroke: #4c9aff; stroke-width: ${RAIL}px; stroke-linecap: butt; stroke-dasharray: 0 100; transition: stroke-dasharray .35s ease, stroke .3s ease; }
        .line[data-state=done] ~ .trace path { stroke: #3fb950; }
        .line[data-state=unknown] ~ .trace path, .line[data-state=stuck] ~ .trace path { stroke: #d29922; }
        .line[data-state=error] ~ .trace path { stroke: #f85149; }
        .line[data-state=stopped] ~ .trace path { stroke: #7d8590; }
        .ring { display: none; flex: none; width: 20px; height: 20px; }
        .ring .base { fill: none; stroke: #2d3139; stroke-width: 2.5; }
        .ring .arc { fill: none; stroke: #4c9aff; stroke-width: 2.5; stroke-dasharray: 0 100; transition: stroke-dasharray .35s ease, stroke .3s ease; }
        .ring .core { fill: #4c9aff; }
        .bar-root[data-state=running] .ring .core { animation: pulse 1.4s ease-in-out infinite; }
        .bar-root[data-state=done] .ring .arc { stroke: #3fb950; } .bar-root[data-state=done] .ring .core { fill: #3fb950; }
        .bar-root[data-state=unknown] .ring .arc, .bar-root[data-state=stuck] .ring .arc { stroke: #d29922; } .bar-root[data-state=unknown] .ring .core, .bar-root[data-state=stuck] .ring .core { fill: #d29922; }
        .bar-root[data-state=error] .ring .arc { stroke: #f85149; } .bar-root[data-state=error] .ring .core { fill: #f85149; }
        .bar-root[data-state=stopped] .ring .arc { stroke: #7d8590; } .bar-root[data-state=stopped] .ring .core { fill: #7d8590; }
        .mbar { display: none; height: 3px; margin: 0 12px; border-radius: 2px; background: #2d3139; overflow: hidden; }
        .mbar i { display: block; width: 0; height: 100%; border-radius: 2px; background: #4c9aff; transition: width .35s ease, background .3s ease; }
        .bar-root[data-state=done] .mbar i { background: #3fb950; }
        .bar-root[data-state=unknown] .mbar i, .bar-root[data-state=stuck] .mbar i { background: #d29922; }
        .bar-root[data-state=error] .mbar i { background: #f85149; }
        .bar-root[data-state=stopped] .mbar i { background: #7d8590; }
        .bar-root { position: fixed; top: 0; left: 0; right: 0; margin: 0 auto; z-index: 2147483647; width: 320px; max-width: 94%;
            background: ${INK}; color: #e8eaed; font: 12.5px/1.45 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
            border-radius: 0 0 ${RADIUS}px ${RADIUS}px; filter: drop-shadow(0 6px 9px rgba(0,0,0,.28)); transition: width .25s ease; }
        .bar-root::before, .bar-root::after { content: ""; position: absolute; top: ${RAIL}px; width: ${RADIUS}px; height: ${RADIUS}px; pointer-events: none; }
        .bar-root::before { left: -${RADIUS}px; background: radial-gradient(circle at 0 100%, transparent ${RADIUS}px, ${INK} ${RADIUS + 0.5}px); }
        .bar-root::after { right: -${RADIUS}px; background: radial-gradient(circle at 100% 100%, transparent ${RADIUS}px, ${INK} ${RADIUS + 0.5}px); }
        .bar-root.open { width: 440px; }
        .bar { display: flex; align-items: center; gap: 9px; padding: ${RAIL}px 12px 0; height: ${32 + RAIL}px; cursor: pointer; user-select: none; }
        .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #4c9aff; }
        [data-state=running] .dot { animation: pulse 1.4s ease-in-out infinite; }
        [data-state=done] .dot { background: #3fb950; }
        [data-state=unknown] .dot, [data-state=stuck] .dot { background: #d29922; }
        [data-state=error] .dot { background: #f85149; }
        [data-state=stopped] .dot { background: #7d8590; }
        .label { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .label small { font-weight: 400; color: #8b929c; margin-left: 8px; }
        .count { flex: none; color: #8b929c; font-variant-numeric: tabular-nums; }
        .panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .25s ease; }
        .bar-root.open .panel { grid-template-rows: 1fr; }
        .panel > div { overflow: hidden; min-height: 0; }
        .inner { padding: 8px 14px 12px; border-top: 1px solid #2d3139; }
        .inner[data-mode=form] .runbox { display: none; }
        .inner:not([data-mode=form]) .formbox { display: none; }
        .tabs { display: flex; align-items: center; gap: 6px; margin: 0 0 11px; }
        .tabs .tab { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; padding: 4px 11px 4px 9px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: #9aa1ab; font-weight: 600; }
        .tabs .tab:hover { background: #262a32; color: #e8eaed; }
        .tabs .tab.on { background: #2a2f38; border-color: #343a45; color: #fff; }
        .tabs svg { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
        .tabs .spacer { flex: 1; }
        .tabs .x { display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; border-radius: 50%; border-color: transparent; color: #9aa1ab; }
        [data-state=running] .tabs .x { display: none; }
        .ident { display: flex; align-items: center; gap: 10px; padding: 9px 11px; margin: 0 0 10px; border: 1px solid #2d3139; border-radius: 10px; background: #20242b; }
        .ident .who { flex: 1; min-width: 0; }
        .ident .who b { display: block; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ident .mail { font: 11.5px ui-monospace, Menlo, monospace; color: #c9ced6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ident .muted { color: #8b929c; }
        .ident .hostchip { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; color: #8b929c; font-size: 11.5px; }
        ul { list-style: none; margin: 0 0 8px; padding: 0; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px 12px; }
        li { display: flex; align-items: center; gap: 7px; color: #6b727c; }
        li.done { color: #e8eaed; }
        li.cur { color: #fff; font-weight: 600; }
        .ico { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid #3b414b; flex: none; position: relative; }
        li.done .ico { background: #3fb950; border-color: #3fb950; }
        li.done .ico::after { content: ""; position: absolute; left: 2.5px; top: 0.5px; width: 2px; height: 5px; border: solid #0d1117; border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); }
        li.cur .ico { border-color: #4c9aff #4c9aff #4c9aff transparent; animation: spin .8s linear infinite; }
        .bar-root:not([data-state=running]) li.cur .ico { animation: none; border-color: currentColor; }
        dl { margin: 6px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
        dt { color: #8b929c; }
        dd { margin: 0; word-break: break-all; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
        .msg { margin: 8px 0 0; color: #c9ced6; }
        pre { margin: 8px 0 0; padding: 7px 9px; border-radius: 6px; background: #14171c; color: #c9ced6; font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
        .choices { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
        .choices:empty { display: none; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
        .actions:empty { display: none; }
        button { font: inherit; border: 1px solid #3b414b; border-radius: 6px; padding: 4px 12px; cursor: pointer; background: transparent; color: #e8eaed; }
        button:hover { background: #2d3139; }
        button.stop { border-color: #f85149; color: #f85149; }
        button.stop:hover { background: rgba(248,81,73,.12); }
        button.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; font-weight: 600; }
        button.primary:hover { background: #3b7bff; }
        button:disabled { opacity: .5; cursor: default; }
        .formbox .intro { margin: 0 0 10px; color: #aeb4bd; white-space: pre-line; }
        .field { display: block; margin: 0 0 9px; }
        .field > span { display: block; margin-bottom: 3px; color: #c9ced6; font-weight: 600; }
        .field > small { display: block; margin-top: 2px; color: #7d8590; }
        input { width: 100%; font: inherit; padding: 6px 9px; border-radius: 6px; border: 1px solid #3b414b; background: #14171c; color: #e8eaed; outline: none; }
        input:focus { border-color: #4c9aff; box-shadow: 0 0 0 3px rgba(76,154,255,.18); }
        input.secret { -webkit-text-security: disc; }
        .err { margin: 0 0 8px; color: #f85149; }
        .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .seg button { padding: 8px 0; font-weight: 600; }
        .seg button.on { background: #2f6feb; border-color: #2f6feb; color: #fff; }
        label.check { display: flex; align-items: center; gap: 8px; margin: 0 0 7px; color: #c9ced6; cursor: pointer; }
        label.check input { width: auto; margin: 0; }
        .actions .left { margin-right: auto; }
        .actions button[aria-pressed="true"] { background: #2563eb; border-color: #2563eb; color: #fff; }
        .accts { display: grid; gap: 8px; max-height: 300px; overflow-y: auto; margin: 0 0 2px; padding-right: 2px; }
        .accts::-webkit-scrollbar { width: 6px; }
        .accts::-webkit-scrollbar-thumb { background: #3b414b; border-radius: 3px; }
        .acct { display: grid; grid-template-columns: 40px 1fr auto; gap: 3px 11px; padding: 10px; border: 1px solid #2d3139; border-radius: 10px; background: #20242b; }
        .acct .logo { grid-row: 1 / span 2; width: 40px; height: 40px; border-radius: 9px; display: grid; place-items: center; overflow: hidden; border: 1px solid rgba(255,255,255,.1); color: #1b1e24; font-weight: 700; font-size: 16px; }
        .acct .logo img { width: 100%; height: 100%; object-fit: contain; padding: 4px; }
        .acct .who { min-width: 0; }
        .acct .name { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .acct .name b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
        .acct .avatar { flex: none; width: 20px; height: 20px; border-radius: 50%; object-fit: cover; background: #2d3139; }
        .acct .mail { font: 11.5px ui-monospace, Menlo, monospace; color: #c9ced6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .acct .meta { color: #8b929c; font-size: 11.5px; }
        .acct .meta .warn { color: #d29922; }
        .acct .open { align-self: start; padding: 3px 14px; }
        .acct .ghosts { grid-column: 2 / span 2; display: flex; gap: 6px; margin-top: 4px; }
        .acct .ghosts button { padding: 2px 9px; font-size: 11.5px; border-color: #343a45; color: #c9ced6; }
        .acct .ghosts .gap { margin-left: auto; }
        .acct .ghosts .gap:hover { color: #f85149; border-color: #f85149; background: rgba(248,81,73,.1); }
        .tag { flex: none; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 1px 6px; border-radius: 9px; }
        .tag.prod { background: rgba(63,185,80,.16); color: #56d364; }
        .tag.preprod { background: rgba(210,153,34,.18); color: #e3b341; }
        .empty { margin: 4px 0 8px; color: #8b929c; }
        @media (max-width: 480px) { ul { grid-template-columns: 1fr 1fr; } }
        @keyframes pulse { 50% { opacity: .35; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        button { -webkit-tap-highlight-color: transparent; }
        .bar-root.open .panel > div { overflow-y: auto; max-height: calc(100vh - ${42 + RAIL}px); max-height: calc(100dvh - ${42 + RAIL}px); }
        /* Touch: bigger targets, whatever the width (phone, tablet, touch laptop). */
        @media (pointer: coarse) {
            button { min-height: 36px; }
            .tabs .tab { min-height: 36px; padding: 6px 12px 6px 10px; }
            .tabs .x { width: 36px; height: 36px; }
            .acct .open { min-height: 38px; }
            .acct .ghosts button { min-height: 34px; }
            label.check { min-height: 32px; }
            input[type=checkbox] { width: 20px; height: 20px; }
        }
        /* Phone: the compact pill stays small so the site's own header remains usable; opened, the panel takes the full width and scrolls. */
        @media (max-width: 520px) {
            .bar-root { width: 188px; top: env(safe-area-inset-top, 0px); }
            .trace, .dot { display: none; }
            .ring { display: block; }
            .bar-root.open .mbar { display: block; }
            .bar { height: ${30 + RAIL}px; gap: 7px; padding-left: 10px; padding-right: 10px; }
            .label small { display: none; }
            .bar-root.open { width: 100%; max-width: 100%; border-radius: 0 0 16px 16px; }
            .bar-root.open::before, .bar-root.open::after { display: none; }
            .bar-root.open .bar { height: ${38 + RAIL}px; }
            .bar-root.open .label small { display: inline; }
            .inner { padding: 8px 12px calc(12px + env(safe-area-inset-bottom, 0px)); }
            input { font-size: 16px; }
            ul { grid-template-columns: 1fr 1fr; }
            .actions, .formbox .actions { gap: 10px; }
            .actions button, .formbox .actions button { flex: 1; min-height: 40px; }
            .accts { max-height: none; overflow: visible; padding-right: 0; }
            .acct { grid-template-columns: 40px 1fr; }
            .acct .open { grid-column: 1 / -1; justify-self: stretch; padding: 8px; }
            .acct .ghosts { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr auto; }
            .acct .ghosts .gap { margin-left: 0; }
            .ident { flex-wrap: wrap; }
            .ident .hostchip { flex-direction: row; align-items: center; gap: 8px; }
        }
        @media (max-width: 400px) { .tabs .tab:not(.on) span { display: none; } .tabs .tab { padding: 6px 10px; } }
        @media (prefers-reduced-motion: reduce) { .bar-root, .bar-root * { animation: none !important; transition: none !important; } }`;

    // Tabs of the bubble (inline icons, 16x16 grid).
    const TAB_DEFS = [
        ['run', 'Sign-up', '<path d="M5.5 3.5l7 4.5-7 4.5z"/>'],
        ['accounts', 'Accounts', '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.5 2.6-3.7 5-3.7s4.4 1.2 5 3.7"/>'],
        ['settings', 'Settings', '<path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.7"/><circle cx="10.5" cy="11" r="1.7"/>'],
    ];
    const island = (() => {
        let nodes = null;
        let onTab = null;
        // Open when hovered, pinned (click, or a form being filled) or held open for a moment after a result; otherwise compact.
        let pinned = false;
        let hovered = false;
        let hold = false;
        let holdTimer = 0;
        const sync = () => nodes && nodes.root.classList.toggle('open', pinned || hovered || hold);
        const holdOpen = (ms) => {
            clearTimeout(holdTimer);
            hold = true;
            if (ms) holdTimer = setTimeout(() => { hold = false; sync(); }, ms);
        };
        const el = (tag, cls, txt) => {
            const n = document.createElement(tag);
            if (cls) n.className = cls;
            if (txt !== undefined) n.textContent = txt;
            return n;
        };
        // Progress, as a percentage of the whole route around the bubble (desktop) or of the bar (phone).
        let pct = 0;
        const setPct = (value) => {
            pct = value;
            if (!nodes) return;
            const dash = `${value} 100`;
            nodes.tracePath.style.strokeDasharray = dash;
            nodes.arc.style.strokeDasharray = dash;
            nodes.mbarFill.style.width = `${value}%`;
        };
        // Route of the stroke, inset by half its thickness so it covers the dark rail exactly: along the rail, down the concave fillet,
        // the side, round the bottom corner, across, up the other side and back onto the rail. Same radius as the bubble's own corners.
        const redraw = () => {
            if (!nodes || !nodes.host.isConnected || matchMedia('(max-width: 520px)').matches) return;
            const box = nodes.root.getBoundingClientRect();
            const W = document.documentElement.clientWidth;
            const R = RADIUS;
            const t = RAIL / 2;
            const f = (n) => Math.round(n * 100) / 100;
            const left = box.left;
            const right = box.right;
            const bottom = box.bottom;
            nodes.tracePath.setAttribute(
                'd',
                `M0 ${t} H${f(left - R)} A${R + t} ${R + t} 0 0 1 ${f(left + t)} ${RAIL + R} V${f(bottom - R)} A${R - t} ${R - t} 0 0 0 ${f(left + R)} ${f(bottom - t)}` +
                    ` H${f(right - R)} A${R - t} ${R - t} 0 0 0 ${f(right - t)} ${f(bottom - R)} V${RAIL + R} A${R + t} ${R + t} 0 0 1 ${f(right + R)} ${t} H${W}`
            );
            nodes.trace.setAttribute('width', String(W));
            nodes.trace.setAttribute('height', String(f(bottom + RAIL)));
            nodes.trace.setAttribute('viewBox', `0 0 ${W} ${f(bottom + RAIL)}`);
        };
        const build = () => {
            const host = document.createElement('div');
            host.id = OVERLAY_ID;
            const shadow = host.attachShadow({ mode: 'closed' });
            const style = el('style');
            style.textContent = ISLAND_CSS;
            const root = el('div', 'bar-root');
            const bar = el('div', 'bar');
            const label = el('div', 'label');
            const count = el('div', 'count');
            bar.append(el('i', 'dot'), label, count);
            // The rail is the dark line; the progress is a coloured stroke of the same thickness laid over it that then follows the
            // outline of the bubble (see redraw). On a phone a ring in the header and a linear bar under it show the same value instead.
            const line = el('div', 'line');
            const svgNode = (tag, attrs) => {
                const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
                for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
                return node;
            };
            const trace = svgNode('svg', { class: 'trace', 'aria-hidden': 'true' });
            const tracePath = svgNode('path', { pathLength: '100' });
            trace.append(tracePath);
            const ring = svgNode('svg', { class: 'ring', viewBox: '0 0 20 20', 'aria-hidden': 'true' });
            const arc = svgNode('circle', { class: 'arc', cx: '10', cy: '10', r: '8', pathLength: '100', transform: 'rotate(-90 10 10)' });
            ring.append(svgNode('circle', { class: 'base', cx: '10', cy: '10', r: '8' }), arc, svgNode('circle', { class: 'core', cx: '10', cy: '10', r: '2.6' }));
            bar.insertBefore(ring, label);
            const mbar = el('div', 'mbar');
            const mbarFill = el('i');
            mbar.append(mbarFill);
            const list = el('ul');
            const ident = el('div', 'ident');
            const msg = el('p', 'msg');
            const detail = el('pre');
            const actions = el('div', 'actions');
            const runBox = el('div', 'runbox');
            const choices = el('div', 'choices');
            runBox.append(ident, list, msg, detail, choices, actions);
            const formBox = el('div', 'formbox');
            // Tabs: the same bubble shows the sign-up, the saved accounts or the settings. The header above always follows the run.
            const tabs = el('div', 'tabs');
            const tabButtons = {};
            for (const [name, text, icon] of TAB_DEFS) {
                const b = el('button', 'tab');
                b.type = 'button';
                b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icon}</svg>`;
                b.append(el('span', '', text));
                b.addEventListener('click', () => onTab && onTab(name));
                tabButtons[name] = b;
                tabs.append(b);
            }
            const closeBtn = el('button', 'x');
            closeBtn.type = 'button';
            closeBtn.title = 'Close';
            closeBtn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
            closeBtn.addEventListener('click', () => host.remove());
            tabs.append(el('span', 'spacer'), closeBtn);
            const inner = el('div', 'inner');
            inner.append(tabs, runBox, formBox);
            const wrap = el('div');
            wrap.append(inner);
            const panel = el('div', 'panel');
            panel.append(wrap);
            root.append(bar, mbar, panel);
            shadow.append(style, line, root, trace);
            // A tap on the header opens or collapses the bubble. Hover only exists with a mouse: on touch a "hover" would stay stuck
            // after the first tap, so it is not listened to there.
            const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
            bar.addEventListener('click', () => {
                if (!canHover && (pinned || hold)) {
                    pinned = false;
                    hold = false;
                    clearTimeout(holdTimer);
                } else pinned = !pinned;
                sync();
            });
            if (canHover) {
                host.addEventListener('mouseenter', () => {
                    hovered = true;
                    sync();
                });
                host.addEventListener('mouseleave', () => {
                    hovered = false;
                    hold = false;
                    clearTimeout(holdTimer);
                    sync();
                });
            }
            document.documentElement.append(host);
            nodes = { host, root, line, label, count, trace, tracePath, arc, mbarFill, list, ident, msg, detail, choices, actions, inner, formBox, tabButtons };
            // The route follows the bubble frame by frame while it folds, unfolds or the window is resized.
            new ResizeObserver(redraw).observe(root);
            addEventListener('resize', redraw);
            matchMedia('(max-width: 520px)').addEventListener('change', redraw);
            setPct(pct);
            redraw();
        };
        // Marks the active tab (and shows the number of saved accounts in its label).
        const setTab = (c, name) => {
            c.tab = name;
            for (const [key, button] of Object.entries(nodes.tabButtons)) button.classList.toggle('on', key === name);
            nodes.tabButtons.accounts.lastChild.textContent = c.accountCount ? `Accounts (${c.accountCount})` : 'Accounts';
        };
        const render = (c, view) => {
            if (!nodes || !nodes.host.isConnected) build();
            const { root, line, label, count, list, ident, msg, detail, choices, actions, inner, formBox } = nodes;
            c.lastView = view;
            const state = view.state;
            // The header always follows the run, whatever tab is open.
            root.dataset.state = state;
            line.dataset.state = state;
            // Progress = the steps validated so far (seen earlier in the run, or confirmed by the site's own registration call),
            // not a position: a one-screen form validates gender, age, e-mail and pseudo at once.
            const atPayment = state === 'done' && /^payment/.test(view.step || '');
            const currentType = view.step === 'payment' ? 'payment-later' : view.step;
            const seen = new Set(c.history || []);
            const steps = STEPS.filter(([type, , optional]) => !optional || seen.has(type) || type === currentType);
            const current = steps.findIndex(([type]) => type === currentType);
            // The step being handled is not validated yet; once the page moved on to a screen we do not know, it is.
            const validated = (type) => (state === 'done' && !atPayment) || (seen.has(type) && (type !== currentType || state === 'unknown' || atPayment || state === 'done'));
            const reached = steps.filter(([type]) => validated(type)).length;
            label.replaceChildren(document.createTextNode(atPayment ? 'Payment page reached' : STATE_LABELS[state] || state));
            if (state === 'running' && current >= 0) label.append(el('small', '', steps[current][1]));
            count.textContent = `${reached}/${steps.length}`;
            setPct((reached / steps.length) * 100);
            // A step went by while the user reads the accounts or the settings: do not pull them away from it. A result (done, problem) does.
            if (c.tab && c.tab !== 'run' && state === 'running') return;
            setTab(c, 'run');
            inner.dataset.mode = 'view';
            formBox.replaceChildren();
            list.replaceChildren(
                ...steps.map(([type, name], i) => {
                    const li = el('li', validated(type) ? 'done' : i === current ? 'cur' : '', name);
                    li.prepend(el('span', 'ico'));
                    return li;
                })
            );
            const who = el('div', 'who');
            if (c.pseudo) who.append(el('b', '', c.pseudo));
            if (c.vars && c.vars.email) who.append(el('div', 'mail', c.vars.email));
            if (!who.childNodes.length) who.append(el('div', 'muted', 'No account yet'));
            const env = /preprod/i.test(location.hostname) ? 'preprod' : 'prod';
            const chip = el('div', 'hostchip');
            chip.append(el('span', `tag ${env}`, env), el('span', '', location.hostname));
            ident.replaceChildren(who, chip);
            msg.textContent = view.message || '';
            msg.hidden = !view.message;
            const info = view.extra;
            detail.hidden = !info;
            detail.textContent = info ? [`Step: ${info.fp}`, `Heading: ${info.heading}`, `Fields: ${info.fields.join(', ') || '-'}`, `Buttons: ${info.buttons.join(' | ') || '-'}`, `Hidden: ${(info.hidden || []).join(', ') || '-'}`, `Page says: ${(info.messages || []).join(' | ') || '-'}`].join('\n') : '';
            // Footer: only the primary action of the view (Stop while running). Close, Settings and Accounts live in the tab row.
            choices.replaceChildren(
                ...(view.choices || []).map((name, i) => {
                    const pick = el('button', 'primary', name);
                    pick.addEventListener('click', () => view.onChoose(i));
                    return pick;
                })
            );
            actions.replaceChildren();
            if (state === 'running' || view.choices) {
                const stopBtn = el('button', 'stop', 'Stop');
                stopBtn.addEventListener('click', view.stop);
                actions.append(stopBtn);
            }
            // A form is gone and the run goes on (or ended): back to compact unless hovered. A result opens by itself so it gets read:
            // a few seconds when the account is ready, until the mouse has been over it when something needs attention.
            pinned = false;
            clearTimeout(holdTimer);
            hold = false;
            if (state === 'done') holdOpen(6000);
            else if (state !== 'running') holdOpen(0);
            sync();
        };
        // Settings form shown in the bar itself (first use, or the "Settings" button).
        // spec: { state, title, intro, fields: [{ key, label, value, placeholder, hint, secret, type }], submit, onSubmit(values) -> error | null, onCancel }
        const form = (c, spec) => {
            if (!nodes || !nodes.host.isConnected) build();
            const { root, line, label, count, inner, formBox } = nodes;
            inner.dataset.mode = 'form';
            // The settings tab leaves the header on the run; the first-use and "new account" forms are part of the run.
            if (spec.tab !== 'settings') {
                root.dataset.state = spec.state;
                line.dataset.state = spec.state;
                label.replaceChildren(document.createTextNode(STATE_LABELS[spec.state] || spec.state));
                count.textContent = '';
                setPct(0);
            }
            setTab(c, spec.tab || 'run');
            pinned = true;
            clearTimeout(holdTimer);
            sync();
            const getters = {};
            const err = el('p', 'err');
            err.hidden = true;
            const submit = el('button', 'primary', spec.submit);
            const send = async () => {
                const values = Object.fromEntries(Object.entries(getters).map(([k, get]) => [k, get()]));
                submit.disabled = true;
                err.hidden = true;
                const problem = await spec.onSubmit(values);
                if (problem) {
                    err.textContent = problem;
                    err.hidden = false;
                    submit.disabled = false;
                }
            };
            formBox.replaceChildren(el('p', 'intro', spec.intro));
            let firstInput = null;
            for (const f of spec.fields) {
                if (f.kind === 'segmented') {
                    let current = f.value;
                    const group = el('div', 'seg');
                    const buttonsOf = f.options.map(([value, name]) => {
                        const b = el('button', value === current ? 'on' : '', name);
                        b.type = 'button';
                        b.addEventListener('click', () => {
                            current = value;
                            buttonsOf.forEach((x) => x.classList.toggle('on', x === b));
                        });
                        group.append(b);
                        return b;
                    });
                    getters[f.key] = () => current;
                    const row = el('div', 'field');
                    row.append(el('span', '', f.label), group);
                    formBox.append(row);
                    continue;
                }
                if (f.kind === 'checkbox') {
                    const box = el('input');
                    box.type = 'checkbox';
                    box.checked = Boolean(f.value);
                    getters[f.key] = () => box.checked;
                    const row = el('label', 'check');
                    row.append(box, el('span', '', f.label));
                    formBox.append(row);
                    continue;
                }
                const input = el('input');
                input.type = f.type || 'text';
                input.value = f.value || '';
                input.placeholder = f.placeholder || '';
                input.autocomplete = 'off';
                input.spellcheck = false;
                if (f.secret) input.classList.add('secret');
                input.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') send();
                });
                getters[f.key] = () => input.value;
                firstInput = firstInput || input;
                const row = el('label', 'field');
                row.append(el('span', '', f.label), input);
                if (f.hint) row.append(el('small', '', f.hint));
                formBox.append(row);
            }
            const actions = el('div', 'actions');
            if (spec.onToggleMediaBlur) {
                const extra = el('button', 'left', 'Media blur');
                extra.type = 'button';
                extra.dataset.mediaBlur = '';
                extra.setAttribute('aria-pressed', String(Boolean(globalThis.__qsMediaBlur)));
                extra.addEventListener('click', async () => {
                    extra.disabled = true;
                    const problem = await spec.onToggleMediaBlur();
                    err.textContent = problem || '';
                    err.hidden = !problem;
                    extra.disabled = false;
                });
                actions.append(extra);
            }
            if (spec.onCancel) {
                const cancel = el('button', '', 'Cancel');
                cancel.addEventListener('click', spec.onCancel);
                actions.append(cancel);
            }
            submit.addEventListener('click', send);
            actions.append(submit);
            formBox.append(err, actions);
            if (firstInput) setTimeout(() => firstInput.focus(), 50);
        };
        // Saved accounts. spec: { list, onBack, onOpen(id), onLink(id), onMail(account), onRemove(id) } -> Promise<{ ok } | { error }>
        const copy = async (value) => {
            try {
                await navigator.clipboard.writeText(value);
                return true;
            } catch {
                const area = document.createElement('textarea');
                area.value = value;
                area.style.cssText = 'position:fixed;left:-9999px;top:0';
                document.body.append(area);
                area.select();
                const ok = document.execCommand('copy');
                area.remove();
                return ok;
            }
        };
        const when = (ts) => {
            const d = new Date(ts);
            const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            return d.toDateString() === new Date().toDateString() ? `today ${hm}` : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
        };
        const accounts = (c, spec) => {
            if (!nodes || !nodes.host.isConnected) build();
            const { inner, formBox } = nodes;
            inner.dataset.mode = 'form';
            setTab(c, 'accounts');
            pinned = true;
            clearTimeout(holdTimer);
            sync();
            const note = el('p', 'err');
            note.hidden = true;
            const flash = (button, text, ms = 1200) => {
                const before = button.textContent;
                button.textContent = text;
                button.disabled = true;
                setTimeout(() => {
                    button.textContent = before;
                    button.disabled = false;
                }, ms);
            };
            const act = async (button, work, done) => {
                note.hidden = true;
                const result = await work();
                if (result && result.error) {
                    note.textContent = result.error;
                    note.hidden = false;
                } else if (done) flash(button, done);
            };
            const letter = (a) => (a.title || a.host || '?').slice(0, 1).toUpperCase();
            const box = el('div', 'accts');
            for (const a of spec.list) {
                const row = el('div', 'acct');
                // The logo sits on the colour it was designed for: the background behind it on the member area.
                const logo = el('div', 'logo');
                logo.style.background = a.bg || '#fff';
                if (a.logo) {
                    const img = el('img');
                    img.src = a.logo;
                    img.alt = '';
                    img.addEventListener('error', () => logo.replaceChildren(document.createTextNode(letter(a))));
                    logo.append(img);
                } else logo.textContent = letter(a);
                const who = el('div', 'who');
                const name = el('div', 'name');
                if (a.avatar) {
                    const face = el('img', 'avatar');
                    face.src = a.avatar;
                    face.alt = '';
                    name.append(face);
                }
                name.append(el('b', '', a.pseudo || a.title), el('span', `tag ${a.env}`, a.env));
                who.append(name);
                if (a.email) who.append(el('div', 'mail', a.email));
                const profile = [a.gender === 'woman' ? 'Woman' : a.gender === 'man' ? 'Man' : '', a.age ? `${a.age}` : '', a.city].filter(Boolean).join(' · ');
                logo.title = a.title;
                const meta = el('div', 'meta', [a.source === 'captured' ? 'signed in' : 'created', when(a.createdAt)].join(' · '));
                if (!a.linkable) meta.append(document.createTextNode(' · '), el('span', 'warn', 'no login link'));
                else if (a.daysLeft !== null) meta.append(document.createTextNode(' · '), el('span', a.daysLeft < 3 ? 'warn' : '', a.daysLeft < 0 ? 'link expired' : `link ${a.daysLeft} d left`));
                if (profile) who.append(el('div', 'meta', profile));
                who.append(meta);
                const open = el('button', 'primary open', 'Open');
                open.disabled = !a.linkable;
                open.title = 'Sign this account in, in a new tab (replaces the session of that site in this browser)';
                open.addEventListener('click', () => act(open, () => spec.onOpen(a.id)));
                const ghosts = el('div', 'ghosts');
                const link = el('button', '', 'Copy link');
                link.disabled = !a.linkable;
                link.addEventListener('click', () => act(link, () => spec.onLink(a.id), 'Copied'));
                const mail = el('button', '', 'Copy e-mail');
                mail.disabled = !a.email;
                mail.addEventListener('click', () => act(mail, () => spec.onMail(a), 'Copied'));
                const remove = el('button', 'gap', 'Remove');
                remove.addEventListener('click', () => act(remove, () => spec.onRemove(a.id)));
                ghosts.append(link, mail, remove);
                row.append(logo, who, open, ghosts);
                box.append(row);
            }
            formBox.replaceChildren(
                spec.list.length ? box : el('p', 'empty', 'No saved account yet. Accounts you create here, or that are signed in when you click the extension, will appear in this list.'),
                note
            );
        };
        // Brought back into view by a click on the extension icon while a run is going.
        const reveal = () => {
            if (nodes && nodes.host.isConnected) holdOpen(5000);
            sync();
        };
        document.addEventListener('quick-signup:media-blur-changed', () => {
            nodes?.formBox.querySelector('[data-media-blur]')?.setAttribute('aria-pressed', String(Boolean(globalThis.__qsMediaBlur)));
        });
        return { render, form, accounts, copy, reveal, setOnTab: (fn) => { onTab = fn; } };
    })();

    class StopRun extends Error {
        constructor(status, message, extra) {
            super(message);
            this.status = status;
            this.extra = extra;
        }
    }

    // ---- Step handlers ------------------------------------------------------------------------------------------------
    // c: run context { vars, learned, settings, send(evt), getPassword(), cancelled, pseudo }
    // A slot is a named element of a step (field, next button...). Learned selectors are tried first; a discovered one is
    // recorded through the context so the next run replays the step without searching.
    const slot = (c, st, name, discover) => {
        const learned = c.learned[st.fp];
        const known = learned && learned.slots && learned.slots[name];
        const viaMemory = known ? resolve(known) : null;
        if (viaMemory) return viaMemory;
        const el = discover();
        const sel = el && selectorFor(el);
        if (sel) {
            st.slots = { ...(st.slots || {}), [name]: sel };
            c.send({ kind: 'learn', fp: st.fp, type: st.type, slots: st.slots });
            c.learned[st.fp] = { ...(learned || {}), type: st.type, slots: st.slots };
        }
        return el;
    };
    const need = (el, what) => {
        if (!el) throw new StopRun('unknown', `Element not found: ${what}`);
        return el;
    };
    const nextButton = (c, st) =>
        need(
            slot(c, st, 'next', () => {
                const near = st.fs[0] && st.fs[0].closest('form');
                const own = near && [...near.querySelectorAll('button[type=submit],input[type=submit]')].filter((e) => shown(e) && e.id !== 'signUp');
                // Last resort: the only visible <button> of the screen (the landing buttons stay in the DOM behind the form).
                const lone = buttons().filter((e) => e.tagName === 'BUTTON' && e.id !== 'signUp');
                return resolve('#next_btn') || (own && own.length === 1 ? own[0] : null) || (lone.length === 1 ? lone[0] : null);
            }),
            'advance button'
        );
    // The screen has no <form> (candyshop member area): take the first ancestor of the field that holds visible buttons, if it holds exactly one.
    // The first text input after `anchor` that sits in the same form: the pseudo of a modal whose inputs carry no name or id.
    const textAfter = (anchor, fs) => {
        const form = anchor.closest('form');
        const list = fs.filter((e) => e.type === 'text' && e !== anchor && (!form || form.contains(e)));
        return list.find((e) => anchor.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
    };
    // The visible submit button of the form that holds `field`, when there is exactly one.
    const submitFor = (field) => {
        const form = field && field.closest('form');
        const own = form ? [...form.querySelectorAll('button,input[type=submit]')].filter((e) => shown(e) && !inBanner(e) && e.type !== 'button' && e.type !== 'reset') : [];
        return own.length === 1 ? own[0] : null;
    };
    const nearestButton = (field) => {
        for (let node = field.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
            const own = [...node.querySelectorAll('button,input[type=submit]')].filter((e) => shown(e) && !inBanner(e));
            if (own.length) return own.length === 1 ? own[0] : null;
        }
        return null;
    };
    const skipButton = (c, st) => need(slot(c, st, 'skip', () => buttons().find((e) => LATER_RE.test(text(e)))), '"Later" button');
    const ensureChecked = async (box) => {
        if (!box.checked) (shown(box) ? box : box.closest('label') || box.nextElementSibling || box.parentElement).click();
        await sleep(150);
        if (!box.checked) throw new StopRun('unknown', `Could not tick ${box.name}`);
    };
    const verify = (el, expected, what) => {
        if (el.value !== expected) throw new StopRun('error', `${what} was not kept by the page`);
    };

    const fillGender = (field, gender) => {
        const select = field.tagName === 'SELECT';
        const options = select ? [...field.options] : [...document.querySelectorAll('input[type=radio][name=gender]')];
        const enabled = options.filter((option) => option.value && !option.disabled);
        const woman = gender === 'woman';
        // Legacy forms list women first and encode gender as 1 (woman) or 2 (man).
        const legacy = field.name === 'genderSelect';
        const value = legacy ? (woman ? '1' : '2') : (woman ? 'female' : 'male');
        const choice = enabled.find((option) => option.value.toLowerCase() === value) || (!legacy && enabled[woman ? 1 : 0]);
        if (!choice) throw new StopRun('error', 'No gender option for the chosen account type');
        if (select) {
            if (field.value !== choice.value) setValue(field, choice.value);
            verify(field, choice.value, 'The gender');
        } else if (!choice.checked) choice.click();
    };

    // Carousel screens: the page preselects an item when it mounts (about a second later). Keep that default and go on.
    const keepDefault = async (c, st) => {
        await sleep(600);
        nextButton(c, st).click();
    };

    // Consent boxes the extension may tick: by name on the candyshop forms, by id when the site leaves the name empty.
    const CONSENT_RE = /(^|[^a-z])(accept_cguv|accept_privacy_policy|terms|cgu|cguv|cgv|privacy)/i;
    const STOP_AT_PAYMENT = 'Stopped on the payment page, as you asked: nothing was paid or typed. The account exists.';
    // With "stop on the payment page" on, reaching the end means this run had no payment page: say so.
    const doneRun = (c, message) => new StopRun('done', c.settings.stopAtPayment ? `${message} No payment page came up on this run, so there was nothing to stop on.` : message);

    const handlers = {
        cta: async (c, st) => {
            need(slot(c, st, 'cta', () => ctaButton()), 'sign-up button').click();
        },
        gender: async (c, st) => {
            const field = need(st.fs.find(isGenderField), 'gender input');
            fillGender(field, c.settings.gender);
            await sleep(200);
            nextButton(c, st).click();
        },
        age: async (c, st) => {
            const field = need(slot(c, st, 'field', () => st.fs.find(isAgeSelect)), 'age select');
            const age = String(c.settings.age);
            const option = [...field.options].find((o) => o.value === age) || [...field.options].find((o) => new RegExp(`^${age}\\b`).test(o.text));
            if (!option) throw new StopRun('error', `No age option for ${age}`);
            setValue(field, option.value);
            await sleep(400);
            nextButton(c, st).click();
        },
        preference: async (c, st) => {
            const field = need(st.fs.find((e) => e.tagName === 'SELECT'), 'preference select');
            // The first entry is the placeholder even after Vue assigns it the selected value.
            const option = [...field.options].slice(1).find((entry) => entry.value && !entry.disabled);
            if (!option) throw new StopRun('error', 'No available profile preference option');
            setValue(field, option.value);
            verify(field, option.value, 'The profile preference');
            await sleep(200);
            nextButton(c, st).click();
        },
        'campaign-city': async (c, st) => {
            const field = st.fs[0];
            setValue(field, c.settings.city);
            verify(field, c.settings.city, 'The city');
            await sleep(200);
            nextButton(c, st).click();
        },
        email: async (c, st) => {
            // Legal consents only (by name or id): anything else (newsletter...) stops the run rather than being ticked.
            const stray = st.fs.find((e) => e.type === 'checkbox' && !CONSENT_RE.test(`${e.name} ${e.id}`));
            if (stray) throw new StopRun('unknown', `Unexpected checkbox "${stray.name || stray.id || 'unnamed'}": only the legal consents are ticked`);
            const field = need(slot(c, st, 'field', () => resolve('input[name=email]') || st.fs.find((e) => e.type === 'email')), 'email input');
            // Typed like a person, then the field is left (blur, change): many forms validate the address (and ask the server) only then.
            await typeText(field, c.vars.email);
            verify(field, c.vars.email, 'The e-mail');
            const leave = () => {
                field.dispatchEvent(new Event('change', { bubbles: true }));
                field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
                field.dispatchEvent(new FocusEvent('blur'));
                field.blur();
            };
            leave();
            // Let the validation answer (a network call finishing) before touching the boxes, like a person who reads the screen.
            const calls = () => performance.getEntriesByType('resource').filter((r) => /fetch|xmlhttprequest/.test(r.initiatorType)).length;
            const before = calls();
            await sleep(1200);
            for (let t = 0; t < 15 && calls() === before; t++) await sleep(200);
            await sleep(800);
            // Tick every consent box slowly (some appear once the e-mail is accepted).
            for (const box of fields().filter((e) => e.type === 'checkbox')) {
                await ensureChecked(box);
                await sleep(600);
            }
            // The submit button can stay disabled for a long time: wait up to 20 s, leaving the e-mail field again once if it hangs.
            const next = nextButton(c, st);
            const disabled = () => next.disabled || next.getAttribute('aria-disabled') === 'true' || /disabled/.test(String(next.className));
            for (let t = 0; t < 133 && disabled(); t++) {
                await sleep(150);
                if (t === 40) leave();
            }
            if (disabled()) throw new StopRun('stuck', 'The e-mail step button stayed disabled for 20 s after the e-mail and the consent boxes: the page does not consider the form valid.', describeUnknown(st));
            await sleep(500);
            next.click();
        },
        onepage: async (c, st) => {
            // The promotool register form on one screen. Fills whatever of gender, age, e-mail, pseudo and consent is there, in any
            // combination, and again after each pass: some variants reveal the next field only once the previous one is filled.
            const done = {};
            for (let pass = 0; pass < 10; pass++) {
                const fs = fields();
                let acted = false;
                const stray = fs.find((e) => e.type === 'checkbox' && !CONSENT_RE.test(`${e.name} ${e.id}`));
                if (stray) throw new StopRun('unknown', `Unexpected checkbox "${stray.name || stray.id || 'unnamed'}": only the legal consents are ticked`);

                const gender = !done.gender && fs.find(isGenderField);
                if (gender) {
                    fillGender(gender, c.settings.gender);
                    done.gender = acted = true;
                }
                const ageSelect = !done.age && fs.find(isAgeSelect);
                if (ageSelect) {
                    const age = String(c.settings.age);
                    const option = [...ageSelect.options].find((o) => o.value === age) || [...ageSelect.options].find((o) => new RegExp(`^${age}\\b`).test(o.text));
                    if (!option) throw new StopRun('error', `No age option for ${age}`);
                    setValue(ageSelect, option.value);
                    verify(ageSelect, option.value, 'The age');
                    done.age = acted = true;
                }
                const emailField = !done.email && fs.find(isEmailField);
                if (emailField) {
                    setValue(emailField, c.vars.email);
                    verify(emailField, c.vars.email, 'The e-mail');
                    done.email = acted = true;
                }
                // Some modals leave the pseudo input without name or id: it is then the first text input after the e-mail one, in its form.
                const mailInput = fs.find(isEmailField);
                const userField = !done.user && (fs.find(isUserField) || (mailInput && textAfter(mailInput, fs)));
                if (userField) {
                    if (!c.pseudo) c.pseudo = genPseudo(c.settings.gender);
                    await typeText(userField, c.pseudo);
                    if (userField.value !== c.pseudo || BANNED_RE.test(userField.value)) throw new StopRun('error', 'The pseudo field does not hold the random pseudo: stopped before submitting');
                    c.send({ kind: 'vars', pseudo: c.pseudo });
                    done.user = acted = true;
                }
                // A required list that is none of the above (promotool with_criteria) and still empty: its first real choice will do.
                for (const select of fs.filter((e) => e.tagName === 'SELECT' && !e.value && e !== gender && e !== ageSelect && !isGenderField(e) && !isAgeSelect(e))) {
                    const first = [...select.options].find((o) => o.value && !o.disabled);
                    if (first) {
                        setValue(select, first.value);
                        acted = true;
                    }
                }
                for (const box of fs.filter((e) => e.type === 'checkbox' && !e.checked)) {
                    await ensureChecked(box);
                    acted = true;
                }
                if (!acted) break;
                await sleep(500);
            }
            if (!Object.keys(done).length) throw new StopRun('unknown', 'Sign-up form recognised but none of its fields could be filled');
            // What this form covers is validated as soon as the next page loads; the site's own registration call confirms it sooner.
            const covers = { gender: 'gender', age: 'age', email: 'email', user: 'username' };
            c.pendingCover = Object.keys(done).map((key) => covers[key]);
            c.send({ kind: 'pendingCover', types: c.pendingCover });
            // The site may check the pseudo with the server while it is typed: let that answer come back before pressing the button.
            const calls = () => performance.getEntriesByType('resource').filter((r) => /fetch|xmlhttprequest/.test(r.initiatorType)).length;
            const before = calls();
            await sleep(1000);
            for (let t = 0; t < 15 && calls() === before; t++) await sleep(200);
            await sleep(500);
            // The button of the form that holds these fields (a chat box elsewhere on the page has its own "Send").
            const anchor = fields().find(isEmailField) || fields().find(isAgeSelect) || fields().find(isGenderField);
            const next = submitFor(anchor) || nextButton(c, st);
            // The button stays disabled until the form is valid: wait for it rather than click a dead button.
            for (let t = 0; t < 20 && next.disabled; t++) await sleep(200);
            if (next.disabled) throw new StopRun('stuck', 'The sign-up button stayed disabled: the page does not consider the form valid.', describeUnknown(st));
            next.click();
        },
        username: async (c, st) => {
            const field = need(slot(c, st, 'field', () => st.fs.find((e) => isUserField(e) || isCampaignPseudo(e))), 'pseudo input');
            // Keep the same pseudo when retrying (the click may simply not have been taken); draw another only if the page complained.
            if (!c.pseudo || (c.usernameTries > 0 && pageMessages().length)) c.pseudo = genPseudo(c.settings.gender);
            c.usernameTries = (c.usernameTries || 0) + 1;
            if (c.usernameTries > 5) throw new StopRun('error', 'The site keeps refusing the pseudo step');
            // Typed key by key like a person (the field is prefilled by the site and is replaced), then read back.
            await typeText(field, c.pseudo);
            if (field.value !== c.pseudo || BANNED_RE.test(field.value)) throw new StopRun('error', 'The pseudo field does not hold the random pseudo: stopped before submitting');
            c.send({ kind: 'vars', pseudo: c.pseudo });
            // The site checks the pseudo with the server while you type: clicking at once is ignored. Wait for that answer (a new
            // network call finishing), with a floor and a ceiling, like a person who looks at the screen before pressing NEXT.
            const calls = () => performance.getEntriesByType('resource').filter((r) => /fetch|xmlhttprequest/.test(r.initiatorType)).length;
            const before = calls();
            await sleep(1200);
            for (let t = 0; t < 20 && calls() === before; t++) await sleep(200);
            await sleep(600);
            const next = nextButton(c, st);
            const sig = classify().sig;
            next.click();
            // Submitted = the button shows its loading state (or the screen moved). If not, the click was ignored: retry, no duplicate.
            const loading = () => {
                const spinner = next.querySelector('.loading');
                return next.disabled || (spinner && shown(spinner));
            };
            for (let t = 0; t < 30; t++) {
                await sleep(200);
                if (loading() || classify().sig !== sig) return undefined;
            }
            return 'retry';
        },
        city: async (c, st) => {
            const field = need(slot(c, st, 'field', () => resolve('input.location-input') || st.fs.find((e) => e.type === 'text')), 'city input');
            const suggestions = () => [...document.querySelectorAll('li.typehead__item')].filter((e) => shown(e));
            // The drawn city first (entry starting with it), then any French entry for it, then Paris as a last resort.
            const attempts = [[c.settings.city, new RegExp(c.settings.citySuggestion, 'i')], [c.settings.city, /france/i], ['Paris', /^paris,.*france/i]];
            let item = null;
            for (const [typed, wanted] of attempts) {
                await typeText(field, typed);
                for (let t = 0; t < 20 && !item; t++) {
                    await sleep(200);
                    item = suggestions().find((e) => wanted.test(text(e)));
                }
                if (item) break;
            }
            if (!item) throw new StopRun('unknown', `No city suggestion found for ${c.settings.city}`);
            (item.querySelector('a') || item).click();
            await sleep(600);
            nextButton(c, st).click();
        },
        photo: async (c, st) => {
            const input = st.fs.find((e) => e.type === 'file');
            const trace = [];
            // Generated face first (once per run). Every stage is recorded so a failure says exactly where it stopped.
            if (c.settings.usePhoto && input && !c.photoAttached) {
                c.photoAttached = true;
                const got = await c.getPhoto();
                const photo = got && got.photo;
                trace.push(photo ? `image fetched${got.note ? ` (${got.note})` : ' and cropped'}` : `image NOT fetched: ${(got && got.error) || `the service worker answered without a photo (received: ${JSON.stringify(Object.keys(got || {}))})`}`);
                if (photo) {
                    const before = new Set(buttons());
                    const sig0 = classify().sig;
                    const attach = () => {
                        const bytes = Uint8Array.from(atob(photo.b64), (ch) => ch.charCodeAt(0));
                        const transfer = new DataTransfer();
                        transfer.items.add(new File([bytes], photo.name, { type: photo.type }));
                        input.files = transfer.files;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    };
                    // The page reacted when a button appears (crop dialog confirm) or the screen fields changed.
                    const reacted = async (ms) => {
                        for (let t = 0; t < ms / 150; t++) {
                            await sleep(150);
                            if (buttons().some((b) => !before.has(b)) || classify().sig !== sig0) return true;
                        }
                        return false;
                    };
                    attach();
                    trace.push('file set on the input');
                    let reaction = await reacted(4000);
                    if (!reaction) {
                        // Some pages only listen after their own "+" is clicked: click it, with the file picker answered by the generated image.
                        trace.push('no reaction');
                        await c.send({ kind: 'photoHook', photo });
                        const control = (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || input.closest('label') || input.parentElement;
                        if (control) {
                            control.click();
                            trace.push('add control clicked');
                        }
                        reaction = await reacted(5000);
                    }
                    if (reaction) {
                        let confirm = null;
                        for (let t = 0; t < 40 && !confirm; t++) {
                            confirm = buttons().find((b) => !before.has(b));
                            if (!confirm) await sleep(150);
                        }
                        if (confirm) {
                            const after = classify().sig;
                            confirm.click();
                            trace.push('crop confirmed');
                            if (await waitChange(c, after, 6000)) return undefined;
                        } else trace.push('no confirm button');
                        // Photo in place but the screen did not move: press the step's own (enabled) advance button.
                        const next = buttons().filter((b) => before.has(b) && b.tagName === 'BUTTON' && !b.disabled && b.id !== 'signUp' && !LATER_RE.test(text(b)));
                        if (next.length === 1) {
                            const after = classify().sig;
                            next[0].click();
                            trace.push('advance clicked');
                            if (await waitChange(c, after, 8000)) return undefined;
                        }
                    } else trace.push('page did not react');
                }
            }
            let skip = null;
            try {
                skip = skipButton(c, st);
            } catch {
                skip = null;
            }
            if (skip) {
                skip.click();
                return undefined;
            }
            throw new StopRun('unknown', `Photo step stopped (${trace.join(' > ') || 'photo option off'}); no "Later" button on this site.`);
        },
        hobbies: async (c, st) => {
            const hidden = need(document.querySelector('input[type=hidden][name^=hobbies]'), 'hobbies input');
            const chips = [...hidden.parentElement.children].filter((e) => e !== hidden && shown(e) && text(e));
            if (chips.length < 3) throw new StopRun('unknown', `Hobbies screen with ${chips.length} choices: stopped.`);
            // Three random distinct hobbies (the site requires at least one and accepts up to nine).
            const order = chips.map((chip) => ({ chip, k: crypto.getRandomValues(new Uint32Array(1))[0] })).sort((a, b) => a.k - b.k).slice(0, 3);
            for (const { chip } of order) {
                chip.click();
                await sleep(250);
            }
            if (!hidden.value) throw new StopRun('unknown', 'Hobbies were clicked but the page kept none: stopped.');
            await sleep(200);
            nextButton(c, st).click();
        },
        // "I am looking for": the site preselects the default search; at least one box is required, so tick the first if none is.
        criteria: async (c, st) => {
            const boxes = st.fs.filter((e) => e.type === 'checkbox');
            if (!boxes.some((e) => e.checked)) await ensureChecked(boxes[0]);
            await sleep(300);
            nextButton(c, st).click();
        },
        // "Also register on other sites": never. Anything the site preticked is cleared, then on to the next screen.
        crossreg: async (c, st) => {
            for (const box of st.fs.filter((e) => e.type === 'checkbox' && e.checked)) {
                (shown(box) ? box : box.closest('label') || box.parentElement).click();
                await sleep(150);
            }
            await sleep(300);
            nextButton(c, st).click();
        },
        badge: (c, st) => keepDefault(c, st),
        welcome: (c, st) => keepDefault(c, st),
        phone: async (c, st) => {
            skipButton(c, st).click();
        },
        'payment-later': async (c, st) => {
            // Never pays, never types card data: the only action is the link that closes the payment page, unless the run asked to stop here.
            if (c.settings.stopAtPayment) throw new StopRun('done', STOP_AT_PAYMENT);
            const link = need(slot(c, st, 'close', () => [...document.querySelectorAll('a[href*="/payment/later"]')].find((e) => shown(e))), 'close payment page link');
            link.click();
        },
        payment: async (c) => {
            if (c.settings.stopAtPayment) throw new StopRun('done', STOP_AT_PAYMENT);
            throw new StopRun('unknown', 'Payment page without a "close the payment page" link: stopped, nothing is paid or typed');
        },
        password: async (c, st) => {
            const field = need(st.fs.find((e) => e.type === 'password'), 'password input');
            const noPassword = 'Password screen reached, nothing typed: no test password is saved. Add it with Settings, then run again.';
            if (!c.settings.fillPassword) throw doneRun(c, c.hasPassword ? 'Password screen reached (you chose not to type the password).' : noPassword);
            const password = await c.getPassword();
            if (!password) throw doneRun(c, noPassword);
            // Set without focusing the field: focusing it makes a password-manager extension overlay the tab.
            setValue(field, password);
            if (field.value !== password) throw new StopRun('error', 'The password field did not keep the value');
            const form = field.closest('form');
            const save = slot(c, st, 'next', () => {
                const own = form && [...form.querySelectorAll('button[type=submit],input[type=submit]')].filter(shown);
                if (own && own.length === 1) return own[0];
                // A button with a label: the "show password" eye is an icon without text and must never be taken for the save button.
                const labelled = buttons().filter((e) => e.tagName === 'BUTTON' && e.id !== 'signUp' && text(e));
                return labelled.length === 1 ? labelled[0] : nearestButton(field);
            });
            if (!save) throw doneRun(c, 'Password typed; click the save button yourself (not recognised).');
            c.send({ kind: 'step', fp: st.fp, type: st.type, route: routeKey(), note: 'password typed (hidden)' });
            // The page validates the password after typing: the button only becomes active a moment later.
            for (let t = 0; t < 20 && (save.disabled || save.getAttribute('aria-disabled') === 'true'); t++) await sleep(150);
            if (save.disabled) throw new StopRun('error', 'The save button stayed disabled: the page did not accept the password.');
            await sleep(300);
            const gone = async (ms) => {
                for (let t = 0; t < ms / 200; t++) {
                    await sleep(200);
                    if (!fields().some((e) => e.type === 'password')) return true;
                }
                return false;
            };
            save.click();
            if (!(await gone(8000))) {
                // Still there: one more click, then report honestly instead of announcing a save that did not happen.
                save.click();
                if (!(await gone(8000))) throw new StopRun('stuck', 'Save was clicked but the password screen did not change: check the account by hand.');
            }
            throw doneRun(c, 'Password saved: the test account is ready.');
        },
    };

    // ---- Main loop ------------------------------------------------------------------------------------------------------
    // Waits for the page to settle on a recognised step (redirects, spinners), up to 12 s, and for it to stay stable.
    // Waits for a recognised screen that stays the same for a moment. The DOM being built is enough (not the end of the load, which waits
    // for every image, font and tracker): the screen is usable long before. Up to about 12 s for an unknown screen.
    const settle = async (c) => {
        let st = classify();
        let sameUnknown = 0;
        for (let t = 0; t < 100 && !c.cancelled; t++) {
            await sleep(120);
            if (document.readyState !== 'loading' && st.type !== 'unknown') {
                await sleep(130);
                const again = classify();
                if (again.sig === st.sig) return st;
                st = again;
            } else {
                const again = classify();
                // An unknown screen that has not changed for about 2.5 s is what it is (a quiz step, an entry page): no need to wait 12 s.
                sameUnknown = again.type === 'unknown' && again.sig === st.sig && document.readyState !== 'loading' ? sameUnknown + 1 : 0;
                st = again;
                if (sameUnknown >= 20) return st;
            }
        }
        return st;
    };
    const waitChange = async (c, sig, ms = 7000) => {
        for (let t = 0; t < ms / 150 && !c.cancelled; t++) {
            await sleep(150);
            // The site refused the registration (its own answer): stop with its reason instead of waiting for a screen that never comes.
            if (c.promoRefused) throw new StopRun('error', `The site refused the sign-up: ${c.promoRefused}`);
            if (classify().sig !== sig) return true;
        }
        return false;
    };

    // First use: the domain and password are asked here, in the bar, then the run goes on. Nothing is hard-coded or sent anywhere but the extension.
    const askSetup = (c) =>
        new Promise((resolve) => {
            const finish = () => {
                c.reshow = null;
                resolve();
            };
            const show = () =>
                island.form(c, {
                    state: 'setup',
                    title: 'First-time setup',
                    intro: 'Test accounts use test-<date>-<time>-<random>@your-domain. Set once, shared by every site. Stored in this browser only.',
                    fields: [
                        { key: 'emailDomain', label: 'E-mail domain of your test mailbox', placeholder: 'mailbox.example.com' },
                        { key: 'password', label: 'Test password (optional)', secret: true, hint: 'Typed only on the Password step, when you asked for it.' },
                    ],
                    submit: 'Save and start',
                    onCancel: () => {
                        c.cancelled = true;
                        c.send({ kind: 'finish', status: 'stopped', message: 'Setup cancelled.' });
                        finish();
                        island.render(c, { state: 'stopped', message: 'Setup cancelled.' });
                    },
                    onSubmit: async (values) => {
                        const result = await c.send({ kind: 'saveSettings', emailDomain: values.emailDomain, password: values.password });
                        if (!result || !result.ok) return (result && result.error) || 'Could not save the settings.';
                        c.hasPassword = result.hasPassword;
                        c.needsSetup = false;
                        finish();
                        return null;
                    },
                });
            c.reshow = show;
            show();
        });
    // ---- Saved accounts -----------------------------------------------------------------------------------------------
    // The member's session lives in the page storage: dating_rt / dating_token on the member area, prophecy_rt (and the ?rt= of the
    // address) during the registration. The refresh token only travels to the service worker, which keeps it; nothing here logs it.
    // During a sign-up the registration token is the new account's (an older member session can still sit in the storage); on a page
    // that was already signed in, the member token is the right one (a registration token can be a leftover).
    const readSession = (source) => {
        try {
            const member = localStorage.getItem('dating_rt');
            const signup = new URLSearchParams(location.search).get('rt') || new URLSearchParams(location.hash.split('?')[1] || '').get('rt') || localStorage.getItem('prophecy_rt');
            const rt = (source === 'created' ? signup || member : member || signup) || '';
            const access = localStorage.getItem('dating_token') || '';
            return rt || access ? { rt, access } : null;
        } catch {
            return null;
        }
    };
    const jwtUserId = (jwt) => {
        try {
            const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            return Number(JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))).userId) || 0;
        } catch {
            return 0;
        }
    };
    // The site's gateway wants the operation name in the address and the Apollo client headers (as the member area sends them);
    // a call without them is treated as anonymous.
    const graphql = async (operationName, query, variables = {}, headers = {}) => {
        const response = await fetch(`/supergraph?${operationName}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', 'apollographql-client-name': 'vision', 'apollographql-client-version': 'sw', ...headers },
            body: JSON.stringify({ operationName, query, variables }),
        });
        return (await response.json()).data || null;
    };
    const solid = (color) => (color && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$|transparent/.test(color) ? color : '');
    // Brand name, logo and the colour behind the logo (the member area's own background): getConfigSite by host (the member host is
    // tried, then the landing host), falling back to the logo shown on the page itself.
    const readBrand = async () => {
        const host = location.hostname;
        const hosts = [host, host.replace(/^preprod-meet\./, 'www-preprod.').replace(/^meet\./, 'www.')];
        let title = '';
        let logoUrl = '';
        for (const candidate of [...new Set(hosts)]) {
            try {
                const data = await graphql('getConfigSite', 'query getConfigSite($host: String!) { siteByHost(host: $host) { publicLogoUrl title } }', { host: candidate });
                const site = data && data.siteByHost;
                if (site && (site.publicLogoUrl || site.title)) {
                    title = site.title || '';
                    logoUrl = site.publicLogoUrl || '';
                    break;
                }
            } catch {
                // not reachable or refused: try the next source
            }
        }
        const img = [...document.querySelectorAll('img[alt="Logo" i]')].find((e) => shown(e));
        if (!logoUrl && img && /^https:/.test(img.currentSrc || img.src)) logoUrl = img.currentSrc || img.src;
        // Walk up from the logo to the first opaque background: that is what the logo is designed to sit on.
        let bg = '';
        for (let node = img; node && !bg; node = node.parentElement) bg = solid(getComputedStyle(node).backgroundColor);
        if (!title) title = (document.title || '').split(/\s[-|–]\s/)[0].trim() || location.hostname;
        return { title, logoUrl, bg: img ? bg : '' };
    };
    // What the site says about the signed-in member: pseudo, e-mail, age, gender, city, creation date and profile photo.
    // Checked against the userId of the token being saved, so a leftover session of another account is never mixed in.
    const readProfile = async (access, expectedUserId) => {
        if (!access) return null;
        try {
            const data = await graphql(
                'myProfile',
                'query myProfile { user { me { userId displayName createdAt picture { __typename ... on UserPicture { sources(type: FULL, size: 96) { x1 } } ... on GeneratedPicture { sources(type: FULL, size: 96) { x1 } } } user { age gender email geoname { niceName } } } } }',
                {},
                { bearer: access }
            );
            const me = data && data.user && data.user.me;
            if (!me || (expectedUserId && me.userId !== expectedUserId)) return null;
            return {
                pseudo: me.displayName || '',
                email: (me.user && me.user.email) || '',
                age: me.user && me.user.age,
                gender: me.user && me.user.gender === 'FEMALE' ? 'woman' : me.user && me.user.gender === 'MALE' ? 'man' : '',
                city: (me.user && me.user.geoname && me.user.geoname.niceName) || '',
                createdAt: Date.parse(me.createdAt) || 0,
                avatarUrl: (me.picture && me.picture.sources && me.picture.sources.x1) || '',
            };
        } catch {
            return null;
        }
    };
    // Saves (or refreshes) the account behind the current session. source: 'created' by a run of the extension, 'captured' when the
    // extension was started on a page that was already signed in. Runs at most once per session value and page, never throws.
    const remember = async (c, source) => {
        try {
            const session = readSession(source);
            const stamp = session && (session.rt || session.access);
            if (!stamp || c.rememberedStamp === stamp || c.remembering) return null;
            c.remembering = true;
            c.brand = c.brand || (await readBrand());
            const created = source === 'created';
            const userId = jwtUserId(session.rt) || jwtUserId(session.access);
            const profile = (await readProfile(session.access, userId)) || {};
            const result = await c.send({
                kind: 'accountSave',
                source,
                rt: session.rt,
                access: session.access,
                brand: c.brand,
                // The site's own answer wins; what the run knows fills the gaps (the member area is not reachable yet right after sign-up).
                email: profile.email || (created && c.vars && c.vars.email) || '',
                pseudo: profile.pseudo || (created ? c.pseudo : ''),
                gender: profile.gender || (created && c.settings && c.settings.gender) || '',
                age: profile.age || (created && c.settings && c.settings.age) || undefined,
                city: profile.city || (created && c.settings && c.settings.city) || '',
                createdAt: profile.createdAt || undefined,
                avatarUrl: profile.avatarUrl || '',
            });
            if (result && result.ok) {
                c.rememberedStamp = stamp;
                c.accountCount = result.count;
            }
            return result && result.ok ? result : null;
        } catch {
            return null;
        } finally {
            c.remembering = false;
        }
    };
    const openAccounts = async (c) => {
        const result = (await c.send({ kind: 'accountList' })) || {};
        const list = result.accounts || [];
        c.accountCount = list.length;
        island.accounts(c, {
            list,
            onOpen: async (id) => {
                const r = await c.send({ kind: 'accountOpen', id });
                return r && r.ok ? r : { error: (r && r.error) || 'Could not open the account.' };
            },
            onLink: async (id) => {
                const r = await c.send({ kind: 'accountLink', id });
                if (!r || !r.ok) return { error: (r && r.error) || 'No login link for this account.' };
                return (await island.copy(r.link)) ? { ok: true } : { error: 'The browser refused the copy.' };
            },
            onMail: async (a) => ((await island.copy(a.email)) ? { ok: true } : { error: 'The browser refused the copy.' }),
            onRemove: async (id) => {
                await c.send({ kind: 'accountRemove', id });
                await openAccounts(c);
                return { ok: true };
            },
        });
    };

    // Asked in the bar before every account: which gender to create (and the two optional extras, remembered from last time).
    const askChoice = (c) =>
        new Promise((resolve) => {
            const prefs = c.prefs || {};
            const fields = [
                { key: 'gender', kind: 'segmented', label: 'Account to create', options: [['man', 'Man'], ['woman', 'Woman']], value: prefs.gender === 'woman' ? 'woman' : 'man' },
                { key: 'usePhoto', kind: 'checkbox', label: 'Add a generated profile photo', value: prefs.usePhoto !== false },
                { key: 'stopAtPayment', kind: 'checkbox', label: 'Stop on the payment page (otherwise it is skipped)', value: prefs.stopAtPayment === true },
            ];
            if (c.hasPassword) fields.push({ key: 'fillPassword', kind: 'checkbox', label: 'Type the test password on the Password step', value: prefs.fillPassword !== false });
            else fields.push({ key: 'password', label: 'Test password (saved once, optional)', secret: true, hint: 'Typed on the Password step of every account. Leave empty to type it yourself.' });
            const show = () =>
                island.form(c, {
                    state: 'choose',
                    title: 'New account',
                    intro: c.signedInNote ? `Host: ${location.hostname}\n${c.signedInNote}` : `Host: ${location.hostname}`,
                    fields,
                    submit: 'Start',
                    onCancel: () => {
                        c.cancelled = true;
                        c.send({ kind: 'finish', status: 'stopped', message: 'Cancelled before starting.' });
                        c.reshow = null;
                        island.render(c, { state: 'stopped', message: 'Cancelled before starting.' });
                        resolve();
                    },
                    onSubmit: async (values) => {
                        const result = await c.send({ kind: 'choose', gender: values.gender, usePhoto: values.usePhoto, fillPassword: values.fillPassword, stopAtPayment: values.stopAtPayment, password: values.password });
                        if (!result || !result.ok) return 'Could not start.';
                        c.vars = result.vars;
                        c.hasPassword = result.hasPassword;
                        Object.assign(c.settings, result.settings);
                        c.needsChoice = false;
                        c.reshow = null;
                        resolve();
                        return null;
                    },
                });
            c.reshow = show;
            show();
        });
    const openSettings = async (c) => {
        const current = (await c.send({ kind: 'settings' })) || {};
        island.form(c, {
            state: 'settings',
            tab: 'settings',
            title: 'Settings',
            intro: 'Set once for every site. Change them only when needed.',
            fields: [
                { key: 'emailDomain', label: 'E-mail domain', value: current.emailDomain },
                { key: 'password', label: 'Test password', secret: true, placeholder: current.hasPassword ? 'Saved (leave empty to keep it)' : 'Not set' },
            ],
            onToggleMediaBlur: async () => {
                const result = await c.send({ kind: 'toggleMediaBlur' });
                return result ? result.error : 'Could not toggle media blur.';
            },
            submit: 'Save',
            onCancel: () => c.showRun(),
            onSubmit: async (values) => {
                const result = await c.send({ kind: 'saveSettings', ...values });
                if (!result || !result.ok) return (result && result.error) || 'Could not save the settings.';
                c.hasPassword = result.hasPassword;
                c.showRun();
                return null;
            },
        });
    };

    // A screen nothing recognises but that has buttons (an entry page, a quiz question): ask which button continues the sign-up, click it,
    // remember it for this screen (by its heading) so the next run needs no help. Returns when the page moved on.
    // The affirmative button of a yes/no screen: its label (first line, without a percentage) or its classes, id and data attributes.
    const YES_RE = /^(yes|oui|ja|sí|si|sì|sim|da|tak|evet|ja,? ich|yes,? i am|oui,? je)\b/i;
    const isYesControl = (e) => {
        const label = text(e).split('\n')[0].replace(/[%\d\s]+$/g, '').trim();
        const attrs = `${e.id} ${String(e.className || '')} ${e.getAttribute('data-answer') || ''} ${e.getAttribute('value') || ''}`;
        return YES_RE.test(label) || /(^|[-_\s])(yes|oui)($|[-_\s])/i.test(attrs);
    };
    const REFUSAL_RE = /^(no|non|nein|nee|não|nao|nope|no,? thanks?|non merci|no thanks|cancel|annuler|close|fermer|skip|passer|later|plus tard|refuse|decline|dismiss|back|retour|return|menu|previous|pr[ée]c[ée]dent|zur[üu]ck)\b/i;
    const FORWARD_RE = /sign[-_ ]?up|regist|inscri|create|cr[ée]er|join|rejoindre|start|commenc|d[ée]marr|discuss|chat|next|suivant|continu|search|rechercher|find|trouver|discover|d[ée]couvr|view|voir|enter|entrer|go\b|ok\b|accept|agree/i;
    const isRefusalControl = (e) => REFUSAL_RE.test(text(e).split('\n')[0].trim()) || /(^|[-_\s])(no|non|cancel|close|skip|back|return)($|[-_\s])|btn-?no(confirm)?\b/i.test(`${e.id} ${String(e.className || '')}`);
    const NEXT_RE = /^(next|suivant|weiter|siguiente|avanti|pr[óo]ximo|volgende|continue|continuer|continuar|ok)\b/i;
    const forwardScore = (e) => (NEXT_RE.test(text(e).split('\n')[0].trim()) ? 200 : 0) + (isYesControl(e) ? 100 : 0) + (FORWARD_RE.test(`${text(e)} ${e.id} ${String(e.className || '')}`) ? 10 : 0) + (e.type === 'submit' ? 3 : 0) + (e.closest('form') ? 1 : 0);
    const tapCandidates = () => buttons().filter((e) => e.tagName !== 'A' && text(e) && !isLoginControl(e) && !e.closest('footer,header,nav'));
    const unknownTap = async (c, st, stop, settingsButton) => {
        c.taps = c.taps || {};
        c.taps[st.fp] = (c.taps[st.fp] || 0) + 1;
        if (c.taps[st.fp] > 4) throw new StopRun('stuck', 'This screen did not move on after several clicks.', describeUnknown(st));
        const learned = c.learned[st.fp] && c.learned[st.fp].slots && c.learned[st.fp].slots.tap;
        let target = learned ? resolve(learned) : null;
        if (target && isLoginControl(target)) target = null; // never click a log-in control, even if it was remembered
        if (!target) {
            const options = tapCandidates();
            if (!options.length) return false;
            // Never ask: a yes/no question is answered yes; otherwise the most plausible way forward is taken (a "yes", then a sign-up or
            // next-like button, then the first button that is not a refusal). Only when nothing but refusals is left does the bar ask.
            const forward = options.filter((e) => !isRefusalControl(e));
            const ranked = [...forward].sort((a, b) => forwardScore(b) - forwardScore(a));
            const index = ranked.length ? options.indexOf(ranked[0]) : await new Promise((resolve) => {
                c.choiceResolve = resolve;
                island.render(c, {
                    state: 'unknown',
                    step: c.lastStep,
                    stop,
                    onSettings: settingsButton,
                    message: 'Unrecognised screen. Click the button that continues the SIGN-UP (log-in buttons are not offered): the choice is remembered for this screen.',
                    choices: options.map((e) => text(e).slice(0, 28)),
                    onChoose: (i) => resolve(i),
                });
            });
            c.choiceResolve = null;
            if (c.cancelled || index < 0) return true;
            target = options[index];
            const selector = selectorFor(target);
            if (selector) {
                c.send({ kind: 'learn', fp: st.fp, type: 'unknown', slots: { tap: selector } });
                c.learned[st.fp] = { ...(c.learned[st.fp] || {}), type: 'unknown', slots: { tap: selector } };
            }
        }
        island.render(c, { state: 'running', step: undefined, stop, onSettings: settingsButton });
        target.click();
        await waitChange(c, st.sig, 8000);
        return true;
    };

    const run = async (c) => {
        const stop = () => {
            c.cancelled = true;
            if (c.choiceResolve) c.choiceResolve(-1);
            c.send({ kind: 'finish', status: 'stopped', message: 'Stopped by the user.' });
            island.render(c, { state: 'stopped', message: 'Stopped by the user.', step: c.lastStep });
        };
        c.learned = c.learned || {};
        c.maxSteps = 40;
        // After a page load the island comes back where the run was: the steps already seen are carried by the service worker.
        c.lastStep = (c.history || []).slice(-1)[0];
        const settingsButton = () => openSettings(c);
        c.openSettings = settingsButton;
        c.stopRun = stop;
        c.history = c.history || [];
        // The registration call, as the page-side observer reports it: what the site accepted is what counts as validated, whoever
        // filled the form (this extension or a person typing in it).
        c.onPromo = (m) => {
            const r = m.request || {};
            if (!m.ok) {
                c.promoRefused = (m.errors || []).join('; ') || 'no reason given';
                return;
            }
            const types = ['onepage', r.gender && 'gender', r.birth_date && 'age', r.email && 'email', r.login && 'username'].filter(Boolean);
            c.history.push(...types);
            if (r.login) c.pseudo = r.login;
            if (r.email) c.vars = { ...c.vars, email: r.email };
            c.send({ kind: 'covered', types, pseudo: r.login, email: r.email });
            if (c.lastView) island.render(c, c.lastView);
        };
        // Back to the sign-up tab: the form being filled, or the last view of the run.
        c.showRun = () => (c.reshow ? c.reshow() : island.render(c, c.lastView || { state: 'running', step: undefined, stop, onSettings: settingsButton }));
        island.setOnTab((name) => {
            if (name === c.tab) return;
            if (name === 'accounts') openAccounts(c);
            else if (name === 'settings') openSettings(c);
            else c.showRun();
        });
        c.accountCount = (((await c.send({ kind: 'accountList' })) || {}).accounts || []).length;
        // No step is being handled yet on a fresh page: the one seen before is finished, so nothing spins until the new screen is recognised.
        if (!c.needsSetup && !c.needsChoice) island.render(c, { state: 'running', step: undefined, stop, onSettings: settingsButton });
        try {
            if (c.needsSetup) await askSetup(c);
            if (c.needsChoice && !c.cancelled) {
                // Started on a page that is already signed in: keep that account in the list before anything else happens.
                const saved = await remember(c, 'captured');
                if (saved) c.signedInNote = saved.isNew ? 'Signed in here: this account was saved to your list.' : 'Signed in here: this account is in your list (refreshed).';
                await askChoice(c);
            }
            if (c.cancelled) return;
            for (let guard = 0; guard < c.maxSteps; guard++) {
                if (c.cancelled) return;
                const st = await settle(c);
                if (c.cancelled) return;
                remember(c, 'created'); // once the account exists (after the pseudo step) the session is there: save it, not awaited
                if (st.type === 'unknown') {
                    if (await unknownTap(c, st, stop, settingsButton)) continue;
                    throw new StopRun('unknown', 'Unrecognised screen: nothing was guessed.', describeUnknown(st));
                }
                const { count } = (await c.send({ kind: 'step', fp: st.fp, type: st.type, route: routeKey() })) || { count: 1 };
                if (count > 3) {
                    c.send({ kind: 'unlearn', fp: st.fp });
                    throw new StopRun('stuck', `The step "${st.type}" did not move forward after 3 attempts.`, describeUnknown(st));
                }
                c.lastStep = st.type;
                c.history.push(st.type);
                island.render(c, { state: 'running', step: st.type, stop, onSettings: settingsButton });
                const outcome = await handlers[st.type](c, st);
                if (outcome === 'retry') continue;
                const creates = st.type === 'username' || st.type === 'onepage';
                let changed = await waitChange(c, st.sig, creates ? 30000 : 10000);
                if (changed && c.pendingCover) {
                    c.history.push(...c.pendingCover);
                    c.pendingCover = null;
                }
                // The screen moved on: the step just handled is validated, and nothing spins until the next one is recognised.
                if (changed) island.render(c, { state: 'running', step: undefined, stop, onSettings: settingsButton });
                // The pseudo step creates the account, then the site redirects to another host, which can take a while (slow on prod).
                // Never click NEXT again meanwhile: wait for the answer, and only retry when the page shows an error of its own.
                // If the redirect completes, this page is replaced and the service worker resumes the run on the new one.
                if (!changed && creates) {
                    const started = Date.now();
                    while (!changed && !c.cancelled && !pageMessages().length && Date.now() - started < 240000) {
                        island.render(c, { state: 'running', step: st.type, stop, onSettings: settingsButton, message: 'Account submitted, waiting for the site to answer…' });
                        changed = await waitChange(c, st.sig, 3000);
                    }
                }
            }
            throw new StopRun('error', 'Too many steps: stopped.');
        } catch (err) {
            if (c.cancelled) return;
            if (!(err instanceof StopRun)) err = new StopRun('error', `Unexpected error: ${err && err.message}`);
            await Promise.race([remember(c, 'created'), sleep(4000)]); // the account may only just exist: keep it whatever the outcome
            c.send({ kind: 'finish', status: err.status, message: err.message, unknown: err.extra });
            island.render(c, { state: err.status, message: err.message, extra: err.extra, step: c.lastStep, onSettings: settingsButton });
        }
    };

    globalThis.__qs = { BUILD, run, classify, handlers, unknownTap, ctaButton, genPseudo, BANNED_RE, resolve, selectorFor, nearestButton, island };
})();
