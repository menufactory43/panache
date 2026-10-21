import { DIFFICULTY, STRATEGIES } from "../sim/ai/commander";
import { BUILDINGS, UNITS } from "../sim/balance";
import { MAPS } from "../sim/maps";
import {
  OPS,
  fmtClock,
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
import { GROUND_COMBAT, MUTATORS } from "../sim/rules";
import type { World } from "../sim/types";
import { sfx } from "../game/audio";
import { BELLE_EPOQUE } from "../game/three/theme";
import { mapAssetBase } from "../game/assets";
import { loadCareer, opUnlocked, opsCompleted, settlementOf, starCount, type CareerData } from "../game/career";
import { addReportSection, type ReportContext, type ReportOpts } from "./report";
import { pickMode } from "../game/mode";
import { fullscreen } from "./fullscreen";

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
  if (op.ai === "survival") return "vagues de Survie";
  if (!op.ai) return "une garnison statique";
  const name = STRATEGIES[op.ai.strategy].label;
  return `contre ${name} · ${DIFFICULTY[op.ai.difficulty].label}`;
}

/** "★★☆" for a star mask. */
const starRow = (mask: number) => [1, 2, 4].map((b) => (mask & b ? "★" : "☆")).join("");

/** Star conditions as list items: what each star needs (and which you hold). */
function starListHtml(op: OpDef, mask: number, live?: OpStatus): string {
  const rows: { text: string; cls: string }[] = [{ text: "Réussir l'op", cls: mask & 1 ? "got" : "" }];
  op.stars.forEach((g, i) => {
    const bit = 2 << i;
    const e = live?.stars[i]?.eval;
    const cls = mask & bit ? "got" : e ? (e.state === "failed" ? "lost" : e.state === "done" || e.state === "ok" ? "ok" : "") : "";
    rows.push({ text: goalText(g, true), cls });
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
      return `<li class="${cls}"><em>${goalIcon(g)}</em><span>${esc(goalText(g))}</span>${e ? `<b>${esc(e.value)}</b>` : ""}</li>`;
    })
    .join("")}</ul>`;
}

/** Rules line for the briefing: player bans, frozen income, mutators. */
function rulesNote(op: OpDef): string {
  const bits: string[] = [];
  const bans = op.rules?.playerBans;
  if (bans?.units?.length === Object.keys(UNITS).length && bans.buildings?.length) bits.push("⛔ Aucune production");
  else {
    if (bans?.buildings?.length) bits.push(`⛔ Interdits : ${bans.buildings.map((k) => BUILDINGS[k].name).join(", ")}`);
    // every ground combat kind reads "ground units"; anything else banned (the Condor) is named
    const ground = !!bans?.units && GROUND_COMBAT.every((k) => bans.units!.includes(k));
    const named = (bans?.units ?? []).filter((k) => !ground || !GROUND_COMBAT.includes(k)).map((k) => UNITS[k].name);
    if (bans?.units?.length) bits.push(`⛔ Interdits : ${[...(ground ? ["unités terrestres"] : []), ...named].join(", ")}`);
  }
  if (op.rules?.playerIncome === 0) bits.push("❄ Aucun revenu");
  if (op.rules?.calldowns === false) bits.push("⚡ Aucun appui");
  for (const id of op.rules?.mutators ?? []) bits.push(`${MUTATORS[id].icon} ${MUTATORS[id].name}`);
  return bits.join(" · ");
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
    <div class="oi-head"><em>${op.icon}</em><b>${esc(op.title)}</b><span>Op ${opIndex(op.id) + 1}</span></div>
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
      label = "Détruire le GQG";
      value = timer ? timer.eval.value : main.eval.value;
    }
    const others = st.goals.filter((g) => g !== main && !(main.goal.type === "destroyHq" && g === timer)).map((g) => compact(g.goal, g.eval));
    if (main.goal.type === "destroyHq") {
      // their HQ's health, once we have seen it
      const known = [...w.fog[w.ops!.player].known.values()].some((b) => b.kind === "hq" && b.faction === w.ops!.enemy);
      others.unshift(known ? `GQG ${main.eval.value}` : "GQG non repéré");
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
      actions.push({ id: "op-next", label: `▶ Suivante : ${nxt.title}`, on: () => opts.rematch(`op:${nxt.id}`) });
    return {
      head: {
        title: won ? "OP RÉUSSIE" : "OP ÉCHOUÉE",
        cls: won ? "win" : "lose",
        sub: `Op ${opIndex(op.id) + 1} · ${op.title} · ${mapName(op.map)} · ${fmtClock(r?.secs ?? 0)}`
      },
      actions,
      rematchLabel: won ? "↻ Rejouer" : "↻ Réessayer"
    };
  }

  update();
  return {
    update,
    pauseLine: () => `Op ${opIndex(op.id) + 1} · ${op.title} · ${enemyLine(op)}`,
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
    pauseLine: () => `${op.icon} Instruction · ${op.title}`,
    pauseHtml: () => "",
    reportOpts() {
      const won = !!w.ops?.result?.won;
      return {
        head: {
          title: won ? "INSTRUCTION RÉUSSIE" : "INSTRUCTION",
          cls: won ? "win" : "lose",
          sub: won ? "Tu es prêt, mon commandant !" : op.title
        },
        actions: [
          {
            id: "tuto-skirmish",
            label: "⚔ Escarmouche",
            on: () => {
              // (a first skirmish: the Easy commander, unless one was picked before)
              pickMode("skirmish", true);
              opts.rematch("1");
            }
          },
          {
            id: "tuto-ops",
            label: "🎖 Opérations",
            cls: "alt",
            on: () => {
              pickMode("ops");
              fullscreen.reload();
            }
          }
        ],
        rematchLabel: "↻ Rejouer l'instruction"
      };
    }
  };
}

// -------------------------------------------------------------- end screen ---

function opSectionHtml(ctx: ReportContext): string | null {
  const st = ctx.world.ops;
  const op = st ? opById(st.id) : null;
  if (!st || !op || ctx.spectator) return null;
  if (op.tutorial) return tutorialSectionHtml(st.result?.won ?? false);
  const r = st.result;
  const s = settlementOf(ctx.world);
  const mask = r?.stars ?? 0;
  const before = s?.op?.starsBefore ?? 0;
  const stars = [1, 2, 4]
    .map((b, i) => `<i class="${mask & b ? "on" : ""}${mask & b && !(before & b) ? " new" : ""}" style="--i:${i}">${mask & b ? "★" : "☆"}</i>`)
    .join("");
  const best = s?.op ? s.op.starsAfter : mask;
  const rec = loadCareer().ops[op.id];
  const bestLine =
    rec && (rec.stars & 1)
      ? `<p class="op-best">Record ${starRow(best)}${rec.bestSecs !== null ? ` · ${fmtClock(rec.bestSecs)}` : ""} · ${rec.plays} tentative${rec.plays === 1 ? "" : "s"}</p>`
      : "";
  const unlocked = s?.op?.unlocked ? opById(s.op.unlocked) : null;
  return `<div class="op-res ${r?.won ? "won" : "lost"}">
    <div class="op-bigstars">${stars}</div>
    <p class="op-reason">${esc(r?.reason ?? "")}</p>
    ${starListHtml(op, mask)}
    ${bestLine}
    ${unlocked ? `<p class="op-unlock">🔓 Nouvelle op débloquée : <b>${unlocked.icon} ${esc(unlocked.title)}</b></p>` : ""}
    ${r?.won ? "" : `<p class="op-tip"><b>Conseil</b><span>${esc(op.tip)}</span></p>`}
  </div>`;
}

/** The Instruction's end: three stars, the send-off, and what to play next. */
function tutorialSectionHtml(won: boolean): string | null {
  if (!won) return null;
  const stars = [0, 1, 2].map((i) => `<i class="on new" style="--i:${i}">★</i>`).join("");
  return `<div class="op-res won tuto-res">
    <div class="op-bigstars">${stars}</div>
    <p class="op-reason">Instruction terminée</p>
    <ul class="op-starlist"><li class="got"><b>★</b><span>Caméra, ordres et combat</span></li><li class="got"><b>★★</b><span>Forges et production</span></li><li class="got"><b>★★★</b><span>Armée, charbon et Feu roulant</span></li></ul>
    <p class="op-tip"><b>Et maintenant ?</b><span>Une Escarmouche contre l'IA, ou la campagne des Opérations.</span></p>
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

/** "🎖 Ops · 7/24 ★ · 4 of 8 open" */
function summaryHtml(c: CareerData): string {
  const stars = OPS.reduce((n, o) => n + starCount(c.ops[o.id]?.stars ?? 0), 0);
  const done = opsCompleted(c);
  return `🎖 <b>${done}/${OPS.length}</b> terminées · <b>${stars}/${OPS.length * 3}</b> ★`;
}

function cardHtml(op: OpDef, c: CareerData): string {
  const locked = !opUnlocked(c, op.id);
  const mask = c.ops[op.id]?.stars ?? 0;
  return `<button class="mapcard opcard${locked ? " locked" : ""}${mask & 1 ? " done" : ""}" data-op="${op.id}">
      <img src="${mapAssetBase(op.map)}/thumb.webp" alt="" draggable="false" />
      <span class="op-n">${opIndex(op.id) + 1}</span>
      <span class="op-ic">${locked ? "🔒" : op.icon}</span>
      <span class="mn">${esc(op.title)}</span>
      <span class="mstars${mask ? " got" : ""}">${locked ? "Verrouillée" : starRow(mask)}</span>
    </button>`;
}

/**
 * Fill the menu's Ops slots: `#opsum` (progress line) and `#opcards` (one
 * card per op, map-card style). Tapping a card selects it; tapping the
 * selected one (or Play) opens its briefing sheet.
 */
export function mountMenuOps(menu: HTMLElement, hooks: { start(op: OpDef): void; selectedId(): string; select(id: string): void }): MenuOps {
  const sum = menu.querySelector<HTMLElement>("#opsum");
  const cards = menu.querySelector<HTMLElement>("#opcards");
  const blurb = menu.querySelector<HTMLElement>("#opblurb");
  let career = loadCareer();
  const locked = (op: OpDef) => !opUnlocked(career, op.id);
  /** Default pick: the first open op not yet completed. */
  const fallback = () => OPS.find((o) => !locked(o) && !((career.ops[o.id]?.stars ?? 0) & 1)) ?? OPS[0]!;
  const selected = () => opById(hooks.selectedId()) ?? fallback();

  const render = () => {
    career = loadCareer();
    if (sum) sum.innerHTML = summaryHtml(career);
    if (cards) {
      cards.innerHTML = OPS.map((o) => cardHtml(o, career)).join("");
      cards.querySelectorAll<HTMLElement>(".opcard").forEach((el) =>
        el.addEventListener("click", () => {
          const op = opById(el.dataset.op!)!;
          sfx.play("click", 0.5);
          if (selected().id === op.id && !locked(op)) return openBrief(op);
          hooks.select(op.id);
          sync();
        })
      );
    }
  };
  let scrolled = false;
  const sync = () => {
    const sel = selected();
    cards?.querySelectorAll<HTMLElement>(".opcard").forEach((el) => {
      const on = el.dataset.op === sel.id;
      el.classList.toggle("on", on);
      // bring the picked card into view (the row scrolls sideways on phones)
      if (on && cards && !scrolled && cards.offsetParent) {
        cards.scrollLeft = Math.max(0, el.offsetLeft - cards.offsetLeft - (cards.clientWidth - el.offsetWidth) / 2);
        scrolled = true;
      }
    });
    if (blurb) {
      const need = opIndex(sel.id) + 1 - 3 - opsCompleted(career);
      blurb.innerHTML = locked(sel)
        ? `🔒 Réussis encore ${need} op${need === 1 ? "" : "s"} pour débloquer <b>${esc(sel.title)}</b>`
        : `<b>${esc(sel.tagline)}</b><small>${mapName(sel.map)} · ${enemyLine(sel)}</small>`;
    }
  };

  function openBrief(op: OpDef): void {
    menu.querySelector(".sheet-wrap")?.remove();
    const rec = career.ops[op.id];
    const mask = rec?.stars ?? 0;
    const note = rulesNote(op);
    const wrap = document.createElement("div");
    wrap.className = "sheet-wrap";
    wrap.innerHTML = `<div class="sheet opbrief" role="dialog">
      <div class="ob-head">
        <img src="${mapAssetBase(op.map)}/thumb.webp" alt="" draggable="false"/>
        <div><span class="ob-n">Op ${opIndex(op.id) + 1} sur ${OPS.length}</span><h2>${op.icon} ${esc(op.title)}</h2>
          <p class="ob-where">${mapName(op.map)} · ${enemyLine(op)}</p></div>
        <button class="sheet-close x" aria-label="Fermer">✕</button>
      </div>
      <div class="ob-cols">
        <div class="ob-l">
          <p class="ob-brief">${esc(op.brief)}</p>
          ${note ? `<p class="ob-rules">${esc(note)}</p>` : ""}
          <h3>Objectif</h3>
          <p class="ob-obj">${esc(objectiveLine(op))}</p>
        </div>
        <div class="ob-r">
          <h3>Étoiles ${mask ? `<small>record ${starRow(mask)}${rec?.bestSecs != null ? ` · ${fmtClock(rec.bestSecs)}` : ""}</small>` : ""}</h3>
          ${starListHtml(op, mask)}
          <p class="ob-tip">💡 ${esc(op.tip)}</p>
        </div>
      </div>
      <div class="sh-actions"><button class="cta" id="ob-start">▶ Lancer l'op</button></div>
    </div>`;
    menu.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    wrap.querySelector(".sheet-close")?.addEventListener("click", close);
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
