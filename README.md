# Quick Signup (extension Chrome de test)

Inscription de test en un clic sur les sites du réseau candyshop (preprod en premier, prod possible) : l'extension reconnaît chaque étape du formulaire par les attributs des champs (donc quelle que soit la langue), la remplit, enchaîne jusqu'à l'écran **Password** de la zone membre, et s'arrête proprement si un écran n'est pas reconnu. **Elle ne paie jamais** et ne saisit jamais de carte.

## Installation

Page d'installation : **https://arthur-monnet.github.io/quick-signup-extension/**

1. Dans le Terminal :
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Arthur-MONNET/quick-signup-extension/stable/install.sh | bash
   ```
   L'extension est installée dans `~/QuickSignup` (avec git s'il est présent, sinon par archive), avec une tâche quotidienne (launchd, 10 h et à chaque ouverture de session) qui la met à jour.
2. Dans le navigateur, une seule fois : `chrome://extensions` → **Developer mode** → **Load unpacked** → dossier `QuickSignup`.

**Mises à jour** : rien à faire. `scripts/update.sh` récupère la branche `stable` ; l'extension voit la nouvelle version sur le disque (son `manifest.json`, vérifié toutes les 5 minutes) et se recharge seule, avec une pastille verte « ✓ Quick Signup updated to vX » sur la page ouverte, jamais pendant une inscription (au plus tard au clic suivant sur l'icône, qui reprend ensuite normalement). Journal : `~/Library/Logs/QuickSignup.log`. Désinstaller : `bash ~/QuickSignup/scripts/uninstall.sh`.

**Publier une version** (développeur) : monter `version` dans `manifest.json` (et `BUILD` dans `background.js` / `engine.js` si les deux changent), pousser sur `main`, puis `git push origin main:stable`. Seule la branche `stable` est diffusée ; la page d'installation est servie depuis `docs/` sur `main`.

## Premier réglage (dans la barre, au premier lancement)

Rien n'est à régler avant : après l'installation, allez sur le site, cliquez sur **Inscription rapide** (ou `Alt+Shift+S`). La barre en haut de la page demande une seule fois :

- le **domaine e-mail** de votre boîte de test (les comptes sont `test-<JJMM>-<HHmm>-<3 caractères aléatoires>@domaine`, par exemple `test-2411-1432-k7q@domaine`) ;
- le **mot de passe de test** (facultatif, saisi uniquement à l'étape Password et seulement si la case de la barre est cochée).

Puis l'inscription démarre. Ce réglage se fait **une seule fois** et vaut pour tous les sites (candyshop, rencontre-ronde, Spiice…) : il est stocké une fois pour tout le navigateur, pas par site. Seuls les parcours mémorisés sont rangés par site. Ces deux valeurs restent fixes ensuite : seul le bouton **Settings** de la barre (disponible aussi une fois le parcours terminé) permet de les changer. **Âge et ville sont tirés au hasard à chaque compte** (24 à 46 ans, 15 grandes villes françaises) et le **genre est demandé avant chaque création**. Il n'y a **pas de page Options** : tout se règle dans l'onglet Settings de la barre, et l'extension fonctionne sur tous les sites. Tout est stocké dans `chrome.storage.local` de votre profil (en clair pour le mot de passe : n'utilisez qu'un mot de passe de test), jamais dans le code ni dans git.

## Utilisation

- **Compte déjà connecté** : si l'extension est lancée sur une page où un membre est connecté, l'onglet Sign-up devient « Signed in » (thème vert, comme une inscription réussie). Il montre le compte (enregistré dans la liste), « Copy e-mail », « Copy login link » et **Log out**. Log out fait comme un membre : *Mon compte* (`#/private/account`), puis le bouton Déconnexion en bas de page. Le site efface sa session, revient sur sa landing, et le formulaire New account s'ouvre.
- **Formats d'e-mail** : dans *Settings*, plusieurs formats (nom + modèle à jetons : `{ddmm}`, `{hhmm}`, `{rand3}`, `{rand:N}`, `{domain}` ; sans `@`, le domaine est ajouté). Un clic sur une ligne l'ouvre en place, « + New » en crée un à partir du format par défaut, « Make default » change le défaut. Tout est enregistré immédiatement (domaine à la sortie du champ, formats dès qu'ils sont valides) ; seul le mot de passe a son bouton Save. Le format par défaut reste `test-{ddmm}-{hhmm}-{rand3}@{domain}`. Dans « New account », une pastille par format (un clic) et l'adresse qui en résulte juste dessous.
- Aller sur le site (ex. `https://www-preprod.candyshop.com/`) et **cliquer une seule fois sur l'icône** : la barre en haut de la page prend le relais (pas de popup). Raccourci : `Alt+Shift+S`. Un nouveau clic pendant un parcours ramène simplement la barre en vue ; fonctionne sur n'importe quel site, http comme https, sans liste de domaines (mode « Allow all sites », par défaut). En mode liste, une page hors liste affiche un court message et rien ne démarre ; si une redirection passe par un hôte inconnu, le parcours l'attend 15 secondes (chaîne de redirections) et ne s'arrête que si l'onglet y reste : cliquez alors sur l'icône pour l'autoriser et reprendre.
- **Avant chaque compte**, la barre en haut de la page demande **le type de compte à créer : homme ou femme** (plus deux cases : photo générée, saisie du mot de passe à l'étape Password), puis **Start**. Les derniers choix sont préremplis. Au tout premier lancement, la configuration unique (domaine e-mail, mot de passe) passe avant ce choix.
- Une **barre fine** s'affiche en haut de la page (pastille de statut, étape en cours, progression x/10) : elle se déplie au survol ou au clic (liste des étapes, e-mail et pseudo créés, bouton Stop) et s'ouvre toute seule à la fin ou en cas de problème. Elle suit la redirection entre `www`, `meet` et `secure`.
- **Pseudo** : toujours remplacé par un pseudo aléatoire d'allure réelle (prénom du genre choisi + chiffres, par exemple `Lucas92` ou `camille_87`, jamais claude/test/bot/qa/fake/demo/tmp), relu avant validation.
- **Page de paiement** : au départ, la case *Stop on the payment page* choisit entre s'arrêter dessus (rien n'est payé ni saisi, le compte existe) ou la passer par `/payment/later` pour aller jusqu'à la zone membre. Case cochée mais aucune page de paiement sur ce parcours : le parcours va au bout et le message final le précise.
- **Formulaire en une page** (outil de formulaire *promotool*, ex. `https://www-preprod.spiice.com/d7W/ve2`) : les pages de campagne de `portals-builder` n'écrivent pas leurs formulaires, elles configurent le widget `register-form` (options `with_gender`, `birthdate: list|none`, `with_cgu`, `with_login`…). Le même formulaire peut donc avoir n'importe quel sous-ensemble de : genre (liste `MALE`/`FEMALE` ou radios), âge (liste), e-mail, pseudo (nom ou `id`), case(s) de consentement légal, sur un seul écran, parfois révélés au fur et à mesure. L'étape `Sign-up form` se déclenche dès que deux de ces champs sont ensemble, remplit ce qui est présent (plusieurs passes), attend que le bouton soit activé, puis valide. Case non juridique (newsletter…) : le parcours s'arrête.
- **Je recherche** (critères de recherche) : la présélection du site est gardée (au moins une case est exigée, la première est cochée sinon). Reconnu par la valeur des cases (`criteriaValue-…`), pas par le texte.
- **Inscription sur d'autres sites** : jamais. Reconnu par des cases dont la valeur est un lien d'inscription ; tout ce que le site a présélectionné est décoché avant de continuer.
- **Validation par l'appel d'inscription du site** : sur la page du formulaire, un observateur côté page lit l'appel `https://promo*.afcontent.net/<n>/api` (genre, e-mail, pseudo, date de naissance, réponse `result`). Ce que le site a réellement accepté valide les étapes Gender / Age / E-mail / Pseudo, que le formulaire ait été rempli par l'extension ou à la main, et le pseudo et l'e-mail affichés sont ceux du site. Si le site refuse, le parcours s'arrête avec ses raisons. Seuls quelques champs simples sortent de la page : jamais le bloc de tracking ni le lien de connexion automatique de la réponse. Repli : ce que le formulaire a rempli est validé dès que la page suivante se charge. La progression compte les étapes validées (pas une position) ; les étapes optionnelles (formulaire, critères, autres sites) n'apparaissent que si le parcours les rencontre.
- **Écran d'entrée ou quiz sans champ** (ex. boutons YES/NO, « I AM REGISTERING »…) : l'extension ne devine pas. Elle propose les boutons trouvés dans la barre (hors pied de page, en-tête et tout contrôle de **connexion** : repéré par son id, sa classe, ses attributs ou son libellé « Connection / Log in / Se connecter / Already a member… » ; un choix mémorisé qui serait un bouton de connexion est ignoré) ; votre choix est cliqué puis retenu pour cet écran (identifié par son titre) : la fois suivante, il est cliqué tout seul. Les déclencheurs d'inscription sont ceux des configs de `portals-builder` (`promoToolsConfig`) : `#signUp`, `.signUp`, `#registerBtn`/`.registerBtn`, `.js-register`. Sont toujours exclus : la connexion (`#loginBtn`, `.loginBtn`, `#mobile-login`, `#desktop-login`) et l'inscription par un tiers (`.bt-google-signup`).
- **Modale d'inscription à champs sans nom** (pages « snap ») : champs révélés un par un reconnus dès le genre ou l'âge accompagné d'une case de consentement ; le pseudo sans `name` ni `id` est le premier champ texte après l'e-mail dans le même formulaire ; le bouton cliqué est celui de ce formulaire (jamais le « Send » du chat de la page).
- **Variantes du formulaire promotool** (`with_criteria`…) : une liste obligatoire en plus du genre, de l'âge et de l'e-mail est remplie avec son premier vrai choix.
- **Hobbies** : trois centres d'intérêt tirés au hasard sont cochés, puis NEXT.
- **Message d'introduction** : le message présélectionné est gardé, puis NEXT.
- **Badge** : le badge présélectionné par le site est gardé, puis NEXT.
- **Photo** : visage généré par https://this-person-does-not-exist.com (sexe et tranche d'âge adaptés), envoyé à l'étape photo ; si le chargement échoue, l'extension clique « Later ».
- **Bulle à onglets** : *Sign-up* (déroulé, ou formulaire de départ), *Accounts* et *Settings* ; la fermeture est la croix de la rangée d'onglets (masquée pendant un parcours, où *Stop* prend le relais). L'en-tête et le trait pleine largeur suivent toujours le parcours.
- **Progression** : le trait noir pleine largeur est recouvert par un trait coloré de même épaisseur qui avance sur le rail puis contourne la bulle (raccord, côté, bas, côté, raccord) ; sa position est un pourcentage du parcours total et se recalcule image par image quand la bulle se plie, s'ouvre ou que la fenêtre change de taille. Sur téléphone : un anneau dans l'en-tête (pastille repliée) et une barre linéaire sous l'en-tête (volet ouvert).
- **Mobile / tactile** : sous 520 px de large (émulation téléphone des outils de développement, par exemple), la barre devient une petite pastille centrée qui laisse l'en-tête du site utilisable ; un tap l'ouvre en volet pleine largeur (qui défile si l'écran est court), un tap sur l'en-tête la replie. Cibles tactiles agrandies (écrans tactiles de toute taille), champs en 16 px (pas de zoom automatique sur iOS), marges de zone sûre, boutons d'action pleine largeur, comptes en cartes empilées. Sans souris, pas de survol : tout passe par le tap.
- **Comptes enregistrés** (pseudo, e-mail, âge, genre, ville, date de création et photo de profil lus via `myProfile` pour un compte déjà connecté ; le logo est affiché sur la couleur de fond derrière le logo dans la zone membre) : chaque compte créé (e-mail, pseudo, genre, âge, ville, date) est gardé dans une liste, avec le **logo de la marque** (lu via `getConfigSite` par host, sinon `<img alt="Logo">` de la page). Si l'extension est lancée sur une page **déjà connectée**, ce compte est ajouté à la liste. Bouton **Accounts** de la barre : *Open* (ouvre un nouvel onglet connecté via `https://<host>/vision/#/logingateway/?rt=<jwt>`, le même format que l'admin), *Copy link*, *Copy e-mail*, *Remove*. Le jeton est le *refresh token* du compte (`dating_rt`, ou `prophecy_rt` pendant l'inscription) ; sa validité restante est affichée. Ouvrir un compte remplace la session de ce site dans ce navigateur : relancez l'extension sur la page connectée avant, si vous voulez garder le compte courant dans la liste.
- **Étape inconnue** : l'extension s'arrête, affiche l'étape (empreinte, titre, champs, boutons) dans la barre, et ne devine rien.
- **Parcours mémorisés** : étapes et sélecteurs vus par site (clé `candyshop.com`, prod et preprod partagés) sont rejoués plus vite ; un sélecteur appris qui bloque est oublié automatiquement. Pour les oublier, effacer les données de l'extension dans les réglages du navigateur.

## Garde-fous

- Ne démarre que sur un clic de votre part. Par défaut sur tous les sites sans exception (permission `<all_urls>` dans le manifeste : le nombre de domaines du réseau est illimité) ; il n'y a ni liste d'hôtes ni page Options. La barre revient sur chaque page du parcours dès la navigation (permission `webNavigation`), pas seulement à la fin du chargement.
- Page de paiement : seul le lien « Close the payment page » (`/payment/later`) est cliqué. Jamais de saisie de carte.
- Seules les deux cases obligatoires (`accept_cguv`, `accept_privacy_policy`) sont cochées ; toute autre case arrête le parcours.
- Mot de passe, jeton, e-mail : jamais dans les logs ni dans le code. Réseau : this-person-does-not-exist.com (photo), `biz.mediascdn.net` (logo de marque) et le `/supergraph` du site visité (logo, e-mail du compte déjà connecté).
- Les jetons des comptes enregistrés restent dans `chrome.storage.local` du profil, dans le service worker : la barre n'affiche jamais un jeton, il n'apparaît que dans un lien copié ou ouvert à votre demande. Quiconque a ce lien peut se connecter au compte : ne le partagez pas. Le bouton Remove de chaque compte (onglet Accounts) le supprime avec son lien.
- Attention : preprod et prod partagent les mêmes lignes utilisateurs, traitez chaque compte créé comme une donnée de production.

## Partager

Zipper le dossier (sans `.git`) et l'envoyer : la personne le charge comme ci-dessus et renseigne ses propres réglages dans la barre. Aucun secret n'est dans le dossier.

## Fichiers

`manifest.json` (MV3) · `background.js` (service worker : état du parcours, ré-injection après redirection, mémoire) · `engine.js` (reconnaissance et remplissage des étapes, barre d'état) · `content.js` (liaison page / worker) · `shared.js` (hôtes, e-mail, photo) · `ui.css`. Pas de build.

La logique d'étapes vient du skill `~/.claude/skills/test-preprod` (`toolkit.js`, `flows.json`).

## Accès aux sites

Le manifeste demande l'accès à tous les sites (`<all_urls>`). Si la page de l'extension du navigateur affiche « Site access » sur **On click** ou **On specific sites**, choisissez **On all sites** (ou « Automatically allow access on all sites ») : sans cela, l'extension ne peut pas se réinjecter sur un domaine qu'elle n'a pas encore vu. L'extension n'agit jamais sans un clic de votre part sur l'icône (ou `Alt+Shift+S`).
