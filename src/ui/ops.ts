import { DIFFICULTY, PERSONALITIES } from "../sim/ai/commander";
import { NATIONS, UNITS } from "../sim/balance";
import { MAPS } from "../sim/maps";
import {
  CAMPAIGN,
  CAMPAIGN_UNLOCKS,
  OP_LEVELS,
  OP_LEVEL_IDS,
  opHasLevel,
  shiftDifficulty,
  type OpLevel,
  TRIALS,
  bookOf,
  fmtClock,
  isCampaignOp,
  unlocksAfter,
  type CampaignUnlock,
  goalText,
  isAchieveGoal,
  nextOp,
  objectiveLine,
  opById,
  opIndex,
  opStatus,
  type Goal,
  type GoalEval,
  type OpDef,
  type OpStatus
} from "../sim/ops";
import { MUTATORS } from "../sim/rules";
import { displayName, pluralName } from "../sim/lexicon";
import { POWER_NAMES } from "../sim/powers";
import { ACT_NAMES, opKicker } from "../game/ops";
import "./campaign.css";
import type { World } from "../sim/types";
import { sfx } from "../game/audio";
import { BELLE_EPOQUE } from "../game/three/theme";
import { mapAssetBase } from "../game/assets";
import { campaignCompleted, loadCareer, opCleared, opUnlocked, opsCompleted, settlementOf, starCount, type CareerData } from "../game/career";
import { addReportSection, type ReportContext, type ReportOpts } from "./report";
import { gameMode, pickMode, pickOpLevel } from "../game/mode";
import { fullscreen } from "./fullscreen";
import { tr } from "../lang";

/**
 * Ops UI: the menu's op cards and briefing sheet, the in-match goal pill
 * (with a tap-to-open objectives card), the pause-screen objectives, and the
 * end screen's star row. The sim owns the rules (src/sim/ops.ts).
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const mapName = (id: string) => MAPS.find((m) => m.id === id)?.name ?? id;
const STAR_KEYS = ["★", "★★", "★★★"];

/** "vs Rush · Hard", "Last Stand waves", "no enemy commander". */
export function enemyLine(op: OpDef): string {
  if (op.ai === "survival") return op.nations ? tr(`vagues de ${NATIONS[op.nations.enemy].name}`, `waves of ${NATIONS[op.nations.enemy].name}`) : tr("vagues de Survie", "Last Stand waves");
  if (!op.ai) return tr("une garnison statique", "a static garrison");
  const name = PERSONALITIES[op.ai.strategy].label;
  const who = op.nations ? `${NATIONS[op.nations.enemy].name} (${name})` : name;
  // (the campaign's level moves the commander a notch: the line says the difficulty it will play)
  const d = DIFFICULTY[shiftDifficulty(op.ai.difficulty, opHasLevel(op) ? OP_LEVELS[gameMode.opLevel].notch : 0)].label;
  return tr(`contre ${who} · ${d}`, `vs ${who} · ${d}`);
}

/** "★★☆" for a star mask. */
const starRow = (mask: number) => [1, 2, 4].map((b) => (mask & b ? "★" : "☆")).join("");

/** Star conditions as list items: what each star needs (and which you hold). */
function starListHtml(op: OpDef, mask: number, live?: OpStatus): string {
  const rows: { text: string; cls: string }[] = [{ text: isCampaignOp(op) ? tr("Réussir la mission", "Complete the mission") : tr("Réussir l'épreuve", "Complete the trial"), cls: mask & 1 ? "got" : "" }];
  op.stars.forEach((g, i) => {
    const bit = 2 << i;
    const e = live?.stars[i]?.eval;
    const cls = mask & bit ? "got" : e ? (e.state === "failed" ? "lost" : e.state === "done" || e.state === "ok" ? "ok" : "") : "";
    rows.push({ text: goalText(g, true, op), cls });
  });
  return `<ul class="op-starlist">${rows.map((r, i) => `<li class="${r.cls}"><b>${STAR_KEYS[i]}</b><span>${esc(r.text)}</span></li>`).join("")}</ul>`;
}

function goalIcon(g: Goal): string {
  switch (g.type) {
    case "destroyHq":
      return "🎯";
    case "destroy":
      return "💥";
    case "survive":
      return "🛡";
    case "waves":
      return "🌊";
    case "deliver":
      return "⚙";
    case "protect":
      return "🛡";
    case "within":
      return "⏱";
    case "maxLosses":
      return "✝";
    case "reach":
      return "🚩";
  }
}

/** Pill shorthand for a goal: "Turrets 2/2", "⏱ 1:12", "✝ 2/6", "🏚 0/1", "Mastodons 1/2". */
function compact(g: Goal, e: GoalEval): string {
  switch (g.type) {
    case "within":
      return `⏱ ${e.value}`;
    case "maxLosses":
      return `${g.buildings ? "🏚" : "✝"} ${e.value}`;
    case "protect":
    case "destroy":
      return `${e.label} ${e.value}`;
    default:
      return `${goalIcon(g)} ${e.value}`;
  }
}

function goalListHtml(op: OpDef, live?: OpStatus): string {
  return `<ul class="op-goals">${op.goals
    .map((g, i) => {
      const e = live?.goals[i]?.eval;
      const cls = e ? (e.state === "failed" ? "lost" : e.state === "done" ? "got" : "") : "";
      return `<li class="${cls}"><em>${goalIcon(g)}</em><span>${esc(goalText(g, false, op))}</span>${e ? `<b>${esc(e.value)}</b>` : ""}</li>`;
    })
    .join("")}</ul>`;
}

/** "Fourgon, Jamais-Contente et Fée Électricité": an unlock's kinds as the nation names them. */
export function unlockNames(u: CampaignUnlock): string {
  const names = [
    ...(u.units ?? []).map((k) => displayName(k, u.nation)),
    ...(u.buildings ?? []).filter((k) => k !== "hq").map((k) => displayName(k, u.nation)),
    ...(u.powers ?? []).map((p) => POWER_NAMES[p])
  ];
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")}${tr(" et ", " and ")}${names[names.length - 1]}`;
}

/** Rules line for the briefing: the op's own bans, frozen income, mutators. */
function rulesNote(op: OpDef): string {
  const bits: string[] = [];
  const bans = op.rules?.playerBans;
  const nat = op.nations?.player;
  if (bans?.units?.length === Object.keys(UNITS).length && bans.buildings?.length) bits.push(tr("⛔ Aucune production", "⛔ No production"));
  else {
    if (bans?.buildings?.length) bits.push(tr(`⛔ Interdits : ${bans.buildings.map((k) => displayName(k, nat)).join(", ")}`, `⛔ Banned: ${bans.buildings.map((k) => displayName(k, nat)).join(", ")}`));
    if (bans?.units?.length) {
      const ground = bans.units.filter((k) => UNITS[k].domain === "ground" && UNITS[k].dps > 0).length >= 4;
      const named = bans.units.filter((k) => !ground || !(UNITS[k].domain === "ground" && UNITS[k].dps > 0)).map((k) => pluralName(k, nat));
      bits.push(tr(`⛔ Interdits : ${[...(ground ? ["unités terrestres"] : []), ...named].join(", ")}`, `⛔ Banned: ${[...(ground ? ["ground units"] : []), ...named].join(", ")}`));
    }
  }
  if (op.rules?.playerIncome === 0) bits.push(tr("❄ Aucun revenu", "❄ No income"));
  if (op.rules?.calldowns === false) bits.push(tr("⚡ Aucun appui", "⚡ No calldowns"));
  for (const id of op.rules?.mutators ?? []) bits.push(`${MUTATORS[id].icon} ${MUTATORS[id].name}`);
  return bits.join(" · ");
}

/** « Tu joues la République » / « Tu joues l'Empire de Carbonie (le Maréchal Mâchefer) ». */
function sideLine(op: OpDef): string {
  if (!op.nations) return tr("Classique", "Classic");
  return op.nations.player === "empire"
    ? tr("Tu joues l'Empire de Carbonie — le Maréchal Mâchefer", "You play the Empire of Carbonia — Marshal Mâchefer")
    : tr("Tu joues la République — Capitaine Valmont", "You play the Republic — Captain Valmont");
}

// ---------------------------------------------------------------- in match ---

export interface OpsHud {
  update(): void;
  pauseLine(): string;
  pauseHtml(): string;
  /** Report options for the end screen (headline, Next op button). */
  reportOpts(): Partial<ReportOpts>;
}

/**
 * The goal pill in the top bar: the primary objective and its clock on top,
 * the other conditions and three live stars below. Tapping it opens the
 * objectives card (all goals and star conditions, live).
 */
export function createOpsHud(pill: HTMLElement, root: HTMLElement, w: World, opts: { rematch(token: string): void }): OpsHud {
  const op = opById(w.ops!.id)!;
  // the Instruction: its lesson bubble is the only objective on screen
  if (op.tutorial) return tutorialHud(op, w, opts);
  pill.hidden = false;
  root.classList.add("has-ops");
  pill.innerHTML = `<b class="ol"></b><span class="ov"></span><span class="os"></span><span class="ostars"><i>★</i><i>★</i><i>★</i></span>`;
  const ol = pill.querySelector<HTMLElement>(".ol")!;
  const ov = pill.querySelector<HTMLElement>(".ov")!;
  const os = pill.querySelector<HTMLElement>(".os")!;
  const starEls = [...pill.querySelectorAll<HTMLElement>(".ostars i")];
  const card = document.createElement("div");
  card.className = "opsinfo";
  card.hidden = true;
  root.appendChild(card);
  // portrait: under the clock in the top-bar column; landscape: the top bar is a
  // full row, so the pill sits in the top-left corner under the pause button
  const topbar = pill.parentElement;
  const landscape = window.matchMedia("(orientation: landscape)");
  const place = () => {
    // (Panache keeps it in the top-left column in both orientations: src/ui/belle-hud.ts)
    const corner = landscape.matches && !BELLE_EPOQUE;
    if (corner && pill.parentElement !== root) root.insertBefore(pill, card);
    else if (!corner && topbar && pill.parentElement !== topbar) topbar.appendChild(pill);
    pill.classList.toggle("corner", corner);
    card.classList.toggle("corner", corner);
  };
  place();
  landscape.addEventListener("change", place);
  let cardTimer = 0;
  const stop = (e: Event) => e.stopPropagation();
  for (const el of [pill, card]) el.addEventListener("pointerdown", stop);
  const closeCard = () => {
    card.hidden = true;
    window.clearTimeout(cardTimer);
  };
  pill.addEventListener("click", () => {
    if (!card.hidden) return closeCard();
    sfx.play("click", 0.5);
    renderCard();
    card.hidden = false;
    window.clearTimeout(cardTimer);
    cardTimer = window.setTimeout(closeCard, 7000);
  });
  card.addEventListener("click", closeCard);

  const cardHtml = (st: OpStatus) => `
    <div class="oi-head"><em>${op.icon}</em><b>${esc(op.title)}</b><span>${isCampaignOp(op) ? tr("Mission", "Mission") : tr("Épreuve", "Trial")} ${opIndex(op.id) + 1}</span></div>
    ${goalListHtml(op, st)}
    ${starListHtml(op, 0, st)}`;
  function renderCard(): void {
    const st = opStatus(w);
    if (st) card.innerHTML = cardHtml(st);
  }

  let lastKey = "";
  function update(): void {
    const st = opStatus(w);
    if (!st) return;
    const main = st.goals.find((g) => isAchieveGoal(g.goal)) ?? st.goals[0]!;
    const timer = st.goals.find((g) => g.goal.type === "within");
    let label = main.eval.label;
    let value = main.eval.value;
    if (main.goal.type === "destroyHq") {
      label = op.nations?.enemy === "empire" ? tr("Détruire la Citadelle", "Destroy the Citadel") : tr("Détruire le GQG", "Destroy the GHQ");
      value = timer ? timer.eval.value : main.eval.value;
    }
    const others = st.goals.filter((g) => g !== main && !(main.goal.type === "destroyHq" && g === timer)).map((g) => compact(g.goal, g.eval));
    if (main.goal.type === "destroyHq") {
      // their HQ's health, once we have seen it
      const known = [...w.fog[w.ops!.player].known.values()].some((b) => b.kind === "hq" && b.faction === w.ops!.enemy);
      const hqName = op.nations?.enemy === "empire" ? tr("Citadelle", "Citadel") : tr("GQG", "GHQ");
      others.unshift(known ? `${hqName} ${main.eval.value}` : tr(`${hqName} non repérée`.replace("GQG non repérée", "GQG non repéré"), `${hqName} not spotted`));
    }
    // nothing else to track: show the star conditions' progress instead
    if (others.length === 0) for (const g of st.stars) if (g.eval.state !== "failed") others.push(compact(g.goal, g.eval));
    const sub = others.join(" · ") || op.title;
    const live = (e: GoalEval | undefined, i: number) => {
      if (i === 0) return st.result?.won ? "on" : "";
      if (!e) return "";
      return e.state === "failed" ? "lost" : e.state === "done" || e.state === "ok" ? "on" : "";
    };
    const cls = [live(undefined, 0), live(st.stars[0]?.eval, 1), live(st.stars[1]?.eval, 2)];
    const urgent = (timer && timer.eval.progress < 0.17) || (main.goal.type === "survive" && main.eval.progress > 0.83);
    const key = `${label}|${value}|${sub}|${cls.join(",")}|${urgent}`;
    if (key === lastKey) return;
    lastKey = key;
    pill.classList.toggle("hot", !!urgent && !!timer);
    pill.classList.toggle("near", !!urgent && !timer);
    ol.textContent = label;
    ov.textContent = value;
    os.textContent = sub;
    starEls.forEach((el, i) => (el.className = cls[i] ?? ""));
    if (!card.hidden) renderCard();
  }

  function reportOpts(): Partial<ReportOpts> {
    const r = w.ops?.result;
    const won = !!r?.won;
    const nxt = nextOp(op.id);
    const career = loadCareer();
    const actions: ReportOpts["actions"] = [];
    if (won && nxt && opUnlocked(career, nxt.id))
      actions.push({ id: "op-next", label: tr(`▶ Suivante : ${nxt.title}`, `▶ Next: ${nxt.title}`), on: () => opts.rematch(`op:${nxt.id}`) });
    const name = isCampaignOp(op) ? tr("MISSION", "MISSION") : tr("ÉPREUVE", "TRIAL");
    return {
      head: {
        title: won ? tr(`${name} RÉUSSIE`, `${name} COMPLETE`) : tr(`${name} ÉCHOUÉE`, `${name} FAILED`),
        cls: won ? "win" : "lose",
        sub: `${opKicker(op)} · ${op.title} · ${mapName(op.map)} · ${fmtClock(r?.secs ?? 0)}`
      },
      actions,
      rematchLabel: won ? tr("↻ Rejouer", "↻ Replay") : tr("↻ Réessayer", "↻ Try again")
    };
  }

  update();
  return {
    update,
    pauseLine: () => `${opKicker(op)} · ${op.title} · ${enemyLine(op)}`,
    pauseHtml: () => {
      const st = opStatus(w);
      return st ? `<div class="op-pause">${goalListHtml(op, st)}${starListHtml(op, 0, st)}</div>` : "";
    },
    reportOpts
  };
}

/** The Instruction's slice of the ops HUD: no pill, its own pause line and end-screen buttons. */
function tutorialHud(op: OpDef, w: World, opts: { rematch(token: string): void }): OpsHud {
  return {
    update() {},
    pauseLine: () => `${op.icon} ${tr("Instruction", "Training")} · ${op.title}`,
    pauseHtml: () => "",
    reportOpts() {
      const won = !!w.ops?.result?.won;
      return {
        head: {
          title: won ? tr("INSTRUCTION RÉUSSIE", "TRAINING COMPLETE") : tr("INSTRUCTION", "TRAINING"),
          cls: won ? "win" : "lose",
          sub: won ? tr("Tu es prêt, mon commandant !", "You're ready, commander!") : op.title
        },
        actions: [
          {
            id: "tuto-skirmish",
            label: tr("⚔ Escarmouche", "⚔ Skirmish"),
            on: () => {
              // (a first skirmish: the Easy commander, unless one was picked before)
              pickMode("skirmish", true);
              opts.rematch("1");
            }
          },
          {
            id: "tuto-ops",
            label: tr("🎖 Opérations", "🎖 Operations"),
            cls: "alt",
            on: () => {
              pickMode("ops");
              fullscreen.reload();
            }
          }
        ],
        rematchLabel: tr("↻ Rejouer l'instruction", "↻ Replay the training")
      };
    }
  };
}

// ------------------------------------------------------------------ level ---

/** What the level does, under its picker. */
function levelNote(lv: OpLevel): string {
  return lv === "recrue"
    ? tr("Ennemi moins fort, plus de charbon. Pas d'étoiles.", "Weaker enemy, more coal. No stars.")
    : lv === "veteran"
      ? tr("Ennemi plus fort, moins de charbon. Pas d'étoiles.", "Stronger enemy, less coal. No stars.")
      : tr("La mission telle qu'elle est réglée. Les étoiles comptent.", "The mission as tuned. Stars count.");
}

/** The briefing's level picker: Recrue · Normal · Vétéran (saved for every mission). */
function levelPickHtml(): string {
  const lv = gameMode.opLevel;
  return `<div class="ob-level"><h3>${tr("Niveau", "Level")}</h3><div class="seg">${OP_LEVEL_IDS.map((id) => `<button data-lv="${id}" class="${id === lv ? "on" : ""}">${OP_LEVELS[id].label}</button>`).join("")}</div><small>${levelNote(lv)}</small></div>`;
}

// -------------------------------------------------------------- end screen ---

function opSectionHtml(ctx: ReportContext): string | null {
  const st = ctx.world.ops;
  const op = st ? opById(st.id) : null;
  if (!st || !op || ctx.spectator) return null;
  if (op.tutorial) return tutorialSectionHtml(st.result?.won ?? false);
  const r = st.result;
  const s = settlementOf(ctx.world);
  // (Recrue and Vétéran earn no stars: the row stays empty and says why)
  const mask = st.level ? 0 : (r?.stars ?? 0);
  const before = s?.op?.starsBefore ?? 0;
  const stars = [1, 2, 4]
    .map((b, i) => `<i class="${mask & b ? "on" : ""}${mask & b && !(before & b) ? " new" : ""}" style="--i:${i}">${mask & b ? "★" : "☆"}</i>`)
    .join("");
  const best = s?.op ? s.op.starsAfter : mask;
  const rec = loadCareer().ops[op.id];
  const bestLine =
    rec && opCleared(rec)
      ? `<p class="op-best">Record ${starRow(best)}${rec.bestSecs !== null ? ` · ${fmtClock(rec.bestSecs)}` : ""} · ${rec.plays} tentative${rec.plays === 1 ? "" : "s"}</p>`
      : "";
  const unlocked = s?.op?.unlocked ? opById(s.op.unlocked) : null;
  const kit = s?.op?.firstClear ? unlocksAfter(op) : null;
  return `<div class="op-res ${r?.won ? "won" : "lost"}">
    <div class="op-bigstars">${stars}</div>
    <p class="op-reason">${esc(r?.reason ?? "")}</p>
    ${st.level ? `<p class="op-level">${tr(`Niveau ${OP_LEVELS[st.level].label} : pas d'étoiles, elles ne se gagnent qu'en Normal.`, `${OP_LEVELS[st.level].label} level: no stars, they are only earned on Normal.`)}${r?.won ? tr(" La mission suivante est ouverte.", " The next mission is open.") : ""}</p>` : ""}
    ${starListHtml(op, mask)}
    ${bestLine}
    ${unlocked ? `<p class="op-unlock">${tr(`🔓 ${isCampaignOp(unlocked) ? "Nouvelle mission" : "Nouvelle épreuve"} : <b>${unlocked.icon} ${esc(unlocked.title)}</b>`, `🔓 ${isCampaignOp(unlocked) ? "New mission" : "New trial"}: <b>${unlocked.icon} ${esc(unlocked.title)}</b>`)}</p>` : ""}
    ${r?.won && kit ? `<p class="op-unlock op-unlock-kit">${tr(`🔧 ${esc(kit.by ?? "L'arsenal")} apporte : <b>${esc(unlockNames(kit))}</b>`, `🔧 ${esc(kit.by ?? "The arsenal")} brings: <b>${esc(unlockNames(kit))}</b>`)}</p>` : ""}
    ${r?.won ? "" : `<p class="op-tip"><b>${tr("Conseil", "Tip")}</b><span>${esc(op.tip)}</span></p>`}
  </div>`;
}

/** The Instruction's end: three stars, the send-off, and what to play next. */
function tutorialSectionHtml(won: boolean): string | null {
  if (!won) return null;
  const stars = [0, 1, 2].map((i) => `<i class="on new" style="--i:${i}">★</i>`).join("");
  return `<div class="op-res won tuto-res">
    <div class="op-bigstars">${stars}</div>
    <p class="op-reason">${tr("Instruction terminée", "Training complete")}</p>
    <ul class="op-starlist"><li class="got"><b>★</b><span>${tr("Caméra, ordres et combat", "Camera, orders and combat")}</span></li><li class="got"><b>★★</b><span>${tr("Forges et production", "Forges and production")}</span></li><li class="got"><b>★★★</b><span>${tr("Armée, charbon et Feu roulant", "Army, coal and Rolling Barrage")}</span></li></ul>
    <p class="op-tip"><b>${tr("Et maintenant ?", "What now?")}</b><span>${tr("Une Escarmouche contre l'IA, ou la campagne des Opérations.", "A Skirmish against the AI, or the Operations campaign.")}</span></p>
  </div>`;
}

addReportSection({
  id: "op",
  order: 4,
  col: "left",
  render: opSectionHtml,
  mount(el) {
    // new stars pop in after the headline
    el.querySelectorAll<HTMLElement>(".op-bigstars i.new").forEach((star, i) => {
      star.style.setProperty("--md", `${650 + i * 260}ms`);
      window.setTimeout(() => el.isConnected && sfx.play(i === 0 ? "rank" : "click", 0.7), 650 + i * 260);
    });
  }
});

// -------------------------------------------------------------------- menu ---

export interface MenuOps {
  sync(): void;
  /** The op the Play button starts (the selected card). */
  selected(): OpDef;
  locked(op: OpDef): boolean;
  openBrief(op: OpDef): void;
}

type Book = "campaign" | "trials";
const bookName = (op: OpDef): Book => (isCampaignOp(op) ? "campaign" : "trials");

/** "📜 3/12 missions · 7/36 ★" or "🎖 2/8 épreuves · 5/24 ★". */
function summaryHtml(c: CareerData, book: Book): string {
  const ops = book === "campaign" ? CAMPAIGN : TRIALS;
  const stars = ops.reduce((n, o) => n + starCount(c.ops[o.id]?.stars ?? 0), 0);
  const done = opsCompleted(c, ops);
  return book === "campaign"
    ? tr(`📜 La Campagne de 1900 · <b>${done}/${ops.length}</b> missions · <b>${stars}/${ops.length * 3}</b> ★`, `📜 The 1900 Campaign · <b>${done}/${ops.length}</b> missions · <b>${stars}/${ops.length * 3}</b> ★`)
    : tr(`🎖 Épreuves classiques · <b>${done}/${ops.length}</b> · <b>${stars}/${ops.length * 3}</b> ★`, `🎖 Classic Trials · <b>${done}/${ops.length}</b> · <b>${stars}/${ops.length * 3}</b> ★`);
}

function cardHtml(op: OpDef, c: CareerData): string {
  const locked = !opUnlocked(c, op.id);
  const mask = c.ops[op.id]?.stars ?? 0;
  return `<button class="mapcard opcard${locked ? " locked" : ""}${mask & 1 ? " done" : ""}" data-op="${op.id}">
      <img src="${mapAssetBase(op.map)}/thumb.webp" alt="" draggable="false" />
      <span class="op-n">${opIndex(op.id) + 1}</span>
      <span class="op-ic">${locked ? "🔒" : op.icon}</span>
      <span class="mn">${esc(op.title)}</span>
      <span class="mstars${mask ? " got" : ""}">${locked ? tr("Verrouillée", "Locked") : starRow(mask)}</span>
    </button>`;
}

/** One chapter of the campaign: number, title, the nation played, stars (or the lock). */
function chapterHtml(op: OpDef, c: CareerData): string {
  const locked = !opUnlocked(c, op.id);
  const mask = c.ops[op.id]?.stars ?? 0;
  const nat = op.nations?.player ?? "republique";
  return `<button class="campch${locked ? " locked" : ""}${opCleared(c.ops[op.id]) ? " done" : ""}" data-op="${op.id}">
      <span class="cn">${locked ? "🔒" : opIndex(op.id) + 1}</span>
      <span class="ct">${esc(op.title)}</span>
      <span class="cs"><i class="nat ${nat}">${nat === "empire" ? tr("Empire", "Empire") : tr("République", "Republic")}</i>${locked ? "" : `<span class="stars">${starRow(mask)}</span>`}</span>
    </button>`;
}

function actsHtml(c: CareerData): string {
  return ([1, 2, 3] as const)
    .map((act) => {
      const ops = CAMPAIGN.filter((o) => o.act === act);
      const done = ops.filter((o) => opCleared(c.ops[o.id])).length;
      return `<div class="campact"><h4>${ACT_NAMES[act]}<small>${done}/${ops.length}</small></h4><div class="camprow">${ops.map((o) => chapterHtml(o, c)).join("")}</div></div>`;
    })
    .join("");
}

/**
 * Fill the menu's Ops slots: the tab becomes « 📜 Campagne », with a switch
 * between the campaign (its chapters by act) and the Classique Trials
 * (`#opcards`, map-card style), the progress line `#opsum` and the blurb.
 * Tapping a card selects it; tapping the selected one (or Play) opens its
 * briefing sheet.
 */
export function mountMenuOps(menu: HTMLElement, hooks: { start(op: OpDef): void; selectedId(): string; select(id: string): void }): MenuOps {
  const tab = menu.querySelector<HTMLElement>('[data-m="ops"]');
  if (tab) tab.textContent = tr("📜 Campagne", "📜 Campaign");
  const sum = menu.querySelector<HTMLElement>("#opsum");
  const cards = menu.querySelector<HTMLElement>("#opcards");
  const blurb = menu.querySelector<HTMLElement>("#opblurb");
  // the book switch and the chapter list sit round the Trials' row
  const seg = document.createElement("div");
  seg.className = "seg campseg";
  seg.innerHTML = `<button data-b="campaign">${tr("📜 Campagne", "📜 Campaign")}</button><button data-b="trials">${tr("🎖 Épreuves", "🎖 Trials")}</button>`;
  const acts = document.createElement("div");
  acts.className = "campacts";
  sum?.before(seg);
  cards?.after(acts);
  let career = loadCareer();
  const locked = (op: OpDef) => !opUnlocked(career, op.id);
  /** Default pick in a book: the first open op not yet completed. */
  const fallback = (book: Book) => {
    const ops = book === "campaign" ? CAMPAIGN : TRIALS;
    return ops.find((o) => !locked(o) && !opCleared(career.ops[o.id])) ?? [...ops].reverse().find((o) => !locked(o)) ?? ops[0]!;
  };
  const selected = () => opById(hooks.selectedId()) ?? fallback("campaign");

  const pick = (el: HTMLElement) => {
    const op = opById(el.dataset.op!)!;
    sfx.play("click", 0.5);
    if (selected().id === op.id && !locked(op)) return openBrief(op);
    hooks.select(op.id);
    sync();
  };
  const render = () => {
    career = loadCareer();
    if (cards) {
      cards.innerHTML = TRIALS.map((o) => cardHtml(o, career)).join("");
      cards.querySelectorAll<HTMLElement>(".opcard").forEach((el) => el.addEventListener("click", () => pick(el)));
    }
    acts.innerHTML = actsHtml(career);
    acts.querySelectorAll<HTMLElement>(".campch").forEach((el) => el.addEventListener("click", () => pick(el)));
  };
  seg.querySelectorAll<HTMLElement>("button").forEach((b) =>
    b.addEventListener("click", () => {
      const book = b.dataset.b as Book;
      if (bookName(selected()) === book) return;
      sfx.play("click", 0.5);
      hooks.select(fallback(book).id);
      sync();
    })
  );
  let scrolled = false;
  const sync = () => {
    const sel = selected();
    const book = bookName(sel);
    // (main.ts shows #opsum only on the Ops tab, before calling this)
    const on = !!sum && !sum.hidden;
    seg.hidden = !on;
    acts.hidden = !on || book !== "campaign";
    if (cards) cards.hidden = !on || book !== "trials";
    seg.querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.b === book));
    if (sum) sum.innerHTML = summaryHtml(career, book);
    acts.querySelectorAll<HTMLElement>(".campch").forEach((el) => el.classList.toggle("on", el.dataset.op === sel.id));
    cards?.querySelectorAll<HTMLElement>(".opcard").forEach((el) => {
      const here = el.dataset.op === sel.id;
      el.classList.toggle("on", here);
      // bring the picked card into view (the row scrolls sideways on phones)
      if (here && cards && !scrolled && cards.offsetParent) {
        cards.scrollLeft = Math.max(0, el.offsetLeft - cards.offsetLeft - (cards.clientWidth - el.offsetWidth) / 2);
        scrolled = true;
      }
    });
    if (blurb) {
      const need = opIndex(sel.id) + 1 - (book === "campaign" ? 1 + campaignCompleted(career) : 3 + opsCompleted(career, TRIALS));
      blurb.innerHTML = locked(sel)
        ? book === "campaign"
          ? tr(`🔒 Gagne la mission précédente pour ouvrir <b>${esc(sel.title)}</b>`, `🔒 Win the previous mission to open <b>${esc(sel.title)}</b>`)
          : tr(`🔒 Réussis encore ${need} épreuve${need === 1 ? "" : "s"} pour débloquer <b>${esc(sel.title)}</b>`, `🔒 Complete ${need} more trial${need === 1 ? "" : "s"} to unlock <b>${esc(sel.title)}</b>`)
        : `<b>${esc(sel.tagline)}</b><small>${opKicker(sel)} · ${mapName(sel.map)} · ${enemyLine(sel)}</small>`;
    }
  };

  function openBrief(op: OpDef): void {
    menu.querySelector(".sheet-wrap")?.remove();
    const rec = career.ops[op.id];
    const mask = rec?.stars ?? 0;
    const note = rulesNote(op);
    const camp = isCampaignOp(op);
    const fresh = camp ? CAMPAIGN_UNLOCKS.find((u) => u.op === op.id && op.id !== CAMPAIGN[0]!.id) : null;
    const total = bookOf(op).length;
    const where = () => `${mapName(op.map)}${op.dressing === "paris" ? tr(" — Paris, le Champ-de-Mars", " — Paris, the Champ-de-Mars") : ""} · ${enemyLine(op)}`;
    const wrap = document.createElement("div");
    wrap.className = "sheet-wrap";
    wrap.innerHTML = `<div class="sheet opbrief" role="dialog">
      <div class="ob-head">
        <img src="${mapAssetBase(op.map)}/thumb.webp" alt="" draggable="false"/>
        <div><span class="ob-n">${camp ? tr(`${op.act ? ACT_NAMES[op.act] + " · " : ""}Mission ${opIndex(op.id) + 1} sur ${total}`, `${op.act ? ACT_NAMES[op.act] + " · " : ""}Mission ${opIndex(op.id) + 1} of ${total}`) : tr(`Épreuve ${opIndex(op.id) + 1} sur ${total}`, `Trial ${opIndex(op.id) + 1} of ${total}`)}</span><h2>${op.icon} ${esc(op.title)}</h2>
          <p class="ob-where">${where()}</p></div>
        <button class="sheet-close x" aria-label="${tr("Fermer", "Close")}">✕</button>
      </div>
      <div class="ob-cols">
        <div class="ob-l">
          <p class="ob-brief">${esc(op.brief)}</p>
          <p class="ob-rules">${esc(sideLine(op))}${note ? ` · ${esc(note)}` : ""}</p>
          ${fresh ? `<p class="ob-unlock">${tr(`🔓 Nouveau${fresh.by ? ` (${esc(fresh.by)})` : ""} : <b>${esc(unlockNames(fresh))}</b>`, `🔓 New${fresh.by ? ` (${esc(fresh.by)})` : ""}: <b>${esc(unlockNames(fresh))}</b>`)}</p>` : ""}
          <h3>${tr("Objectif", "Objective")}</h3>
          <p class="ob-obj">${esc(objectiveLine(op))}</p>
        </div>
        <div class="ob-r">
          <h3>${tr("Étoiles", "Stars")} ${mask ? `<small>${tr("record", "best")} ${starRow(mask)}${rec?.bestSecs != null ? ` · ${fmtClock(rec.bestSecs)}` : ""}</small>` : ""}</h3>
          ${starListHtml(op, mask)}
          <p class="ob-tip">💡 ${esc(op.tip)}</p>
        </div>
      </div>
      ${opHasLevel(op) ? levelPickHtml() : ""}
      <div class="sh-actions"><button class="cta" id="ob-start">▶ ${camp ? tr("Lancer la mission", "Start the mission") : tr("Lancer l'épreuve", "Start the trial")}</button></div>
    </div>`;
    menu.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    wrap.querySelector(".sheet-close")?.addEventListener("click", close);
    wrap.querySelectorAll<HTMLElement>(".ob-level button").forEach((b) =>
      b.addEventListener("click", () => {
        const lv = b.dataset.lv as OpLevel;
        if (lv === gameMode.opLevel) return;
        sfx.play("click", 0.5);
        pickOpLevel(lv);
        wrap.querySelectorAll<HTMLElement>(".ob-level button").forEach((n) => n.classList.toggle("on", n.dataset.lv === lv));
        const note = wrap.querySelector<HTMLElement>(".ob-level small");
        if (note) note.textContent = levelNote(lv);
        const at = wrap.querySelector<HTMLElement>(".ob-where");
        if (at) at.innerHTML = where();
        sync();
      })
    );
    wrap.querySelector("#ob-start")?.addEventListener("click", () => hooks.start(op));
  }

  render();
  sync();
  return {
    // (the career only changes after a match, which reloads the page: no re-render needed)
    sync,
    selected,
    locked,
    openBrief
  };
}
