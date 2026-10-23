import { DIFFICULTY, STRATEGIES, type Difficulty } from "../sim/ai/commander";
import { AWARDS, MEDALS, MEDAL_IDS, type MedalId } from "../sim/awards";
import { MAPS, mapById, mapBansMutator } from "../sim/maps";
import { isRandomMapId } from "../sim/mapgen";
import { MUTATORS, MUTATOR_IDS, bannedBy, rulesOf, toggleMutator, type MutatorId } from "../sim/rules";
import type { BuildingKind, Faction, UnitKind, World } from "../sim/types";
import { sfx } from "../game/audio";
import { mapAssetBase } from "../game/assets";
import { OPS, fmtClock } from "../sim/ops";
import {
  RANKS,
  STAR_LABELS,
  starLabelsFor,
  currentStreak,
  opsCompleted,
  loadCareer,
  medalsOf,
  rankOf,
  recordKey,
  settlementOf,
  starCount,
  type CareerData,
  type Settlement
} from "../game/career";
import { dailyOp, today, type DailyOp } from "../game/daily";
import { gameMode } from "../game/mode";
import { PLAYER } from "../game/controller";
import { loadBest } from "../game/survival";
import { addReportSection, type ReportContext } from "./report";
import { tr } from "../lang";

/**
 * Career UI: the menu's rank badge, Daily Op card and mutator picker, the
 * Career sheet (medals, map stars, Last Stand bests), and the end-screen
 * block that animates the XP bar, celebrates rank-ups and pops medals in.
 * Data and math live in src/game/career.ts; nothing here touches the sim.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
/** A map's name (built-in or generated); an id this build doesn't know stays as is (mapById would fall back to the first map). */
const mapName = (id: string) => {
  const def = mapById(id);
  return def.id === id ? def.name : id;
};
const diffName = (d: string) => DIFFICULTY[d as Difficulty]?.label ?? d;

// --------------------------------------------------------------- insignia ---

function starPath(cx: number, cy: number, r: number): string {
  let d = "";
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    d += `${i === 0 ? "M" : "L"}${(cx + Math.cos(a) * rr).toFixed(2)},${(cy + Math.sin(a) * rr).toFixed(2)}`;
  }
  return `${d}Z`;
}

/** A rank's shoulder badge: chevrons (enlisted), bars (officers), stars (command). */
export function insigniaSvg(index: number): string {
  const tier = index <= 3 ? "enl" : index <= 5 ? "off" : "cmd";
  const col = tier === "enl" ? "#e0a75e" : tier === "off" ? "#d5deec" : "#ffd66e";
  let inner = "";
  if (index === 0) inner = `<circle cx="20" cy="20" r="4" fill="${col}"/>`;
  else if (index <= 3)
    for (let i = 0; i < index; i++) {
      const y = 12 + i * 6.5 + (3 - index) * 3.2;
      inner += `<path d="M11 ${y} L20 ${y + 6} L29 ${y}" fill="none" stroke="${col}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  else if (index <= 5)
    for (let i = 0; i < index - 3; i++) {
      const y = (index === 4 ? 18 : 14.5) + i * 7;
      inner += `<rect x="12" y="${y}" width="16" height="4" rx="1.2" fill="${col}"/>`;
    }
  else {
    const n = index - 5;
    const spots: [number, number, number][][] = [
      [[20, 20, 8.5]],
      [[13.5, 20, 6], [26.5, 20, 6]],
      [[11.5, 22, 5], [20, 15.5, 5], [28.5, 22, 5]],
      [[14, 15, 5], [26, 15, 5], [14, 26, 5], [26, 26, 5]]
    ];
    for (const [x, y, r] of spots[n - 1]!) inner += `<path d="${starPath(x, y, r)}" fill="${col}"/>`;
  }
  return `<svg class="insignia ${tier}" viewBox="0 0 40 40" aria-hidden="true">
    <path d="M20 2 L36 8 V20 C36 30 28.5 35.5 20 38.5 C11.5 35.5 4 30 4 20 V8 Z" class="ins-shield"/>${inner}</svg>`;
}

/** "★★☆" for a star bitmask. */
export function starsText(mask: number): string {
  return [1, 2, 4].map((b) => (mask & b ? "★" : "☆")).join("");
}

// ------------------------------------------------------------------- menu ---

function rankBadgeHtml(c: CareerData): string {
  const r = rankOf(c.xp);
  const medals = MEDAL_IDS.reduce((n, id) => n + (c.medals[id] ? 1 : 0), 0);
  const xpLine = r.next === null ? tr(`${fmt(c.xp)} XP · grade max`, `${fmt(c.xp)} XP · top rank`) : `${fmt(c.xp)} / ${fmt(r.next)} XP`;
  return `${insigniaSvg(r.index)}
    <span class="rb-t"><b>${r.name}</b><span class="rb-xp">${xpLine}</span></span>
    <span class="rb-medals" title="${tr("Médailles obtenues", "Medals earned")}">🏅 ${medals}/${MEDAL_IDS.length}</span>
    <span class="rb-bar"><i style="width:${(r.progress * 100).toFixed(1)}%"></i></span>`;
}

function dailyHtml(op: DailyOp, c: CareerData): string {
  const day = today();
  const streak = currentStreak(c, day);
  const wonToday = c.daily.lastWin === op.day;
  const muts = op.mutators.map((id) => `<span class="dl-mut">${MUTATORS[id].icon} ${MUTATORS[id].name}</span>`).join("");
  return `
    <div class="dl-head">
      <span class="dl-tag">${tr(`📅 Op du jour n°${op.number}`, `📅 Daily Op #${op.number}`)}</span>
      <span class="dl-date">${op.label}</span>
      <span class="dl-streak${streak > 0 ? " hot" : ""}" title="${tr("Série de victoires (Op du jour)", "Winning streak (Daily Op)")}">🔥 ${streak}</span>
    </div>
    <div class="dl-body">
      <img src="${mapAssetBase(op.mapId)}/thumb.webp" alt="" draggable="false"/>
      <div class="dl-what">
        <b>${mapName(op.mapId)}</b>
        <span class="dl-vs">${tr("contre", "vs")} ${STRATEGIES[op.strategy].label} · <i class="${op.difficulty}">${diffName(op.difficulty)}</i></span>
      </div>
      <button class="dl-play${wonToday ? " done" : ""}" id="dl-play">${wonToday ? tr("✓ Gagné<small>rejouer</small>", "✓ Won<small>replay</small>") : tr("▶ Jouer", "▶ Play")}</button>
      <span class="dl-muts">${muts}</span>
    </div>`;
}

function mutButtonHtml(): string {
  const on = gameMode.mutators;
  if (on.length === 0) return `<span class="mb-k">${tr("🧪 Mutateurs", "🧪 Mutators")}</span><span class="mb-v">${tr("Non", "No")}</span>`;
  // (one the picked map can't be played with is left out of its matches: struck through)
  const def = mapById(gameMode.mapId);
  const names = on
    .map((id) => (mapBansMutator(def, id) ? `<s>${MUTATORS[id].icon} ${MUTATORS[id].name}</s>` : `${MUTATORS[id].icon} ${MUTATORS[id].name}`))
    .join(" · ");
  const live = on.some((id) => !mapBansMutator(def, id));
  return `<span class="mb-k">🧪</span><span class="mb-v on">${names}</span>${live ? `<span class="mb-n">${tr("sans étoiles", "no stars")}</span>` : ""}`;
}

export interface MenuCareer {
  /** Re-render after the mode/map/difficulty changed. */
  sync(): void;
  /** Stars badge text for a map card (skirmish, selected difficulty). */
  starsFor(mapId: string): number;
}

/**
 * Fill the menu's career slots: `#rankbadge`, `#dailyop`, and every
 * `.mutbtn` (one sits in the main column, a twin in the landscape side panel).
 */
export function mountMenuCareer(menu: HTMLElement, hooks: { playDaily(op: DailyOp): void; changed(): void }): MenuCareer {
  let career = loadCareer();
  const op = dailyOp(today());
  const badge = menu.querySelector<HTMLElement>("#rankbadge");
  const daily = menu.querySelector<HTMLElement>("#dailyop");
  const mutBtns = [...menu.querySelectorAll<HTMLElement>(".mutbtn")];

  const sync = () => {
    career = loadCareer();
    if (badge) badge.innerHTML = rankBadgeHtml(career);
    for (const b of mutBtns) {
      b.innerHTML = mutButtonHtml();
      b.classList.toggle("on", gameMode.mutators.length > 0);
      b.hidden = gameMode.mode !== "skirmish";
    }
  };
  if (daily) {
    daily.innerHTML = dailyHtml(op, career);
    daily.querySelector("#dl-play")?.addEventListener("click", () => hooks.playDaily(op));
  }
  badge?.addEventListener("click", () => {
    sfx.play("click", 0.5);
    showCareerSheet(menu, career);
  });
  for (const b of mutBtns)
    b.addEventListener("click", () => {
      sfx.play("click", 0.5);
      showMutatorSheet(menu, () => {
        sync();
        hooks.changed();
      });
    });
  sync();
  return {
    sync,
    starsFor: (mapId) => career.stars[recordKey(mapId, gameMode.difficulty)] ?? 0
  };
}

export function openSheet(host: HTMLElement, cls: string, html: string): HTMLElement {
  host.querySelector(".sheet-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  wrap.innerHTML = `<div class="sheet ${cls}" role="dialog">${html}</div>`;
  host.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });
  wrap.querySelectorAll(".sheet-close").forEach((b) => b.addEventListener("click", close));
  return wrap;
}

/** Mutator picker: tap chips to toggle; applies to Skirmish (and AI vs AI). */
export function showMutatorSheet(host: HTMLElement, onDone: () => void): void {
  const def = mapById(gameMode.mapId);
  const chips = MUTATOR_IDS.map((id) => {
    const m = MUTATORS[id];
    const on = gameMode.mutators.includes(id);
    const why = mapBansMutator(def, id);
    return `<button class="mutchip${on ? " on" : ""}${why ? " blocked" : ""}" data-id="${id}" aria-pressed="${on}">
      <em>${m.icon}</em><b>${m.name}</b><small>${why ?? m.desc}</small></button>`;
  }).join("");
  const wrap = openSheet(
    host,
    "mutsheet",
    `<h2>${tr("🧪 Mutateurs", "🧪 Mutators")}</h2>
     <p class="sh-sub">${tr("Change les règles de ta prochaine escarmouche. Les deux camps les subissent.", "Change the rules of your next skirmish. Both sides are subject to them.")}</p>
     <div class="mutgrid">${chips}</div>
     <p class="sh-note">${tr("Les parties mutées rapportent XP et médailles, mais pas d'étoiles de carte.", "Mutated matches earn XP and medals, but no map stars.")}</p>
     <div class="sh-actions"><button class="cta alt" id="mut-clear">${tr("Tout retirer", "Clear all")}</button><button class="cta sheet-close" id="mut-done">OK</button></div>`
  );
  const refresh = () =>
    wrap.querySelectorAll<HTMLElement>(".mutchip").forEach((el) => {
      const on = gameMode.mutators.includes(el.dataset.id as MutatorId);
      el.classList.toggle("on", on);
      el.setAttribute("aria-pressed", String(on));
    });
  wrap.querySelectorAll<HTMLElement>(".mutchip").forEach((el) =>
    el.addEventListener("click", () => {
      // (can't be played on the picked map: it may be switched off, never on)
      if (el.classList.contains("blocked") && !gameMode.mutators.includes(el.dataset.id as MutatorId)) return;
      gameMode.mutators = toggleMutator(gameMode.mutators, el.dataset.id as MutatorId);
      sfx.play("click", 0.5);
      refresh();
      onDone();
    })
  );
  wrap.querySelector("#mut-clear")!.addEventListener("click", () => {
    gameMode.mutators = [];
    refresh();
    onDone();
  });
}

/** The Career sheet: rank ladder, medals, map stars, Last Stand bests, Daily streak. */
export function showCareerSheet(host: HTMLElement, c: CareerData = loadCareer()): void {
  const r = rankOf(c.xp);
  const day = today();
  const diffs = Object.keys(DIFFICULTY) as Difficulty[];
  const medalCells = MEDAL_IDS.map((id) => {
    const m = MEDALS[id];
    const n = c.medals[id] ?? 0;
    return `<div class="medalcell${n ? " got" : ""}"><em>${m.icon}</em><b>${m.name}</b><small>${m.desc}</small>${n ? `<span class="cnt">×${n}</span>` : ""}</div>`;
  }).join("");
  // (built-in maps only: the total is out of MAPS.length × 9)
  const totalStars = Object.entries(c.stars).reduce((s, [k, m]) => s + (isRandomMapId(k) ? 0 : starCount(m)), 0);
  // maps with their own ★★ time (the Archipelago: 12:00)
  const ownTimes = MAPS.filter((m) => m.starSecs !== undefined)
    .map((m) => tr(` (${starLabelsFor(m.id)[1]!.replace(/^\D*/, "")} sur ${m.name})`, ` (${starLabelsFor(m.id)[1]!.replace(/^\D*/, "")} on ${m.name})`))
    .join("");
  const starRows = MAPS.map(
    (m) => `<tr><td>${m.name}</td>${diffs
      .map((d) => {
        const mask = c.stars[recordKey(m.id, d)] ?? 0;
        return `<td class="st${mask ? " got" : ""}">${starsText(mask)}</td>`;
      })
      .join("")}</tr>`
  ).join("");
  const lsRows = MAPS.filter((m) => m.lastStand !== false).map(
    (m) => `<tr><td>${m.name}</td>${diffs
      .map((d) => {
        const b = loadBest(m.id, d);
        return `<td>${b ? `🛡 ${b.best}` : "—"}</td>`;
      })
      .join("")}</tr>`
  ).join("");
  const ladder = RANKS.map(
    (k, i) => `<li class="${i < r.index ? "past" : i === r.index ? "now" : ""}">${insigniaSvg(i)}<span>${k.name}</span><small>${fmt(k.xp)}</small></li>`
  ).join("");
  openSheet(
    host,
    "careersheet",
    `<div class="cs-head">${insigniaSvg(r.index)}
       <div><h2>${r.name}</h2>
         <p class="cs-xp">${fmt(c.xp)} XP${r.next !== null ? ` · ${tr(`${fmt(r.next - c.xp)} avant ${r.nextName}`, `${fmt(r.next - c.xp)} to ${r.nextName}`)}` : tr(" · grade max", " · top rank")}</p>
         <div class="rb-bar big"><i style="width:${(r.progress * 100).toFixed(1)}%"></i></div></div>
       <button class="sheet-close x" aria-label="${tr("Fermer", "Close")}">✕</button></div>
     <div class="cs-stats">
       <span><b>${c.wins}</b>${tr("victoires", "victories")}</span><span><b>${c.losses}</b>${tr("défaites", "defeats")}</span>
       <span><b>${totalStars}</b>/${MAPS.length * 9} ${tr("étoiles", "stars")}</span>
       <span><b>🔥 ${currentStreak(c, day)}</b>${tr(`série quotidienne${c.daily.bestStreak > 1 ? ` (record ${c.daily.bestStreak})` : ""}`, `daily streak${c.daily.bestStreak > 1 ? ` (best ${c.daily.bestStreak})` : ""}`)}</span>
     </div>
     <h3>${tr("Opérations", "Operations")} <small>${opsCompleted(c)}/${OPS.length} ${tr("terminées", "completed")}</small></h3>
     <table class="cs-table">${OPS.map((o) => {
       const r = c.ops[o.id];
       return `<tr><td>${o.icon} ${o.title}</td><td class="st${r?.stars ? " got" : ""}">${starsText(r?.stars ?? 0)}</td><td>${r?.bestSecs != null ? fmtClock(r.bestSecs) : "—"}</td></tr>`;
     }).join("")}</table>
     <h3>${tr("Médailles", "Medals")}</h3><div class="medalgrid">${medalCells}</div>
     <h3>${tr("Étoiles de carte", "Map stars")} <small>${STAR_LABELS.map((l, i) => `${"★".repeat(i + 1)} ${l.toLowerCase()}${i === 1 ? ownTimes : ""}`).join(" · ")}</small></h3>
     <table class="cs-table"><tr><th></th>${diffs.map((d) => `<th>${diffName(d)}</th>`).join("")}</tr>${starRows}</table>
     <h3>${tr("Records de Survie", "Last Stand records")} <small>${tr(`${c.laststand.runs} partie${c.laststand.runs === 1 ? "" : "s"} · ${fmt(c.laststand.waves)} vagues au total`, `${c.laststand.runs} match${c.laststand.runs === 1 ? "" : "es"} · ${fmt(c.laststand.waves)} waves in total`)}</small></h3>
     <table class="cs-table"><tr><th></th>${diffs.map((d) => `<th>${diffName(d)}</th>`).join("")}</tr>${lsRows}</table>
     <h3>Grades</h3><ol class="ladder">${ladder}</ol>
     <p class="sh-note">${tr("XP : victoire 100 · défaite 30 (× Facile 1 / Normal 1,5 / Difficile 2,2) · 25 par médaille · Survie 10 par vague · Op du jour gagnée +100 · Opérations 60 par réussite, +100 la première fois, +40 par nouvelle étoile. Les parties en spectateur ne comptent pas.", "XP: victory 100 · defeat 30 (× Easy 1 / Normal 1.5 / Hard 2.2) · 25 per medal · Last Stand 10 per wave · Daily Op won +100 · Operations 60 per success, +100 the first time, +40 per new star. Spectated matches don't count.")}</p>
     <div class="sh-actions"><button class="cta sheet-close">${tr("Fermer", "Close")}</button></div>`
  );
}

// ------------------------------------------------------------- end screen ---

/** "📅 Daily Op #12 · 💥 Glass Cannons · ⚡ Blitz" (or "" for a classic match). */
export function rulesLine(w: World): string {
  const parts: string[] = [];
  const d = gameMode.daily;
  if (d) parts.push(tr(`📅 Op du jour n°${d.number}`, `📅 Daily Op #${d.number}`));
  for (const id of rulesOf(w).mutators) parts.push(`${MUTATORS[id].icon} ${MUTATORS[id].name}`);
  return parts.join(" · ");
}

/** Build buttons: a kind the mutators disable shows ⛔ rather than the tech lock. */
export function markBanned(lock: HTMLElement, w: World, kind: UnitKind | BuildingKind): void {
  const icon = bannedBy(w, kind, PLAYER) ? "⛔" : "🔒";
  if (lock.textContent !== icon) lock.textContent = icon;
}

/** For the pause screen: the active rules, if any. */
export function pauseRulesHtml(w: World): string {
  const line = rulesLine(w);
  return line ? `<p class="rulesline">${esc(line)}</p>` : "";
}

function medalChip(id: MedalId, i: number, first: boolean, side?: Faction): string {
  const m = MEDALS[id];
  return `<span class="medal${side ? ` ${side}` : ""}" style="--i:${i}" title="${esc(m.desc)}"><em>${m.icon}</em><span><b>${m.name}</b><small>${m.desc}</small></span>${first ? `<i class="md-new">${tr("NOUVEAU", "NEW")}</i>` : ""}</span>`;
}

/** With nothing earned, name the next goal. */
function noMedalLine(s: Settlement): string {
  const waves = s.result.waves ?? 0;
  if (s.result.kind === "survival") {
    const next = waves < AWARDS.holdoutWaves ? MEDALS.holdout : waves < AWARDS.unbreakableWaves ? MEDALS.unbreakable : null;
    if (next) return tr(`Prochaine médaille : ${next.icon} ${next.name} — ${next.desc.replace(/^[^:]*:\s*/, "")}`, `Next medal: ${next.icon} ${next.name} — ${next.desc.replace(/^[^:]*:\s*/, "")}`);
  }
  return tr("Aucune médaille cette fois — la fiche Carrière liste les objectifs.", "No medals this time — the Career sheet lists the goals.");
}

/** The career block: XP gained and the bar, medals, stars, streak. */
export function careerBlockHtml(s: Settlement, rules: string): string {
  const r0 = s.rankBefore;
  const res = s.result;
  const lines = s.lines.map((l) => `<span>${esc(l.label)} <b>+${l.xp}</b></span>`).join("");
  const medals = s.medals.length
    ? `<div class="cr-medals">${s.medals.map((id, i) => medalChip(id, i, s.firstMedals.includes(id))).join("")}</div>`
    : res.kind === "op"
      ? "" // ops earn stars, not medals
      : `<p class="cr-none">${noMedalLine(s)}</p>`;
  let stars = "";
  if (res.kind === "skirmish") {
    const where = `${mapName(res.mapId)} · ${diffName(res.difficulty)}`;
    if (res.mutators.length > 0 || res.daily !== null) stars = `<p class="cr-stars dim">${tr("Partie mutée : pas d'étoiles de carte", "Mutated match: no map stars")}</p>`;
    else if (isRandomMapId(res.mapId)) stars = `<p class="cr-stars dim">${esc(where)} · ${tr("carte générée : pas d'étoiles de carte", "generated map: no map stars")}</p>`;
    else {
      const gained = s.starsAfter & ~s.starsBefore;
      const labels = starLabelsFor(res.mapId);
      const cells = [1, 2, 4]
        .map((b, i) => `<i class="${s.starsAfter & b ? "on" : ""}${gained & b ? " new" : ""}" title="${labels[i]}">${s.starsAfter & b ? "★" : "☆"}</i>`)
        .join("");
      const note = gained ? labels.filter((_, i) => gained & (1 << i)).join(" · ") : "";
      stars = `<p class="cr-stars"><span class="cr-st">${cells}</span><span>${where}${note ? tr(` <em>Nouveau : ${note.toLowerCase()}</em>`, ` <em>New: ${note.toLowerCase()}</em>`) : ""}</span></p>`;
    }
  }
  const daily = s.daily
    ? `<p class="cr-daily">${s.daily.won ? tr(`🔥 Série quotidienne <b>${s.daily.streak}</b>${s.daily.firstWinToday ? "" : " · déjà gagnée aujourd'hui"}`, `🔥 Daily streak <b>${s.daily.streak}</b>${s.daily.firstWinToday ? "" : " · already won today"}`) : tr(`Op du jour n°${s.daily.number} : réessaie — l'op reste ouverte jusqu'à minuit`, `Daily Op #${s.daily.number}: try again — the op stays open until midnight`)}</p>`
    : "";
  return `${rules ? `<p class="cr-rules">${esc(rules)}</p>` : ""}
    <div class="cr-xp">
      <span class="cr-ins">${insigniaSvg(r0.index)}</span>
      <div class="cr-mid">
        <div class="cr-top"><b class="cr-rank">${r0.name}</b><span class="cr-gain">+<span class="n">0</span> XP</span></div>
        <div class="rb-bar cr-bar"><i style="width:${(r0.progress * 100).toFixed(1)}%"></i></div>
        <div class="cr-lines">${lines}</div>
      </div>
      <span class="cr-promo" hidden></span>
    </div>
    ${medals}${stars}${daily}`;
}

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Animate the block: count the XP up, fill the bar, celebrate a promotion, pop medals in. */
export function mountCareerBlock(el: HTMLElement, s: Settlement, startDelay = 500): void {
  const bar = el.querySelector<HTMLElement>(".cr-bar i");
  const gain = el.querySelector<HTMLElement>(".cr-gain .n");
  const xpBox = el.querySelector<HTMLElement>(".cr-xp");
  if (!bar || !gain || !xpBox) return;
  const after = s.rankAfter;
  const finish = () => {
    gain.textContent = fmt(s.gained);
    bar.style.transition = "none";
    bar.style.width = `${(after.progress * 100).toFixed(1)}%`;
  };
  // (Rematch and Main menu reload the page, so pending timers need no cleanup)
  const at = (ms: number, fn: () => void) => window.setTimeout(() => el.isConnected && fn(), ms);
  if (reduced()) {
    finish();
    if (s.rankedUp) promote();
  } else {
    // count up while the bar fills
    const t0 = performance.now() + startDelay;
    const dur = 1100;
    const tick = () => {
      if (!el.isConnected) return;
      const k = Math.max(0, Math.min(1, (performance.now() - t0) / dur));
      gain.textContent = fmt(s.gained * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    at(startDelay, () => {
      bar.style.transition = `width ${s.rankedUp ? 0.8 : 1.1}s cubic-bezier(0.3, 0.7, 0.3, 1)`;
      bar.style.width = s.rankedUp ? "100%" : `${(after.progress * 100).toFixed(1)}%`;
    });
    if (s.rankedUp)
      at(startDelay + 850, () => {
        promote();
        bar.style.transition = "none";
        bar.style.width = "0%";
        void bar.offsetWidth;
        bar.style.transition = "width 0.9s cubic-bezier(0.3, 0.7, 0.3, 1)";
        bar.style.width = `${(after.progress * 100).toFixed(1)}%`;
      });
  }
  // medals pop in one by one after the bar
  const medals = [...el.querySelectorAll<HTMLElement>(".cr-medals .medal")];
  const medalStart = startDelay + (s.rankedUp ? 1800 : 1150);
  medals.forEach((m, i) => {
    m.style.setProperty("--md", `${medalStart + i * 380}ms`);
    if (!reduced()) at(medalStart + i * 380, () => sfx.play(i === medals.length - 1 ? "rank" : "click", 0.7));
  });
  el.querySelectorAll<HTMLElement>(".cr-stars i.new").forEach((st, i) =>
    st.style.setProperty("--md", `${medalStart + medals.length * 380 + i * 250}ms`)
  );

  function promote(): void {
    const ins = el.querySelector<HTMLElement>(".cr-ins");
    const name = el.querySelector<HTMLElement>(".cr-rank");
    const promo = el.querySelector<HTMLElement>(".cr-promo");
    if (ins) ins.innerHTML = insigniaSvg(after.index);
    if (name) name.textContent = after.name;
    if (promo) {
      promo.hidden = false;
      promo.textContent = tr("PROMU", "PROMOTED");
    }
    xpBox!.classList.add("promoted");
    sfx.play("victory", 0.6);
  }
}

/** Spectator: what each commander earned, plus the rules in play. */
function spectatorHtml(w: World, rules: string): string | null {
  const rows = (["blue", "red"] as Faction[])
    .map((f) => {
      const ids = medalsOf(w, f);
      if (!ids.length) return "";
      return `<div class="cr-side ${f}"><span class="cr-sl">${f === "blue" ? tr("Bleu", "Blue") : tr("Rouge", "Red")}</span><div class="cr-medals">${ids
        .map((id, i) => medalChip(id, i, false))
        .join("")}</div></div>`;
    })
    .join("");
  if (!rows && !rules) return null;
  return `${rules ? `<p class="cr-rules">${esc(rules)}</p>` : ""}${rows}`;
}

function renderSection(ctx: ReportContext): string | null {
  const rules = rulesLine(ctx.world);
  if (ctx.spectator) return spectatorHtml(ctx.world, rules);
  const s = settlementOf(ctx.world);
  if (!s) return rules ? `<p class="cr-rules">${esc(rules)}</p>` : null;
  return careerBlockHtml(s, rules);
}

// the after-action report gets the career block right under the headline
addReportSection({
  id: "career",
  order: 5,
  col: "left",
  render: renderSection,
  mount(el, ctx) {
    const s = ctx.spectator ? null : settlementOf(ctx.world);
    if (s) mountCareerBlock(el, s, 700);
    else el.querySelectorAll<HTMLElement>(".medal").forEach((m, i) => m.style.setProperty("--md", `${600 + i * 200}ms`));
  }
});
