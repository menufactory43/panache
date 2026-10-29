/**
 * The Quartier général: the menu's hub, over the title scene (Belle Époque).
 * One big button and three doors (qg.css + email.css, « émail, laiton, papier »):
 *  - « En avant ! » always launches the next sensible thing, named on the paper
 *    ticket above it: the interrupted match, the Instruction, the next Campaign
 *    mission, today's Op, else a skirmish;
 *  - Campagne (the Instruction, the 1900 Campaign, the Trials), Bataille
 *    (everything against the AI: the Daily Op, skirmish, Last Stand, and what a
 *    match is made of) and Duel (online). A new player sees Bataille and Duel
 *    padlocked until the Campaign opens them (doorsOpen), one door at a time,
 *    each with its own moment;
 *  - the Cabinet holds what isn't playing: career and medals, the Archives,
 *    the Encyclopaedia (the 3D gallery) and the settings.
 *
 * The hub only picks and launches: its state is main.ts's, read through
 * `state()` and acted on through the hooks. The menu column under it stays the
 * « salon » (`menu.dataset.view = "salon"`), for the full lists.
 */
import { sfx } from "../game/audio";
import { currentStreak, loadCareer, rankOf, type CareerData } from "../game/career";
import { dailyOp, today, type DailyOp } from "../game/daily";
import { DIFFICULTY, STRATEGIES } from "../sim/ai/commander";
import { MEDAL_IDS } from "../sim/awards";
import { mapById } from "../sim/maps";
import { mapAssetBase } from "../game/assets";
import type { NationOrClassic } from "../sim/types";
import { insigniaSvg } from "./career";
import { NATION_CARDS, crestImg } from "./nations-ui";
import { tr } from "../lang";
import "./qg1900.css";

/** What the big button of the old hub launched; still the menu's mode. */
export type HubPick = "skirmish" | "ops" | "survival" | "duel";

export interface HubState {
  pick: HubPick;
  /** The map Play would start (skirmish, survival) or the op's. */
  map: { name: string; thumb: string };
  difficulty: string;
  nation: NationOrClassic;
  op: { title: string; n: number; total: number; done: number; campaign: boolean; locked: boolean };
  survivalBest: number | null;
  /** The online duel can run here (a WebSocket, or a practice link). */
  duel: boolean;
  /** Éclair (sim/modes/eclair.ts) is on for the next skirmish or duel; null where it can't be (another mode, a map that bans it). */
  eclair: boolean | null;
  tutoDone: boolean;
  /** The Instruction was offered and turned down (the big button doesn't offer it again). */
  tutoDeclined: boolean;
  /** « Deuxième jour » done too. */
  tuto2Done: boolean;
  // ---- what a match is made of (the Bataille panel)
  maps: { id: string; name: string; thumb: string; on: boolean; badge: string }[];
  diffs: { id: string; label: string; on: boolean }[];
  /** The AI's nation (skirmish with a nation; null otherwise). */
  rivals: { id: string; label: string; on: boolean }[] | null;
  /** Mutators on, in a few words ("" = none). */
  mutators: string;
  missions: { id: string; n: number; title: string; stars: number; locked: boolean; on: boolean }[];
  opLine: string;
  opArt: string | null;
  /** An interrupted match the app can pick up (game/resume.ts): its label and how far it had gone. */
  resume: { label: string; secs: number } | null;
  /** The 1900 Campaign: missions cleared, its act and still, the next mission to play (null: all cleared). */
  camp: { done: number; total: number; act: number; art: string | null; next: { id: string; n: number; title: string; map: string } | null };
  trials: { done: number; total: number };
  /** Which doors are open (doorsOpen). */
  doors: Doors;
}

export interface HubHooks {
  state(): HubState;
  pick(p: HubPick): void;
  /** Play what the menu has set up (skirmish, Last Stand, the picked op's briefing). */
  go(): void;
  /** Open the salon on the current pick. */
  salon(): void;
  nation(n: NationOrClassic): void;
  duel(): void;
  /** Éclair on or off. */
  eclair(): void;
  daily(op: DailyOp): void;
  career(): void;
  tuto(): void;
  replays(): void;
  settings(): void;
  map(id: string): void;
  difficulty(id: string): void;
  rival(id: string): void;
  mutators(): void;
  op(id: string): void;
  /** A Campaign mission's briefing (the next one when no id). */
  campaign(id?: string): void;
  /** The salon on the Campaign's or the Trials' full list. */
  book(b: "campaign" | "trials"): void;
  /** Pick the interrupted match up, or forget it. */
  resume(): void;
  dropResume(): void;
}

export interface Hub {
  sync(): void;
}

export interface Doors {
  battle: boolean;
  duel: boolean;
}

/** Campaign missions cleared that open Bataille, then Duel. */
export const DOOR_AT = { battle: 2, duel: 4 } as const;
const DOORS_KEY = "panache.portes";
const SEEN_KEY = "panache.portes.vues";

/**
 * Which doors are open. A player who already played before the doors existed
 * (skirmishes, Last Stand, Daily Ops: anything beyond the Campaign) keeps them
 * all: that is decided once, the first time this runs, and remembered.
 */
export function doorsOpen(campaignDone: number, c: CareerData): Doors {
  // (robots — the smoke test, the duel bot — find every door open)
  let all = typeof navigator !== "undefined" && navigator.webdriver === true;
  if (all) return { battle: true, duel: true };
  try {
    let v = localStorage.getItem(DOORS_KEY);
    if (v === null) {
      const veteran = c.wins + c.losses > campaignDone + 1 || c.daily.plays > 0 || c.laststand.runs > 0 || Object.keys(c.records).length > 0;
      v = veteran ? "toutes" : "graduel";
      localStorage.setItem(DOORS_KEY, v);
      // (a veteran has nothing to discover: no door moment)
      if (veteran) localStorage.setItem(SEEN_KEY, "battle,duel");
    }
    all = v === "toutes";
  } catch {
    all = true;
  }
  return { battle: all || campaignDone >= DOOR_AT.battle, duel: all || campaignDone >= DOOR_AT.duel };
}

const ICON = (k: string) => `assets/ui/belle/i-${k}.webp`;
const medal = (k: string, cls = "") => `<img class="m-medal ${cls}" src="${ICON(k)}" alt="" draggable="false"/>`;
const NATION_ORDER: NationOrClassic[] = ["republique", "empire", "classique"];
const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
const ROMAN = ["", "I", "II", "III"];

type View = "hub" | "campagne" | "bataille" | "cabinet";

export function mountHub(menu: HTMLElement, hooks: HubHooks): Hub {
  const el = document.createElement("div");
  el.className = "qg q19";
  el.dataset.v = "hub";
  const op = dailyOp(today());
  const opThumb = `${mapAssetBase(op.mapId)}/thumb.webp`;
  const opVs = `${tr("contre", "vs")} ${STRATEGIES[op.strategy].label} · ${DIFFICULTY[op.difficulty].label}`;
  const back = `<button class="q-back m-plaque thin" data-a="back">‹ ${tr("Accueil", "Home")}</button>`;
  el.innerHTML = `
    <div class="q-top">
      <button class="q-rank" id="qg-rank" title="${tr("Ta carrière", "Your career")}"></button>
      <span class="q-sp"></span>
      <button class="q-med" data-a="cabinet">${medal("cabinet")}<span class="m-tag">${tr("Cabinet", "Cabinet")}</span></button>
    </div>
    <nav class="q-doors">
      <button class="q-door m-plaque" data-door="campagne"><span class="q-vign"></span><span class="q-dt"><b>${tr("Campagne", "Campaign")}</b><small></small><i class="q-prog"><u></u></i></span></button>
      <button class="q-door m-plaque" data-door="bataille"><span class="q-vign" style="background-image:url(${opThumb})"></span><span class="q-dt"><b>${tr("Bataille", "Battle")}</b><small></small><em class="q-chip"></em></span>${medal("cadenas", "q-cad")}</button>
      <button class="q-door m-plaque" data-door="duel"><span class="q-vign q-vduel">${medal("duel")}</span><span class="q-dt"><b>Duel</b><small></small></span>${medal("cadenas", "q-cad")}</button>
    </nav>
    <div class="q-act">
      <div class="q-next m-papier"><span class="q-nh"></span><b class="q-nt"></b><small class="q-nl"></small><button class="q-drop" data-a="drop" hidden>${tr("Oublier", "Forget")}</button></div>
      <button class="cta big qg-go" id="qg-go">${tr("En avant !", "Forward!")}</button>
    </div>

    <section class="q-panel q-camp" data-for="campagne">
      ${back}<h2 class="q-h">${tr("Campagne", "Campaign")}</h2><div class="m-frise q-fr"></div>
      <div class="q-cards">
        <button class="q-card m-plaque" data-a="tuto">${medal("instruction")}<b>${tr("Instruction", "Training")}</b><small class="q-tutl"></small></button>
        <button class="q-card q-big m-plaque" data-a="camp-next"><span class="q-art"></span><b>${tr("La Campagne de 1900", "The 1900 Campaign")}</b><small class="q-campl"></small><span class="q-more" data-a="camp-all">${tr("Toutes les missions ›", "All missions ›")}</span></button>
        <button class="q-card m-plaque" data-a="trials">${medal("medaille")}<b>${tr("Épreuves", "Trials")}</b><small class="q-triall"></small></button>
      </div>
    </section>

    <section class="q-panel q-bat" data-for="bataille">
      ${back}<h2 class="q-h">${tr("Bataille", "Battle")}</h2><div class="m-frise q-fr"></div>
      <button class="q-op m-papier" data-a="daily">
        <span class="q-optag"><span>${tr(`Op du jour n°${op.number}`, `Daily Op #${op.number}`)}</span><span class="q-opwon"></span></span>
        <span class="q-opmap" style="background-image:url(${opThumb})"></span>
        <b>${mapById(op.mapId).name}</b><small>${opVs}</small>
        <span class="q-opfoot"><span class="q-streak">${medal("flamme")}<em></em></span><span class="q-stamp">${tr("Jouer", "Play")}</span></span>
      </button>
      <div class="q-libre m-plaque">
        <div class="q-type"><button data-p="skirmish">${tr("Escarmouche", "Skirmish")}<small>${tr("détruis leur QG", "destroy their HQ")}</small></button><button data-p="survival">${tr("Survie", "Last Stand")}<small class="q-survl"></small></button></div>
        <div class="q-plan"></div>
      </div>
      <button class="cta big q-batgo" data-a="go">${tr("En avant !", "Forward!")}</button>
    </section>

    <section class="q-panel q-cab" data-for="cabinet">
      <div class="q-sheet m-papier">
        <h2 class="q-h">${medal("cabinet")}${tr("Le Cabinet", "The Cabinet")}</h2>
        <button class="q-close" data-a="back">${tr("Fermer", "Close")}</button>
        <div class="m-frise q-fr"></div>
        <div class="q-cabbody">
          <button class="q-id m-plaque" data-a="career"></button>
          <div class="q-items">
            <button class="q-it" data-a="career">${medal("medaille")}<span><b>${tr("Médailles", "Medals")}</b><small class="q-meds"></small></span></button>
            <button class="q-it" data-a="archives">${medal("archives")}<span><b>Archives</b><small>${tr("Revoir tes batailles", "Watch your battles again")}</small></span></button>
            <a class="q-it" href="models.html" target="_blank" rel="noopener">${medal("encyclopedie")}<span><b>${tr("Encyclopédie", "Encyclopaedia")}</b><small>${tr("Toutes les unités, en 3D", "Every unit, in 3D")}</small></span></a>
            <button class="q-it" data-a="settings">${medal("reglages")}<span><b>${tr("Réglages", "Settings")}</b><small>${tr("Son, langue, compte", "Sound, language, account")}</small></span></button>
          </div>
        </div>
      </div>
    </section>

    <div class="q-unlock" hidden>
      <div class="q-ray"></div>
      <div class="q-dep m-papier"><span>${tr("Dépêche · État-major", "Dispatch · Staff")}</span><p></p></div>
      <div class="q-udoor"></div>
      <p class="q-ul"></p>
      <button class="cta big" data-a="unlock-ok">${tr("Ouvrir", "Open")}</button>
    </div>`;
  menu.querySelector(".menu-inner")?.before(el);

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const on = (s: string, fn: (b: HTMLElement, e: Event) => void) =>
    el.querySelectorAll<HTMLElement>(s).forEach((b) => b.addEventListener("click", (e) => fn(b, e)));
  const tap = () => sfx.play("click", 0.5);
  const show = (v: View) => {
    el.dataset.v = v;
    if (v === "bataille") {
      const p = hooks.state().pick;
      if (p !== "skirmish" && p !== "survival") hooks.pick("skirmish");
    }
    sync();
  };

  /** What the big button launches now, and the ticket that says so. */
  const next = (s: HubState): { head: string; title: string; line: string; run: () => void } => {
    if (s.resume) {
      const [kind, ...where] = s.resume.label.split(" · ");
      return {
        head: tr("Reprendre · partie interrompue", "Resume · match interrupted"),
        title: where.length ? where.join(" · ") : kind!,
        line: `${where.length ? `${kind} · ` : ""}${tr(`laissée à ${clock(s.resume.secs)}`, `left at ${clock(s.resume.secs)}`)}`,
        run: () => hooks.resume()
      };
    }
    if (!s.tutoDone && !s.tutoDeclined)
      return { head: tr("Suivant · Instruction", "Next · Training"), title: tr("Premier jour", "First Day"), line: tr("3 minutes · un geste à la fois", "3 minutes · one gesture at a time"), run: () => hooks.tuto() };
    if (s.camp.next)
      return {
        head: tr(`Suivant · Campagne, mission ${s.camp.next.n}`, `Next · Campaign, mission ${s.camp.next.n}`),
        title: s.camp.next.title,
        line: `${tr("Acte", "Act")} ${ROMAN[s.camp.act] ?? s.camp.act} · ${s.camp.next.map}`,
        run: () => hooks.campaign(s.camp.next!.id)
      };
    if (s.doors.battle && loadCareer().daily.lastWin !== op.day)
      return { head: tr(`Op du jour n°${op.number}`, `Daily Op #${op.number}`), title: mapById(op.mapId).name, line: opVs, run: () => hooks.daily(op) };
    return {
      head: s.pick === "survival" ? tr("Survie", "Last Stand") : tr("Escarmouche", "Skirmish"),
      title: s.map.name,
      line: `${s.difficulty} · ${NATION_CARDS[s.nation as "republique"]?.title ?? tr("Classique", "Classic")}`,
      run: () => {
        if (s.pick !== "skirmish" && s.pick !== "survival") hooks.pick("skirmish");
        hooks.go();
      }
    };
  };
  let run = () => {};

  // ---- the Bataille panel: what a match is made of
  const planEl = $(".q-plan");
  const seg = (k: string, title: string, items: { id: string; label: string; on: boolean }[]) =>
    `<span class="q-k">${title}</span><div class="q-seg" data-k="${k}">${items.map((x) => `<button data-v="${x.id}" class="${x.on ? "on" : ""}">${x.label}</button>`).join("")}</div>`;
  const plan = (s: HubState) => {
    const nations = NATION_ORDER.map((n) => ({
      id: n,
      label: `${n === "classique" ? "" : crestImg(n, "q-crest")}${n === "classique" ? tr("Classique", "Classic") : NATION_CARDS[n].title}`,
      on: n === s.nation
    }));
    planEl.innerHTML = `
      <div class="q-maps">${s.maps
        .map((m) => `<button class="q-map${m.on ? " on" : ""}" data-id="${m.id}"><img src="${m.thumb}" alt="" draggable="false"/><small>${m.name}</small>${m.badge ? `<em>${m.badge}</em>` : ""}</button>`)
        .join("")}</div>
      <div class="q-rows">
        ${seg("diff", tr("Difficulté", "Difficulty"), s.diffs)}
        ${s.rivals ? seg("rival", tr("Adversaire", "Opponent"), s.rivals) : ""}
        ${seg("nation", tr("Ta nation", "Your nation"), nations)}
        ${s.eclair === null ? "" : seg("eclair", tr("Durée", "Length"), [{ id: "off", label: tr("Libre", "Open"), on: !s.eclair }, { id: "on", label: tr("Éclair 6 min", "Lightning 6 min"), on: s.eclair }])}
      </div>
      <div class="q-extra">
        ${s.pick === "skirmish" ? `<button class="q-mut">${tr("Mutateurs", "Mutators")} <b>${s.mutators || tr("aucun", "none")}</b></button>` : "<span></span>"}
        <button class="q-salon">${tr("Toutes les options ›", "All options ›")}</button>
      </div>`;
  };
  planEl.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!t) return;
    tap();
    if (t.classList.contains("q-salon")) return hooks.salon();
    if (t.classList.contains("q-mut")) return hooks.mutators();
    if (t.dataset.id) return hooks.map(t.dataset.id);
    const k = t.closest<HTMLElement>(".q-seg")?.dataset.k;
    const v = t.dataset.v;
    if (!k || !v) return;
    if (k === "diff") hooks.difficulty(v);
    else if (k === "rival") hooks.rival(v);
    else if (k === "nation") hooks.nation(v as NationOrClassic);
    else if (k === "eclair" && (v === "on") !== !!hooks.state().eclair) hooks.eclair();
  });

  // ---- a door opening: its moment, once
  const unlock = $(".q-unlock");
  const seen = (): string[] => {
    try {
      return (localStorage.getItem(SEEN_KEY) ?? "").split(",").filter(Boolean);
    } catch {
      return ["battle", "duel"];
    }
  };
  const moment = (s: HubState) => {
    if (!unlock.hidden || menu.dataset.view !== "qg" || el.dataset.v !== "hub") return;
    const k = (["battle", "duel"] as const).find((d) => s.doors[d] && !seen().includes(d));
    if (!k) return;
    try {
      localStorage.setItem(SEEN_KEY, [...seen(), k].join(","));
    } catch {
      /* (private mode: the moment may come again) */
    }
    const door = el.querySelector<HTMLElement>(`[data-door="${k === "battle" ? "bataille" : "duel"}"]`)!;
    $(".q-udoor").innerHTML = door.outerHTML;
    $(".q-dep p").textContent =
      k === "battle"
        ? tr("Bravo. Le terrain d'exercice vous est ouvert. STOP", "Well done. The exercise ground is yours. STOP")
        : tr("L'adversaire est au bout du fil. Le Duel est ouvert. STOP", "The enemy is on the line. The Duel is open. STOP");
    $(".q-ul").textContent =
      k === "battle"
        ? tr("Escarmouche, Survie et l'Op du jour : choisis ta carte et ton adversaire, et reviens chaque jour.", "Skirmish, Last Stand and the Daily Op: pick your map and your opponent, and come back every day.")
        : tr("Affronte un joueur de ton niveau en partie classée, ou défie un ami avec un code.", "Face a player of your level in a ranked match, or challenge a friend with a code.");
    unlock.dataset.k = k;
    unlock.hidden = false;
    sfx.play("rank", 0.7);
  };

  const sync = () => {
    const s = hooks.state();
    const c = loadCareer();
    const r = rankOf(c.xp);
    $("#qg-rank").innerHTML = `${insigniaSvg(r.index)}<span><b>${r.name}</b><i><u style="width:${(r.progress * 100).toFixed(1)}%"></u></i></span>`;
    const streak = currentStreak(c, today());
    const won = c.daily.lastWin === op.day;
    const medals = Object.keys(c.medals).length;

    // the doors
    const camp = $('[data-door="campagne"]');
    camp.querySelector<HTMLElement>(".q-vign")!.style.backgroundImage = s.camp.art ? `url(${s.camp.art})` : "";
    camp.querySelector("small")!.textContent = s.camp.next
      ? tr(`Acte ${ROMAN[s.camp.act]} · mission ${s.camp.next.n} sur ${s.camp.total}`, `Act ${ROMAN[s.camp.act]} · mission ${s.camp.next.n} of ${s.camp.total}`)
      : tr(`Les ${s.camp.total} missions accomplies`, `All ${s.camp.total} missions done`);
    camp.querySelector<HTMLElement>(".q-prog u")!.style.width = `${(s.camp.done / s.camp.total) * 100}%`;
    const bat = $('[data-door="bataille"]');
    bat.classList.toggle("lock", !s.doors.battle);
    bat.querySelector("small")!.textContent = s.doors.battle
      ? tr("Escarmouche · Survie", "Skirmish · Last Stand")
      : tr(`Après la mission ${DOOR_AT.battle}`, `After mission ${DOOR_AT.battle}`);
    const chip = bat.querySelector<HTMLElement>(".q-chip")!;
    chip.hidden = !s.doors.battle;
    chip.innerHTML = `${medal("flamme")}${won ? tr("Op du jour gagnée", "Daily Op won") : tr("Op du jour", "Daily Op")}${streak ? ` · ${streak} ${tr(streak > 1 ? "jours" : "jour", streak > 1 ? "days" : "day")}` : ""}`;
    chip.classList.toggle("new", !won);
    const duel = $('[data-door="duel"]');
    duel.classList.toggle("lock", !s.doors.duel || !s.duel);
    duel.querySelector("small")!.textContent = !s.doors.duel
      ? tr(`Après la mission ${DOOR_AT.duel}`, `After mission ${DOOR_AT.duel}`)
      : s.duel ? tr("En ligne · classée ou contre un ami", "Online · ranked or with a friend") : tr("Hors ligne", "Offline");

    // the big button
    const n = next(s);
    $(".q-nh").textContent = n.head;
    $(".q-nt").textContent = n.title;
    $(".q-nl").textContent = n.line;
    $(".q-drop").hidden = !s.resume;
    run = n.run;

    // the panels
    $(".q-tutl").textContent = !s.tutoDone ? tr("Premier jour · 3 minutes", "First Day · 3 minutes") : s.tuto2Done ? tr("Les deux journées suivies", "Both days done") : tr("Deuxième jour", "Second Day");
    $(".q-camp .q-art").style.backgroundImage = s.camp.art ? `url(${s.camp.art})` : "";
    $(".q-campl").textContent = s.camp.next
      ? tr(`Mission ${s.camp.next.n} : ${s.camp.next.title} · ${s.camp.done}/${s.camp.total} accomplies`, `Mission ${s.camp.next.n}: ${s.camp.next.title} · ${s.camp.done}/${s.camp.total} done`)
      : tr(`Les ${s.camp.total} missions accomplies`, `All ${s.camp.total} missions done`);
    $(".q-triall").textContent = tr(`${s.trials.done} sur ${s.trials.total} réussies`, `${s.trials.done} of ${s.trials.total} passed`);
    $(".q-opwon").textContent = won ? tr("Gagnée", "Won") : op.label;
    $(".q-streak em").textContent = streak ? tr(`${streak} jour${streak > 1 ? "s" : ""} d'affilée`, `${streak} day${streak > 1 ? "s" : ""} in a row`) : tr("Gagne-la pour lancer une série", "Win it to start a streak");
    $(".q-survl").textContent = s.survivalBest ? tr(`record : ${s.survivalBest} vagues`, `best: ${s.survivalBest} waves`) : tr("tiens le plus longtemps", "hold out the longest");
    el.querySelectorAll<HTMLElement>(".q-type [data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === s.pick));
    if (el.dataset.v === "bataille") plan(s);
    $(".q-id").innerHTML = `${insigniaSvg(r.index)}<b>${r.name}</b><i><u style="width:${(r.progress * 100).toFixed(1)}%"></u></i><small>${r.next !== null ? tr(`${c.xp} / ${r.next} XP · ${r.nextName} ensuite`, `${c.xp} / ${r.next} XP · ${r.nextName} next`) : `${c.xp} XP`}</small><small>${tr(`${c.wins} victoires · ${c.losses} défaites`, `${c.wins} wins · ${c.losses} losses`)}</small>`;
    $(".q-meds").textContent = tr(`${medals} sur ${MEDAL_IDS.length}`, `${medals} of ${MEDAL_IDS.length}`);
    moment(s);
  };

  on("[data-door]", (b) => {
    tap();
    if (b.classList.contains("lock")) return void b.animate([{ transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }], { duration: 220 });
    const d = b.dataset.door!;
    if (d === "duel") {
      hooks.pick("duel");
      return hooks.duel();
    }
    show(d as View);
  });
  on("#qg-go", () => run());
  on('[data-a="go"]', () => hooks.go());
  on('[data-a="back"]', () => {
    tap();
    show("hub");
  });
  on('[data-a="cabinet"]', () => {
    tap();
    show("cabinet");
  });
  on('[data-a="drop"]', (_b, e) => {
    e.stopPropagation();
    tap();
    hooks.dropResume();
  });
  on('[data-a="tuto"]', () => hooks.tuto());
  on('[data-a="camp-next"]', (_b, e) => {
    if ((e.target as HTMLElement).closest('[data-a="camp-all"]')) return hooks.book("campaign");
    hooks.campaign(hooks.state().camp.next?.id);
  });
  on('[data-a="trials"]', () => {
    tap();
    hooks.book("trials");
  });
  on('[data-a="daily"]', () => hooks.daily(op));
  on(".q-type [data-p]", (b) => {
    tap();
    hooks.pick(b.dataset.p as HubPick);
  });
  on('[data-a="career"]', () => hooks.career());
  on('[data-a="archives"]', () => {
    tap();
    hooks.replays();
  });
  on('[data-a="settings"]', () => {
    tap();
    hooks.settings();
  });
  on("#qg-rank", () => hooks.career());
  on('[data-a="unlock-ok"]', () => {
    tap();
    const k = unlock.dataset.k;
    unlock.hidden = true;
    const door = el.querySelector<HTMLElement>(`[data-door="${k === "battle" ? "bataille" : "duel"}"]`);
    door?.animate([{ boxShadow: "0 0 0 0 rgba(243,217,140,0)" }, { boxShadow: "0 0 40px 6px rgba(243,217,140,.7)" }, { boxShadow: "0 0 0 0 rgba(243,217,140,0)" }], { duration: 1400 });
    sync();
  });
  sync();
  return { sync };
}
