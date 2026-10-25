// Le site de Panache (public/decouvrir/, publié à https://menufactory43.github.io/panache/decouvrir/) : les pages
// françaises et anglaises, le sitemap et le llms.txt, écrits depuis un seul gabarit pour que les deux langues ne
// divergent jamais. Les images sont dans public/decouvrir/img (WebP), le style dans public/decouvrir/site.css.
//   node tools/site.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../public/decouvrir");
const BASE = "https://menufactory43.github.io/panache/decouvrir/";
const GAME = "https://menufactory43.github.io/panache/";
const UPDATED = "2026-10-25";

const ornament = `<svg viewBox="0 0 120 120" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round"><path d="M6 114V30Q6 6 30 6h84" stroke-width="2.4"/><path d="M16 100V38q0-22 22-22h62" stroke-width="1"/><path d="M16 70c0-30 14-46 40-48M70 16c-30 0-46 14-48 40" stroke-width="1.2"/><path d="M30 30c10-10 26-6 24 6c-2 9-14 9-14 2c0-5 6-6 8-3" stroke-width="1.6"/><path d="M40 22c10-8 22-8 30-2M22 40c-8 10-8 22-2 30" stroke-width="1"/><circle cx="30" cy="30" r="2.6" fill="currentColor" stroke="none"/><circle cx="84" cy="11" r="1.6" fill="currentColor" stroke="none"/><circle cx="11" cy="84" r="1.6" fill="currentColor" stroke="none"/></g></svg>`;
const fleuron = `<svg class="fleur" viewBox="0 0 160 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4 12h52M104 12h52" stroke-width="1"/><path d="M80 4c-6 0-10 4-10 8s4 8 10 8s10-4 10-8s-4-8-10-8z" stroke-width="1.2"/><path d="M70 12c-6-8-14-8-16 0c-2 6 6 8 8 3M90 12c6-8 14-8 16 0c2 6-6 8-8 3" stroke-width="1.2"/><circle cx="80" cy="12" r="2.2" fill="currentColor" stroke="none"/></g></svg>`;
const rule = `<svg class="rule" viewBox="0 0 160 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round"><path d="M2 12h64M94 12h64" stroke-width="1"/><path d="M80 5l7 7-7 7-7-7z" stroke-width="1.2"/><circle cx="80" cy="12" r="1.8" fill="currentColor" stroke="none"/></g></svg>`;
const card = (text) =>
  `<div class="card rv"><span class="orn tl">${ornament}</span><span class="orn tr">${ornament}</span><span class="orn bl">${ornament}</span><span class="orn br">${ornament}</span>${fleuron}<p>${text}</p>${fleuron}</div>`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const T = {
  fr: {
    lang: "fr",
    dir: "",
    url: BASE,
    play: GAME,
    title: "Panache · stratégie en temps réel Belle Époque, gratuite sur mobile",
    desc: "Paris, 1900. Menez République ou Empire dans un jeu de stratégie en temps réel fait pour le téléphone : campagne, duels en ligne, classement. Gratuit, sans pub.",
    ogImage: `${GAME}og.jpg`,
    nav: { battle: "La bataille", nations: "Nations", campaign: "Campagne", duel: "Duel", play: "Jouer", other: "English", otherHref: "en/" },
    kicker: "Le Cinématographe présente",
    h1sub: "Stratégie en temps réel · Paris, 1900",
    lede: "L’Europe s’arme de vapeur, d’acier et de radium. Menez vos armées du bout du doigt, à travers une campagne en trois actes ou contre un adversaire en ligne.",
    cta: "Jouer gratuitement",
    ctaSmall: "dans le navigateur",
    store: "App Store",
    storeSmall: "bientôt",
    facts: "Gratuit · Sans publicité · Sans achat intégré · iPhone, Android et ordinateur",
    card1: "Pour la gagner, il faudra du courage…<br>et beaucoup de panache.",
    battle: {
      eyebrow: "La bataille au bout du doigt",
      h2: "Un vrai jeu de stratégie, pensé pour le téléphone",
      intro: "Pas de souris à imiter ni de boutons minuscules : tout se commande au doigt, et une partie tient dans un trajet de métro.",
      points: [
        ["Sélectionnez d’un geste", "Touchez une unité, entourez un régiment ou prenez toute l’armée d’un coup."],
        ["Tracez la route", "Dessinez le chemin de vos troupes sur la carte : elles le suivent, contournent et chargent."],
        ["Gagnez en quelques minutes", "Bâtissez, récoltez le charbon, lancez l’assaut : une escarmouche se joue en dix minutes, un Éclair en six."]
      ],
      alt: "Une bataille de Panache : des Fardiers et des pioupious autour d’un dépôt, sur une carte de bocage"
    },
    nations: {
      eyebrow: "Deux nations",
      h2: "République ou Empire ?",
      intro: "Chaque nation a ses unités, ses bâtiments et sa façon de gagner.",
      rep: ["La République", "Liberté, électricité, audace", "Rapide, aérienne et électrique : Blériot et Montgolfières, canons Branly, sapeurs-électriciens. Elle frappe vite et loin."],
      emp: ["L’Empire", "Vapeur, acier, artillerie", "Lourd et implacable : Creusot blindés, mortiers de 280, Gargantuas de fonte. Il avance lentement, mais rien ne l’arrête."],
      classique: "Ou le mode Classique : les deux camps jouent les mêmes unités, à armes égales."
    },
    campaign: {
      eyebrow: "La Campagne de 1900",
      h2: "Douze missions, racontées comme un film muet",
      intro: "Intertitres, grain de la pellicule, fanfare de cuivres : chaque mission s’ouvre et se ferme sur ses cartons, et votre arsenal grandit de l’une à l’autre.",
      acts: [
        ["Acte I", "L’Ultimatum", "Têtes de pont, caravanes de radium, côtes de granit : la guerre commence.", "chap-1-640", "Des automobiles blindées sur les quais de la Seine, sous un ciel d’orage"],
        ["Acte II", "La Guerre des cimes", "Pendant ce temps, en Carbonie… La guerre monte dans les montagnes.", "chap-carbonie-640", "Un officier de l’Empire devant ses canons, au pied d’un volcan"],
        ["Acte III", "Paris !", "Tout se joue sous la tour de M. Eiffel.", "chap-paris-640", "Un Gargantua et un dirigeable au-dessus de Paris illuminé"]
      ]
    },
    duel: {
      eyebrow: "Le duel en ligne",
      h2: "Défiez un ami, ou grimpez au classement",
      intro: "Les deux téléphones jouent la même bataille, ordre pour ordre, où que vous soyez.",
      items: [
        ["Entre amis", " : créez un salon et envoyez son code de quatre lettres, ou le lien."],
        ["Partie classée", " : un adversaire de votre niveau, une carte tirée au sort, votre cote en jeu."],
        ["Jamais d’IA déguisée", " : personne en ligne ? Le jeu vous le dit et vous propose l’IA, en partie non classée."]
      ],
      alt: "Le salon du duel en ligne : choix de la nation et bouton Partie classée"
    },
    modes: {
      eyebrow: "Et aussi",
      h2: "De quoi tenir tout l’hiver",
      list: [
        ["⚔️", "Escarmouche", "Contre l’IA, en trois difficultés et plusieurs personnalités de commandant."],
        ["⚡", "Éclair", "Une partie de six minutes, gagnée aux points."],
        ["🛡️", "Survie", "Tenez le plus longtemps possible face aux vagues."],
        ["📅", "L’Op du jour", "Une nouvelle bataille chaque jour, la même pour tout le monde."],
        ["🧪", "Mutateurs et cartes", "Ruée vers l’or, canons de verre… et des cartes générées à l’infini."],
        ["🎬", "Les Archives", "Revoyez vos batailles et leurs temps forts, au ralenti."]
      ]
    },
    gallery: {
      eyebrow: "Sur le front",
      h2: "Quelques images",
      alts: ["Assaut dans la Mer de dunes", "Combat sur la banquise", "L’accueil de Panache"]
    },
    faq: {
      h2: "Questions fréquentes",
      list: [
        ["Panache est-il vraiment gratuit ?", "Oui. Pas de publicité, pas d’achat intégré, pas d’abonnement. Le jeu entier est jouable gratuitement."],
        ["Sur quels appareils peut-on jouer ?", "Sur iPhone, Android et ordinateur, directement dans le navigateur, sans rien installer. Une app iPhone arrive sur l’App Store."],
        ["Faut-il créer un compte ?", "Non. Le jeu crée un compte anonyme tout seul pour sauvegarder votre progression dans le nuage. Vous pouvez le rattacher à « Se connecter avec Apple » pour la retrouver sur vos autres appareils."],
        ["Comment jouer contre un ami ?", "Duel → Créer un salon, puis envoyez le code de quatre lettres ou le lien. Votre ami le rejoint depuis son téléphone, où qu’il soit."],
        ["Peut-on jouer hors ligne ?", "Une fois chargé, le jeu tourne sans connexion pour la campagne, les escarmouches et la survie. Seuls les duels en ligne et le classement ont besoin d’Internet."],
        ["Quelles données sont collectées ?", "Aucune donnée personnelle : ni nom, ni e-mail. Seulement votre progression, votre cote en partie classée et des compteurs anonymes. Tout est détaillé dans la politique de confidentialité."]
      ]
    },
    finale: { h2: "En avant !", p: "Le front vous attend. Une partie suffit pour comprendre.", },
    footer: { play: "Jouer", privacy: "Confidentialité", about: "À propos", source: "Code source", lang: "English", langHref: "en/", aboutHref: "a-propos.html", note: "Un jeu de Meffysto." },
    about: {
      file: "a-propos.html",
      title: "À propos de Panache · un jeu de Meffysto",
      desc: "Qui fait Panache, pourquoi il est gratuit et sans publicité, et ce que le jeu mesure (des compteurs anonymes, rien de plus). Un jeu de stratégie de Meffysto.",
      h1: "À propos",
      crumb: "À propos",
      body: `<p>Panache est un jeu de stratégie en temps réel écrit par <strong>Meffysto</strong>, un développeur indépendant. Il est né d’une envie simple : retrouver sur un téléphone le plaisir des grands jeux de stratégie, sans souris à imiter ni partie de quarante minutes.</p>
<h2>Gratuit, vraiment</h2>
<p>Pas de publicité, pas d’achat intégré, pas d’abonnement, pas de « monnaie premium ». Le jeu entier est jouable gratuitement, et le restera.</p>
<h2>Ce que le jeu mesure</h2>
<p>Des compteurs anonymes : combien de visites et de parties, et de quels types. Aucun identifiant, aucun cookie, aucun outil d’analyse tiers. Les comptes servent seulement à la sauvegarde dans le nuage et au classement ; on les supprime depuis les Réglages. Le détail est dans la <a href="../confidentialite.html">politique de confidentialité</a>.</p>
<h2>Les images</h2>
<p>Les illustrations du jeu ont été créées avec l’aide d’outils de génération d’images, puis retouchées et assemblées pour le jeu. Les unités, la carte et toute l’interface sont dessinées en code.</p>
<h2>Le code</h2>
<p>Le code source de Panache est public, sur <a href="https://github.com/menufactory43/panache">GitHub</a>. Une remarque, un bug ? <a href="https://github.com/menufactory43/panache/issues">Ouvrez un ticket</a>.</p>`
    }
  },
  en: {
    lang: "en",
    dir: "en/",
    url: `${BASE}en/`,
    play: `${GAME}en/`,
    title: "Panache · Belle Époque real-time strategy, free on mobile",
    desc: "Paris, 1900. Lead the Republic or the Empire in a real-time strategy game made for the phone: a campaign, online duels and a ranked ladder. Free, no ads.",
    ogImage: `${GAME}og-en.jpg`,
    nav: { battle: "The battle", nations: "Nations", campaign: "Campaign", duel: "Duel", play: "Play", other: "Français", otherHref: "../" },
    kicker: "The Cinématographe presents",
    h1sub: "Real-time strategy · Paris, 1900",
    lede: "Europe arms herself with steam, steel and radium. Lead your armies with a fingertip, through a three-act campaign or against an opponent online.",
    cta: "Play for free",
    ctaSmall: "in your browser",
    store: "App Store",
    storeSmall: "coming soon",
    facts: "Free · No ads · No in-app purchases · iPhone, Android and desktop",
    card1: "To win it, you’ll need courage…<br>and a great deal of panache.",
    battle: {
      eyebrow: "Battle at your fingertip",
      h2: "A real strategy game, made for the phone",
      intro: "No mouse to fake and no tiny buttons: everything is done with a finger, and a match fits in a metro ride.",
      points: [
        ["Select with a gesture", "Tap a unit, circle a regiment or take the whole army at once."],
        ["Draw the route", "Draw your troops’ path on the map: they follow it, flank and charge."],
        ["Win in minutes", "Build, mine coal, launch the assault: a skirmish takes ten minutes, an Éclair six."]
      ],
      alt: "A Panache battle: steam wagons and infantry around a depot, on a hedgerow map"
    },
    nations: {
      eyebrow: "Two nations",
      h2: "Republic or Empire?",
      intro: "Each nation has its own units, buildings and way to win.",
      rep: ["The Republic", "Liberty, electricity, daring", "Fast, airborne and electric: Blériot planes and balloons, Branly guns, electric sappers. It strikes fast and far."],
      emp: ["The Empire", "Steam, steel, artillery", "Heavy and relentless: armoured Creusots, 280 mm mortars, cast-iron Gargantuas. It advances slowly, but nothing stops it."],
      classique: "Or Classic mode: both sides field the same units, on equal terms."
    },
    campaign: {
      eyebrow: "The 1900 Campaign",
      h2: "Twelve missions, told like a silent film",
      intro: "Intertitles, film grain, a brass fanfare: each mission opens and closes on its cards, and your arsenal grows from one to the next.",
      acts: [
        ["Act I", "The Ultimatum", "Bridgeheads, radium caravans, granite coasts: the war begins.", "chap-1-640", "Armoured cars on the banks of the Seine, under a stormy sky"],
        ["Act II", "The War of the Peaks", "Meanwhile, in Carbonia… The war climbs into the mountains.", "chap-carbonie-640", "An Empire officer in front of his guns, at the foot of a volcano"],
        ["Act III", "Paris!", "It all comes down to Mr Eiffel’s tower.", "chap-paris-640", "A Gargantua and an airship over Paris lit up at night"]
      ]
    },
    duel: {
      eyebrow: "Online duels",
      h2: "Challenge a friend, or climb the ladder",
      intro: "Both phones play the same battle, order for order, wherever you are.",
      items: [
        ["With friends", ": create a lobby and send its four-letter code, or the link."],
        ["Ranked match", ": an opponent at your level, a random map, your rating at stake."],
        ["Never a disguised AI", ": nobody online? The game tells you so and offers the AI, unranked."]
      ],
      alt: "The online duel lobby: nation choice and the Ranked match button"
    },
    modes: {
      eyebrow: "And also",
      h2: "Enough to last the winter",
      list: [
        ["⚔️", "Skirmish", "Against the AI, with three difficulties and several commander personalities."],
        ["⚡", "Éclair", "A six-minute match, won on points."],
        ["🛡️", "Last Stand", "Hold out as long as you can against the waves."],
        ["📅", "The Daily Op", "A new battle every day, the same for everyone."],
        ["🧪", "Mutators and maps", "Gold rush, glass cannons… and endless generated maps."],
        ["🎬", "The Archives", "Watch your battles and their highlights again, in slow motion."]
      ]
    },
    gallery: {
      eyebrow: "At the front",
      h2: "A few pictures",
      alts: ["An assault in the Dune Sea", "Fighting on the pack ice", "Panache’s home screen"]
    },
    faq: {
      h2: "Frequently asked questions",
      list: [
        ["Is Panache really free?", "Yes. No ads, no in-app purchases, no subscription. The whole game is free to play."],
        ["Which devices can I play on?", "iPhone, Android and desktop, right in the browser, with nothing to install. An iPhone app is coming to the App Store."],
        ["Do I need an account?", "No. The game creates an anonymous account by itself to save your progress in the cloud. You can link it to Sign in with Apple to pick it up on your other devices."],
        ["How do I play against a friend?", "Duel → Create a lobby, then send the four-letter code or the link. Your friend joins from their phone, wherever they are."],
        ["Can I play offline?", "Once loaded, the game runs without a connection for the campaign, skirmishes and Last Stand. Only online duels and the ladder need the internet."],
        ["What data is collected?", "No personal data: no name, no email. Only your progress, your ranked rating and anonymous counters. It is all detailed in the privacy policy."]
      ]
    },
    finale: { h2: "Forward!", p: "The front is waiting. One match is all it takes." },
    footer: { play: "Play", privacy: "Privacy", about: "About", source: "Source code", lang: "Français", langHref: "../", aboutHref: "about.html", note: "A game by Meffysto." },
    about: {
      file: "about.html",
      title: "About Panache · a game by Meffysto",
      desc: "Who makes Panache, why it is free with no ads, and what the game measures (anonymous counters, nothing more). A strategy game by Meffysto.",
      h1: "About",
      crumb: "About",
      body: `<p>Panache is a real-time strategy game written by <strong>Meffysto</strong>, an independent developer. It was born from a simple wish: to bring the joy of the great strategy games to the phone, without faking a mouse or playing for forty minutes.</p>
<h2>Free, really</h2>
<p>No ads, no in-app purchases, no subscription, no “premium currency”. The whole game is free to play, and will stay so.</p>
<h2>What the game measures</h2>
<p>Anonymous counters: how many visits and matches, and of what kind. No identifier, no cookie, no third-party analytics. Accounts only serve the cloud save and the ladder; you delete yours from Settings. The details are in the <a href="../../confidentialite.html#en">privacy policy</a>.</p>
<h2>The pictures</h2>
<p>The game’s illustrations were made with the help of image generation tools, then retouched and assembled for the game. The units, the map and the whole interface are drawn in code.</p>
<h2>The code</h2>
<p>Panache’s source code is public, on <a href="https://github.com/menufactory43/panache">GitHub</a>. A remark, a bug? <a href="https://github.com/menufactory43/panache/issues">Open an issue</a>.</p>`
    }
  }
};

/** The head shared by every page. */
function head(t, { title, desc, url, other, otherLang, type = "website", ld }) {
  const p = t.dir ? "../" : "";
  return `<!doctype html>
<html lang="${t.lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${url}" />
<link rel="alternate" hreflang="${t.lang}" href="${url}" />
<link rel="alternate" hreflang="${otherLang}" href="${other}" />
<link rel="alternate" hreflang="x-default" href="${t.lang === "fr" ? url : other}" />
<meta name="theme-color" content="#070a10" />
<link rel="icon" href="${p}../icons/icon-192.png" />
<link rel="apple-touch-icon" href="${p}../icons/icon-192.png" />
<meta property="og:type" content="${type}" />
<meta property="og:site_name" content="Panache" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${t.ogImage}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:locale" content="${t.lang === "fr" ? "fr_FR" : "en_US"}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="preload" href="${p}fonts/bodoni-moda-italic.woff2" as="font" type="font/woff2" crossorigin />
${type === "website" && ld.some((o) => o["@type"] === "FAQPage") ? `<link rel="preload" href="${p}img/titre-heros-480.webp" as="image" fetchpriority="high" />` : ""}
<link rel="stylesheet" href="${p}site.css" />
${ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join("\n")}
</head>`;
}

function footer(t) {
  const p = t.dir ? "../" : "";
  return `<footer>
  <div class="wrap">
    <span class="mark">Panache</span>
    <nav aria-label="${t.lang === "fr" ? "Pied de page" : "Footer"}">
      <a href="${t.play}">${t.footer.play}</a>
      <a href="${p}../confidentialite.html${t.lang === "en" ? "#en" : ""}">${t.footer.privacy}</a>
      <a href="${t.footer.aboutHref}">${t.footer.about}</a>
      <a href="https://github.com/menufactory43/panache">${t.footer.source}</a>
      <a href="${t.footer.langHref}" hreflang="${t.lang === "fr" ? "en" : "fr"}">${t.footer.lang}</a>
    </nav>
    <span>${t.footer.note}</span>
  </div>
</footer>`;
}

const REVEAL = `<script>
// (sections fade in as they come; the hero never waits)
const io = "IntersectionObserver" in window && new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll(".rv").forEach((el) => (io ? io.observe(el) : el.classList.add("in")));
</script>`;

function home(t) {
  const o = t.lang === "fr" ? T.en : T.fr;
  const p = t.dir ? "../" : "";
  const img = (n) => `${p}img/${n}.webp`;
  const shot = (n, alt, eager = false) =>
    `<img src="${img(`${n}-${t.lang}-1200`)}" srcset="${img(`${n}-${t.lang}-640`)} 640w, ${img(`${n}-${t.lang}-1200`)} 1200w" sizes="(max-width: 900px) 100vw, 640px" width="1200" height="552" alt="${esc(alt)}"${eager ? "" : ' loading="lazy"'} decoding="async" />`;
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": ["VideoGame", "SoftwareApplication"],
      name: "Panache",
      url: t.url,
      description: t.desc,
      image: t.ogImage,
      inLanguage: ["fr", "en"],
      genre: ["Real-time strategy", "Strategy"],
      applicationCategory: "GameApplication",
      operatingSystem: "Web, iOS, Android",
      gamePlatform: ["Web browser", "iPhone", "Android"],
      playMode: ["SinglePlayer", "MultiPlayer"],
      author: { "@type": "Person", name: "Meffysto" },
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      screenshot: [`${BASE}img/2-bataille-${t.lang}-1200.webp`, `${BASE}img/3-assaut-${t.lang}-1200.webp`]
    },
    { "@context": "https://schema.org", "@type": "WebSite", name: "Panache", url: t.url, inLanguage: t.lang },
    { "@context": "https://schema.org", "@type": "Organization", name: "Panache", url: BASE, logo: `${GAME}icons/icon-512.png` },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: t.faq.list.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } }))
    }
  ];
  return `${head(t, { title: t.title, desc: t.desc, url: t.url, other: o.url, otherLang: o.lang, ld })}
<body>
<header class="bar">
  <a class="mark" href="${t.url}">Panache</a>
  <nav>
    <a href="#bataille">${t.nav.battle}</a>
    <a href="#nations">${t.nav.nations}</a>
    <a href="#campagne">${t.nav.campaign}</a>
    <a href="#duel">${t.nav.duel}</a>
    <a class="lang" href="${t.nav.otherHref}" hreflang="${o.lang}">${t.nav.other}</a>
  </nav>
</header>
<main>
<section class="hero" style="padding:0">
  <img class="hero-fond" src="${img("titre-fond-1536")}" srcset="${img("titre-fond-800")} 800w, ${img("titre-fond-1536")} 1536w" sizes="100vw" width="1536" height="1024" alt="" />
  <img class="hero-zep" src="${img("titre-dirigeable-360")}" width="360" height="149" alt="" />
  <img class="hero-garg" src="${img("titre-gargantua-360")}" width="360" height="551" alt="" loading="lazy" />
  <img class="hero-heros" src="${img("titre-heros-480")}" width="480" height="720" fetchpriority="high" alt="${t.lang === "fr" ? "Un officier mécanique de la Belle Époque, sabre au clair" : "A Belle Époque clockwork officer, sabre drawn"}" />
  <div class="wrap">
    <div class="hero-txt">
      <p class="kicker">${t.kicker}</p>
      <h1><span class="logo">Panache</span><span class="h1-sub">${t.h1sub}</span></h1>
      ${rule}
      <p class="lede">${t.lede}</p>
      <div class="ctas">
        <a class="btn btn-or" href="${t.play}">▶ ${t.cta} <small>${t.ctaSmall}</small></a>
        <span class="btn btn-alt" aria-disabled="true"> ${t.store} <small>${t.storeSmall}</small></span>
      </div>
      <p class="facts">${t.facts}</p>
    </div>
  </div>
</section>

<section style="padding-top:40px">
  <div class="wrap">${card(t.card1)}</div>
</section>

<section id="bataille">
  <div class="wrap">
    <div class="sec-head rv"><p class="eyebrow">${t.battle.eyebrow}</p><h2>${t.battle.h2}</h2><p>${t.battle.intro}</p></div>
    <div class="split">
      <div class="frame rv">${shot("2-bataille", t.battle.alt)}</div>
      <ol class="points rv">
        ${t.battle.points.map(([h, d], i) => `<li><span class="n">${["I", "II", "III"][i]}</span><div><h3>${h}</h3><p>${d}</p></div></li>`).join("\n        ")}
      </ol>
    </div>
  </div>
</section>

<section id="nations">
  <div class="wrap">
    <div class="sec-head rv"><p class="eyebrow">${t.nations.eyebrow}</p><h2>${t.nations.h2}</h2><p>${t.nations.intro}</p></div>
    <div class="nations">
      <article class="nation rep rv"><img src="${img("crest-republique-220")}" width="220" height="220" alt="${t.lang === "fr" ? "Blason de la République" : "The Republic’s crest"}" loading="lazy" /><div><h3>${t.nations.rep[0]}</h3><p class="motto">${t.nations.rep[1]}</p><p>${t.nations.rep[2]}</p></div></article>
      <article class="nation emp rv"><img src="${img("crest-empire-220")}" width="220" height="220" alt="${t.lang === "fr" ? "Blason de l’Empire" : "The Empire’s crest"}" loading="lazy" /><div><h3>${t.nations.emp[0]}</h3><p class="motto">${t.nations.emp[1]}</p><p>${t.nations.emp[2]}</p></div></article>
    </div>
    <p class="classique rv">${t.nations.classique}</p>
  </div>
</section>

<section id="campagne">
  <div class="wrap">
    <div class="sec-head rv"><p class="eyebrow">${t.campaign.eyebrow}</p><h2>${t.campaign.h2}</h2><p>${t.campaign.intro}</p></div>
    <div class="acts">
      ${t.campaign.acts.map(([n, h, d, im, alt]) => `<article class="act rv"><img src="${img(im)}" width="640" height="427" alt="${esc(alt)}" loading="lazy" /><div><span class="num">${n}</span><h3>${h}</h3><p>${d}</p></div></article>`).join("\n      ")}
    </div>
  </div>
</section>

<section id="duel" class="duel">
  <div class="wrap">
    <div class="split">
      <div class="rv">
        <p class="eyebrow">${t.duel.eyebrow}</p>
        <h2>${t.duel.h2}</h2>
        <p>${t.duel.intro}</p>
        <ul>${t.duel.items.map(([b, r]) => `<li><b>${b}</b>${r}</li>`).join("")}</ul>
      </div>
      <div class="frame rv">${shot("5-duel", t.duel.alt)}</div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-head rv"><p class="eyebrow">${t.modes.eyebrow}</p><h2>${t.modes.h2}</h2></div>
    <div class="modes">
      ${t.modes.list.map(([ic, h, d]) => `<article class="mode rv"><span class="ic" aria-hidden="true">${ic}</span><h3>${h}</h3><p>${d}</p></article>`).join("\n      ")}
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-head rv"><p class="eyebrow">${t.gallery.eyebrow}</p><h2>${t.gallery.h2}</h2></div>
    <div class="gallery rv">
      ${["3-assaut", "4-front", "1-accueil"].map((n, i) => shot(n, t.gallery.alts[i])).join("\n      ")}
    </div>
  </div>
</section>

<section id="faq">
  <div class="wrap">
    <div class="sec-head rv"><h2>${t.faq.h2}</h2></div>
    <div class="faq">
      ${t.faq.list.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("\n      ")}
    </div>
  </div>
</section>

<section class="finale" style="--finale:url(${img("intro-marche-1280")})">
  <div class="wrap rv">
    <h2>${t.finale.h2}</h2>
    <p>${t.finale.p}</p>
    <div class="ctas"><a class="btn btn-or" href="${t.play}">▶ ${t.cta} <small>${t.ctaSmall}</small></a></div>
  </div>
</section>
</main>
${footer(t)}
${REVEAL}
</body>
</html>
`;
}

function about(t) {
  const o = t.lang === "fr" ? T.en : T.fr;
  const url = `${t.url}${t.about.file}`;
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: t.lang === "fr" ? "Accueil" : "Home", item: t.url },
        { "@type": "ListItem", position: 2, name: t.about.crumb, item: url }
      ]
    }
  ];
  return `${head(t, { title: t.about.title, desc: t.about.desc, url, other: `${o.url}${o.about.file}`, otherLang: o.lang, ld })}
<body>
<header class="bar">
  <a class="mark" href="${t.url}">Panache</a>
  <nav><a href="${t.play}">${t.nav.play}</a><a class="lang" href="${t.lang === "fr" ? "en/about.html" : "../a-propos.html"}" hreflang="${o.lang}">${t.nav.other}</a></nav>
</header>
<main class="page">
  <h1>${t.about.h1}</h1>
  ${t.about.body}
  <p style="margin-top:40px"><a class="btn btn-or" href="${t.play}">▶ ${t.cta}</a></p>
</main>
${footer(t)}
</body>
</html>
`;
}

for (const t of Object.values(T)) {
  const dir = join(ROOT, t.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), home(t));
  writeFileSync(join(dir, t.about.file), about(t));
}

// the sitemap: the site's pages, the privacy policy and the game itself (fr and en)
const pages = [
  [BASE, `${BASE}en/`],
  [`${BASE}a-propos.html`, `${BASE}en/about.html`]
];
const alt = (fr, en) => `<xhtml:link rel="alternate" hreflang="fr" href="${fr}"/><xhtml:link rel="alternate" hreflang="en" href="${en}"/><xhtml:link rel="alternate" hreflang="x-default" href="${fr}"/>`;
writeFileSync(
  join(ROOT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${pages.flatMap(([fr, en]) => [fr, en].map((u) => `  <url><loc>${u}</loc><lastmod>${UPDATED}</lastmod>${alt(fr, en)}</url>`)).join("\n")}
  <url><loc>${GAME}confidentialite.html</loc><lastmod>${UPDATED}</lastmod></url>
</urlset>
`
);
writeFileSync(
  join(ROOT, "llms.txt"),
  `# Panache

> Panache is a free real-time strategy game set in a Belle Époque Paris of 1900 (steam, steel and radium), made for the phone and playable in any browser. French and English.

- Play: ${GAME} (English: ${GAME}en/)
- Site: ${BASE} (English: ${BASE}en/)
- Privacy: ${GAME}confidentialite.html
- Source code: https://github.com/menufactory43/panache

## What it is
- Real-time strategy controlled with touch gestures: select with a gesture, draw your troops' route with a finger; a skirmish lasts about ten minutes.
- Two nations: the Republic (fast, airborne, electric) and the Empire (steam, steel, artillery), plus a Classic mode where both sides field the same units.
- The 1900 Campaign: twelve missions in three acts, told like a silent film.
- Online duels with a friend (four-letter lobby code or link) and ranked matches with an Elo ladder; if nobody is online, the game offers an unranked match against the AI and says so.
- Skirmish against the AI (three difficulties), Éclair (six-minute matches on points), Last Stand (survival), a Daily Op, mutators, generated maps, and replays of past battles.
- Free: no ads, no in-app purchases, no subscription. No personal data collected; an anonymous account holds the cloud save. An iPhone app is coming to the App Store.

Made by Meffysto.
`
);
console.log("site écrit dans public/decouvrir/");
