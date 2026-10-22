/**
 * The Quartier général: the menu's hub, over the title scene (Belle Époque).
 * One screen, four layouts by CSS (qg.css): desktop and tablets (rail on the
 * left, cards on the right), short landscape phones (the same, compact),
 * portrait phones (tab bar at the bottom, the action under the thumb) and the
 * unfolded iPhone Duo (~890 × 626 pt: the desktop layout, nothing on the fold).
 *
 * The hub only picks and launches: what a match is made of (map, difficulty,
 * mutators, random maps…) stays in the menu column under it, which becomes the
 * « salon » (`menu.dataset.view = "salon"`). Its state is main.ts's: the hub
 * reads it through `state()` and acts through the hooks.
 */
import { sfx } from "../game/audio";
import { currentStreak, loadCareer, rankOf } from "../game/career";
import { dailyOp, today, type DailyOp } from "../game/daily";
import { DIFFICULTY, STRATEGIES } from "../sim/ai/commander";
import { MEDAL_IDS } from "../sim/awards";
import { mapById } from "../sim/maps";
import { mapAssetBase } from "../game/assets";
import type { NationOrClassic } from "../sim/types";
import { insigniaSvg } from "./career";
import { UNITS } from "../sim/balance";
import { NATION_CARDS, crestImg, nationIcon } from "./nations-ui";

/** What the hub's big button launches. */
export type HubPick = "skirmish" | "ops" | "survival" | "duel";

export interface HubState {
  pick: HubPick;
  /** The map Play would start (skirmish, survival) or the op's. */
  map: { name: string; thumb: string };
  difficulty: string;
  nation: NationOrClassic;
  op: { title: string; n: number; total: number; done: number; campaign: boolean; locked: boolean };
  survivalBest: number | null;
  duel: { sound: boolean; online: boolean };
  tutoDone: boolean;
  // ---- the order of battle (large screens: set the match up without leaving the hub)
  maps: { id: string; name: string; thumb: string; on: boolean; badge: string }[];
  diffs: { id: string; label: string; on: boolean }[];
  /** The AI's nation (skirmish with a nation; null otherwise). */
  rivals: { id: string; label: string; on: boolean }[] | null;
  /** Mutators on, in a few words ("" = none). */
  mutators: string;
  /** A few missions around the picked one, its tagline and chapter still. */
  missions: { id: string; n: number; title: string; stars: number; locked: boolean; on: boolean }[];
  opLine: string;
  opArt: string | null;
}

export interface HubHooks {
  state(): HubState;
  pick(p: HubPick): void;
  /** The big button. */
  go(): void;
  /** Open the salon on the current pick. */
  salon(): void;
  nation(n: NationOrClassic): void;
  duel(online: boolean): void;
  daily(op: DailyOp): void;
  career(): void;
  tuto(): void;
  replays(): void;
  settings(): void;
  map(id: string): void;
  difficulty(id: string): void;
  rival(id: string): void;
  mutators(): void;
  /** Pick a mission (the picked one again: its briefing). */
  op(id: string): void;
}

export interface Hub {
  sync(): void;
}

const NATION_ORDER: NationOrClassic[] = ["republique", "empire", "classique"];
const NATION_LINE: Record<NationOrClassic, { title: string; line: string }> = {
  republique: { title: NATION_CARDS.republique.title, line: "rapide · aérienne · électrique" },
  empire: { title: NATION_CARDS.empire.title, line: "lente · blindée · artillerie" },
  classique: { title: "Classique", line: "les mêmes unités des deux côtés" }
};

const PICKS: { p: HubPick; icon: string; label: string; tab: string }[] = [
  { p: "ops", icon: "📜", label: "Campagne", tab: "Campagne" },
  { p: "skirmish", icon: "⚔️", label: "Escarmouche", tab: "Bataille" },
  { p: "survival", icon: "🛡️", label: "Survie", tab: "Survie" },
  { p: "duel", icon: "🌐", label: "Duel", tab: "Duel" }
];

export function mountHub(menu: HTMLElement, hooks: HubHooks): Hub {
  const el = document.createElement("div");
  el.className = "qg";
  const op = dailyOp(today());
  const rail = PICKS.map((x) => `<button class="qg-ri" data-p="${x.p}"><i>${x.icon}</i><b>${x.label}</b><small></small></button>`).join("");
  // (portrait: the tab bar, Bataille in the middle)
  const tabs = [PICKS[0]!, PICKS[2]!, PICKS[1]!, PICKS[3]!]
    .map((x) => `<button class="qg-tab" data-p="${x.p}"><i>${x.icon}</i>${x.tab}</button>`)
    .join("");
  el.innerHTML = `
    <div class="qg-top">
      <button class="qg-rank" id="qg-rank" title="Ta carrière"></button>
      <span class="qg-sp"></span>
      <span class="qg-chip" id="qg-medals" title="Médailles"></span>
      <span class="qg-chip" id="qg-streak" title="Série de victoires (Op du jour)"></span>
      <button class="qg-ico" id="qg-set" title="Réglages" aria-label="Réglages">⚙</button>
    </div>
    <h1 class="logo panache qg-logo">PANACHE</h1>
    <p class="qg-tag">Paris, 1900</p>
    <nav class="qg-rail">
      ${rail}
      <span class="qg-sep"></span>
      <a class="qg-ri sm" href="models.html" target="_blank" rel="noopener"><i>🔧</i><b>Arsenal</b></a>
      <button class="qg-ri sm" data-a="archives"><i>🎬</i><b>Archives</b></button>
      <button class="qg-ri sm" data-a="tuto"><i>🎓</i><b>Instruction</b></button>
    </nav>
    <div class="qg-side">
      <button class="qg-ev" data-a="daily"><i>📅</i><b>Op du jour</b><small id="qg-dl"></small><span class="qg-dot" hidden></span></button>
      <button class="qg-ev" data-a="tuto"><i>🎓</i><b>Instruction</b><small id="qg-tuto"></small></button>
      <button class="qg-ev" data-a="archives"><i>🎬</i><b>Archives</b><small>rediffusions</small></button>
      <a class="qg-ev" href="models.html" target="_blank" rel="noopener"><i>🔧</i><b>Arsenal</b><small>unités</small></a>
    </div>
    <div class="qg-nat">
      <button class="qg-arr" data-d="-1" aria-label="Nation précédente">‹</button>
      <span class="qg-crest"></span>
      <span class="qg-nt"><b></b><small></small></span>
      <button class="qg-arr" data-d="1" aria-label="Nation suivante">›</button>
    </div>
    <div class="qg-col">
      <div class="qg-daily">
        <div class="qg-k"><span>Op du jour n°${op.number}</span><span id="qg-dlk"></span></div>
        <div class="qg-row"><img src="" alt="" draggable="false" id="qg-dlimg" /><span class="qg-t"><b id="qg-dlmap"></b><small id="qg-dlvs"></small></span><button class="qg-btn" data-a="daily">Jouer</button></div>
      </div>
      <div class="qg-mode">
        <img src="" alt="" draggable="false" class="qg-th" />
        <span class="qg-t"><b></b><small></small></span>
        <button class="qg-chg">Changer</button>
        <span class="qg-duo"><button class="qg-btn alt" data-a="sound">🔊 Par le son</button><button class="qg-btn alt" data-a="online">🌐 En ligne</button></span>
      </div>
      <div class="qg-plan"></div>
      <div class="qg-natcard"></div>
      <button class="cta big qg-go" id="qg-go">En avant !</button>
    </div>
    <nav class="qg-tabs">${tabs}</nav>`;
  menu.querySelector(".menu-inner")?.before(el);
  el.querySelector<HTMLImageElement>("#qg-dlimg")!.src = `${mapAssetBase(op.mapId)}/thumb.webp`;
  el.querySelector("#qg-dlmap")!.textContent = mapById(op.mapId).name;
  el.querySelector("#qg-dlvs")!.textContent = `contre ${STRATEGIES[op.strategy].label} · ${DIFFICULTY[op.difficulty].label}`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const click = (s: string, fn: (b: HTMLElement) => void) => el.querySelectorAll<HTMLElement>(s).forEach((b) => b.addEventListener("click", () => fn(b)));

  // portrait: the nation sits just above the column, whatever its height (qg.css --colh)
  const col = el.querySelector<HTMLElement>(".qg-col")!;
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => el.style.setProperty("--colh", `${col.offsetHeight}px`)).observe(col);
  let shownNation: NationOrClassic | null = null;
  const sync = () => {
    const s = hooks.state();
    const c = loadCareer();
    const r = rankOf(c.xp);
    $("#qg-rank").innerHTML = `${insigniaSvg(r.index)}<span><b>${r.name}</b><i><u style="width:${(r.progress * 100).toFixed(1)}%"></u></i></span>`;
    $("#qg-medals").innerHTML = `🏅 <em>${Object.keys(c.medals).length}/${MEDAL_IDS.length}</em>`;
    const streak = currentStreak(c, today());
    $("#qg-streak").innerHTML = `🔥 <em>${streak}</em>`;
    // the Daily Op
    const won = c.daily.lastWin === op.day;
    $("#qg-dl").textContent = won ? "✓ gagnée" : op.label;
    el.querySelector<HTMLElement>(".qg-dot")!.hidden = won;
    $("#qg-dlk").textContent = won ? "✓ Gagnée" : op.label;
    $("#qg-tuto").textContent = s.tutoDone ? "✓ suivie" : "3 minutes";
    // the rail and the tabs
    el.querySelectorAll<HTMLElement>("[data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === s.pick));
    const sub: Record<HubPick, string> = {
      ops: s.op.campaign ? `Mission ${s.op.n} sur ${s.op.total}` : `Épreuve ${s.op.n} sur ${s.op.total}`,
      skirmish: "Toi contre l'IA",
      survival: s.survivalBest ? `Record : ${s.survivalBest} vague${s.survivalBest > 1 ? "s" : ""}` : "Tenir face aux vagues",
      duel: "Défier un ami"
    };
    el.querySelectorAll<HTMLElement>(".qg-ri[data-p]").forEach((b) => (b.querySelector("small")!.textContent = sub[b.dataset.p as HubPick]));
    // the nation (the Campaign fixes its own: the selector rests)
    const n = NATION_LINE[s.nation];
    $(".qg-crest").innerHTML = crestImg(s.nation, "qg-crimg");
    $(".qg-nt b").textContent = n.title;
    $(".qg-nt small").textContent = n.line;
    el.classList.toggle("no-nat", s.pick === "ops");
    // tall screens: what the nation plays like, in the empty middle of the column
    const card = $(".qg-natcard");
    card.hidden = s.pick === "ops" || s.pick === "duel";
    if (s.nation !== shownNation) {
      shownNation = s.nation;
      if (s.nation === "classique") card.innerHTML = `<p class="qg-k">Règles classiques</p><p class="qg-nl">Les deux camps ont les mêmes unités et les mêmes bâtiments : seule la tactique compte.</p>`;
      else {
        const c = NATION_CARDS[s.nation];
        card.innerHTML = `<p class="qg-k">${c.title}</p><p class="qg-nl">${c.line}</p>
          <ul>${c.mechanics.map((m) => `<li>${m}</li>`).join("")}</ul>
          <div class="qg-units">${c.signature.map((k) => `<span><img src="${nationIcon(k, s.nation as "republique")}" alt="" draggable="false"/><small>${UNITS[k].name.replace(/^Escouade de |^Section de /, "")}</small></span>`).join("")}</div>`;
      }
    }
    // the mode card and the big button
    const mode = $(".qg-mode");
    mode.dataset.p = s.pick;
    const t: Record<HubPick, [string, string]> = {
      skirmish: ["Escarmouche", `${s.map.name} · ${s.difficulty}`],
      survival: ["Survie", `${s.map.name} · ${s.difficulty}`],
      ops: [s.op.title, `${s.op.campaign ? "Campagne de 1900" : "Épreuves"} · ${s.op.done}/${s.op.total} ✓`],
      duel: ["Défier un ami", "par le son, ou en ligne avec un lien"]
    };
    $(".qg-mode .qg-t b").textContent = t[s.pick][0];
    $(".qg-mode .qg-t small").textContent = t[s.pick][1];
    $<HTMLImageElement>(".qg-th").src = s.map.thumb;
    $(".qg-chg").hidden = s.pick === "duel";
    $<HTMLButtonElement>('[data-a="sound"]').hidden = !s.duel.sound;
    $<HTMLButtonElement>('[data-a="online"]').hidden = !s.duel.online;
    const go = $<HTMLButtonElement>("#qg-go");
    go.textContent = s.pick === "duel" ? "Défier un ami" : s.pick === "ops" && s.op.locked ? "🔒 Verrouillée" : "En avant !";
    go.classList.toggle("locked", s.pick === "ops" && s.op.locked);
    go.hidden = s.pick === "duel" && !s.duel.online && !s.duel.sound;
    plan(s);
  };

  /** The order of battle: what the salon sets, at hand (qg.css shows it on large screens only). */
  const planEl = $(".qg-plan");
  const seg = (k: string, items: { id: string; label: string; on: boolean }[], title = "") =>
    `<div class="qg-seg" data-k="${k}">${title ? `<span>${title}</span>` : ""}${items.map((x) => `<button data-v="${x.id}" class="${x.on ? "on" : ""}">${x.label}</button>`).join("")}</div>`;
  const plan = (s: HubState) => {
    planEl.dataset.p = s.pick;
    const head = `<div class="qg-k"><span>${s.pick === "ops" ? (s.op.campaign ? "Campagne de 1900" : "Épreuves") : "Ordre de bataille"}</span><button class="qg-more">Salon complet ›</button></div>`;
    if (s.pick === "duel") planEl.innerHTML = "";
    else if (s.pick === "ops")
      planEl.innerHTML = `${head}
        ${s.opArt ? `<div class="qg-art" style="background-image:url(${s.opArt})"><b>${s.op.title}</b></div>` : ""}
        <p class="qg-oline">${s.opLine}</p>
        <div class="qg-missions">${s.missions
          .map((m) => `<button class="qg-mis${m.on ? " on" : ""}${m.locked ? " locked" : ""}" data-op="${m.id}"><i>${m.locked ? "🔒" : m.n}</i><b>${m.title}</b><small>${m.locked ? "" : "★".repeat(m.stars) + "☆".repeat(3 - m.stars)}</small></button>`)
          .join("")}</div>`;
    else
      planEl.innerHTML = `${head}
        <div class="qg-maps">${s.maps
          .map((m) => `<button class="qg-map${m.on ? " on" : ""}" data-id="${m.id}" title="${m.name}"><img src="${m.thumb}" alt="" draggable="false"/><small>${m.name}</small>${m.badge ? `<em>${m.badge}</em>` : ""}</button>`)
          .join("")}</div>
        ${seg("diff", s.diffs)}
        ${s.rivals ? seg("rival", s.rivals, "Adversaire") : ""}
        ${s.pick === "skirmish" ? `<button class="qg-mut">🧪 Mutateurs <b>${s.mutators || "Non"}</b></button>` : ""}`;
  };
  planEl.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!t) return;
    if (t.classList.contains("qg-more")) {
      sfx.play("click", 0.5);
      return hooks.salon();
    }
    if (t.classList.contains("qg-mut")) return hooks.mutators();
    if (t.dataset.op) return hooks.op(t.dataset.op);
    if (t.dataset.id) {
      sfx.play("click", 0.5);
      return hooks.map(t.dataset.id);
    }
    const k = t.closest<HTMLElement>(".qg-seg")?.dataset.k;
    if (k && t.dataset.v) {
      sfx.play("click", 0.5);
      if (k === "diff") hooks.difficulty(t.dataset.v);
      else hooks.rival(t.dataset.v);
    }
  });

  click("[data-p]", (b) => {
    sfx.play("click", 0.5);
    hooks.pick(b.dataset.p as HubPick);
  });
  click(".qg-arr", (b) => {
    sfx.play("click", 0.5);
    const s = hooks.state();
    const i = NATION_ORDER.indexOf(s.nation);
    hooks.nation(NATION_ORDER[(i + Number(b.dataset.d) + NATION_ORDER.length) % NATION_ORDER.length]!);
  });
  // a swipe across the hero changes the nation too (portrait)
  let x0: number | null = null;
  const nat = $(".qg-nat");
  nat.addEventListener("pointerdown", (e) => (x0 = e.clientX));
  nat.addEventListener("pointerup", (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40) el.querySelector<HTMLElement>(`.qg-arr[data-d="${dx < 0 ? 1 : -1}"]`)!.click();
  });
  click(".qg-chg", () => {
    sfx.play("click", 0.5);
    hooks.salon();
  });
  click("#qg-go", () => {
    const s = hooks.state();
    if (s.pick === "duel") hooks.duel(s.duel.online);
    else hooks.go();
  });
  click('[data-a="sound"]', () => hooks.duel(false));
  click('[data-a="online"]', () => hooks.duel(true));
  click('[data-a="daily"]', () => hooks.daily(op));
  click('[data-a="tuto"]', () => hooks.tuto());
  click('[data-a="archives"]', () => {
    sfx.play("click", 0.5);
    hooks.replays();
  });
  click("#qg-rank", () => hooks.career());
  click("#qg-set", () => {
    sfx.play("click", 0.5);
    hooks.settings();
  });
  sync();
  return { sync };
}
