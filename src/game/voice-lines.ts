/**
 * The announcer's phrase book (Panache): every line the radio can say, built
 * from the same tables the callouts use (unit and building names, their
 * gender and number, power names, op titles, wave names…), so the recorded
 * voice can't drift from the game text. tools/voice-manifest.ts exports it
 * to public/assets/voice/manifest.json and tools/voice-generate.py records
 * one clip per entry (OpenAI TTS); tests/voice-pack.test.ts checks every
 * entry has its clip and every line the game says is covered.
 *
 * Two kinds of entries:
 *  - whole lines ("Notre base est attaquée", "Creusot ennemi détruit"), the
 *    usual case: one clip, one breath;
 *  - fragments, for the few templates whose combinations would run into
 *    hundreds of clips (spectator kill banners, promotions, several Goliath
 *    systems at once, "… par un Feu roulant"): the player strings them
 *    together back to back (planVoice()).
 *
 * Lines the book can't cover (a commander's free text, "Op du jour n°12",
 * a Last Stand past wave 30) fall back to the browser's speech synthesis.
 */
import { BUILDINGS, UNITS } from "../sim/balance";
import { agree, displayName } from "../sim/lexicon";
import { OPENERS, OPENER_IDS } from "../sim/openers";
import { OPS } from "../sim/ops";
import { POWER_NAMES } from "../sim/powers";
import { THEME_NAMES } from "../sim/modes/survival";
import type { BuildingKind, Faction, GoliathWeapon, NationOrClassic, PowerKind, UnitKind } from "../sim/types";
import type { AnnounceTone } from "./announce";
import { powerPhrase } from "./calldown-credit";
import { CALLOUTS, GOLIATH_WORD, SHORT, SIDE, ZENITH_WORD, eliteLabel, enemyDestroyed, listWords, speakable, unitLost, zenithLine } from "./callouts";
import { finaleBanner } from "./finale";
import { raidAdvice, raidTexts } from "./awareness";
import { CALLSIGNS } from "./heroes";
import { EN, tr } from "../lang";

/** Where a fragment sits in a sentence (the recording's intonation follows it). */
export type VoicePart = "line" | "head" | "mid" | "tail";

export interface VoiceLine {
  /** Matching key (voiceKey of the text). */
  key: string;
  /** The text as written (what the recording says). */
  text: string;
  tone: AnnounceTone;
  part: VoicePart;
  /** Fetched ahead at the start of a match (the common lines); the rest load on first use. */
  core: boolean;
  /** Clip file name under assets/voice/. */
  file: string;
}

/** The boss waves' names (sim/modes/survival.ts keeps them private; tests check this list against waveName()). */
export const BOSS_WAVE_NAMES = tr(["Fer de lance Creusot", "Escadre de bombardiers", "Force d'élite"] as const, ["Creusot Spearhead", "Bomber Squadron", "Elite Force"] as const);
/** Last Stand waves recorded by number ("Vague 12 repoussée"); later ones are synthesized. */
export const RECORDED_WAVES = 30;

/** Matching key: lower case, letters and digits only, single spaces ("Gargantua lâché !" → "gargantua lâché"). */
export function voiceKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Clip file name for a key: ASCII slug ("gargantua-lache.mp3"). */
export function voiceFile(key: string): string {
  const slug = key
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/œ/g, "oe")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug.slice(0, 72)}.mp3`;
}

// Every kind and power, the nations' too (PANACHE-CONCEPTION.md §1.11, WP5g); buildings by every name a nation gives them
const UNIT_KINDS = Object.keys(UNITS) as UnitKind[];
const BUILDING_KINDS = (Object.keys(BUILDINGS) as BuildingKind[]).filter((k) => k !== "hq");
const POWERS = Object.keys(POWER_NAMES) as PowerKind[];
const NATIONS: NationOrClassic[] = ["classique", "republique", "empire"];
/** A building's name and agreement as each nation says it (deduplicated: most kinds keep their Classique name). */
const BUILDING_NAMES = BUILDING_KINDS.flatMap((b) =>
  NATIONS.map((n) => ({ b, n, name: displayName(b, n) })).filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i)
);
const SIDES: Faction[] = ["blue", "red"];
const WEAPONS = (Object.keys(GOLIATH_WORD) as GoliathWeapon[]).filter((k) => !!GOLIATH_WORD[k]);

/** Every ordering of every non-empty subset (the weapons lost in one tick come in event order). */
function arrangements<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  const go = (cur: T[], rest: T[]) => {
    if (cur.length) out.push(cur);
    rest.forEach((x, i) => go([...cur, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  go([], [...xs]);
  return out;
}

function build(): VoiceLine[] {
  const out = new Map<string, VoiceLine>();
  const add = (text: string, tone: AnnounceTone, part: VoicePart = "line", core = false) => {
    const key = voiceKey(text);
    if (!key || out.has(key)) return;
    out.set(key, { key, text, tone, part, core, file: voiceFile(key) });
  };
  const line = (text: string, tone: AnnounceTone, core = false) => add(text, tone, "line", core);
  const banner = (text: string, tone: AnnounceTone, core = false) => add(speakable(text), tone, "line", core);
  const name = (k: UnitKind) => UNITS[k].name;
  const label = (k: UnitKind) => SHORT[k] ?? UNITS[k].name;

  // ---- callouts.ts: the player's radio --------------------------------------
  line(tr("Alerte : notre GQG est attaqué", "Alert: our GHQ is under attack"), "bad", true);
  line(tr("Notre base est attaquée", "Our base is under attack"), "bad", true);
  line(tr("Nos unités sont sous le feu", "Our units are under fire"), "bad", true);
  line(tr("Notre Gargantua est attaqué", "Our Gargantua is under attack"), "bad", true);
  line(tr("Escouade perdue", "Squad lost"), "bad", true);
  line(tr("Fardier perdu", "Steam Wagon lost"), "bad", true);
  line(tr("Charbon insuffisant", "Not enough coal"), "info", true);
  line(tr("Construction impossible ici", "Can't build here"), "info", true);
  line(tr("Construction terminée", "Construction complete"), "good", true);
  line(tr("Aviation ennemie détectée", "Enemy aircraft detected"), "bad", true);
  line(tr("Troupes déployées", "Troops deployed"), "good", true);
  line(tr("Débarquement ennemi !", "Enemy landing!"), "bad", true);
  line(tr("Montgolfière abattue ! Les troupes sautent", "Montgolfier Balloon down! The troops are jumping"), "bad");
  line(tr("Montgolfière abattue avec une escouade à bord", "Montgolfier Balloon shot down with a squad aboard"), "bad");
  for (let n = 2; n <= 4; n++) line(tr(`Montgolfière abattue avec ${n} escouades à bord`, `Montgolfier Balloon shot down with ${n} squads aboard`), "bad");
  line(tr("Montgolfière de remplacement en approche, une escouade à bord", "Replacement Montgolfier Balloon inbound, one squad aboard"), "good");
  line(tr("Montgolfière de remplacement en approche", "Replacement Montgolfier Balloon inbound"), "good");
  for (const l of Object.values(CALLOUTS.calldownLines)) if (l) line(l.text, "bad", true);
  for (const tier of CALLOUTS.tiers) {
    line(tier.text, tier.tone, true);
    for (const p of POWERS) line(tr(`${POWER_NAMES[p]} : ${tier.text.toLowerCase()}`, `${POWER_NAMES[p]}: ${tier.text.toLowerCase()}`), tier.tone);
  }
  line(tr("Premier sang", "First blood"), "epic", true);
  line(tr("Coup en plein au but !", "Right on target!"), "good"); // (the "Coup au but !" banner: said in full, the short form comes out garbled)
  // buildings: ours lost, theirs destroyed
  for (const { b, n, name } of BUILDING_NAMES) {
    line(tr(`Bâtiment perdu : ${name}`, `Building lost: ${name}`), "bad", n === "classique");
    line(enemyDestroyed(name, b, n), "good", n === "classique");
  }
  // units: kills (plain and elite), losses (plain and veteran)
  for (const k of UNIT_KINDS) {
    if (k === "goliath") continue;
    for (const elite of [false, true]) {
      const l = eliteLabel(label(k), elite);
      line(enemyDestroyed(l, k), "good", !elite && !UNITS[k].nation);
    }
    if (k !== "harvester") {
      line(unitLost(name(k), k, false), "bad");
      line(unitLost(name(k), k, true), "bad");
    }
  }
  // the HQ and Goliaths
  line(tr("Notre GQG est tombé", "Our GHQ has fallen"), "bad", true);
  line(tr("GQG ennemi détruit", "Enemy GHQ destroyed"), "epic", true);
  // the Empire's HQ is its Citadelle: the same lines in the feminine
  {
    const c = displayName("hq", "empire");
    const g = (w: string) => agree("hq", w, "empire");
    line(tr(`Alerte : notre ${c} est ${g("attaqué")}`, `Alert: our ${c} is under attack`), "bad");
    line(tr(`Notre ${c} est ${g("tombé")}`, `Our ${c} has fallen`), "bad");
    line(tr(`${c} ${g("ennemi")} ${g("détruit")}`, `Enemy ${c} destroyed`), "epic");
    line(tr(`${c} ${g("ennemi")} ${g("détruit")}. Victoire !`, `Enemy ${c} destroyed. Victory!`), "epic");
    line(tr(`Notre ${c} est ${g("tombé")}. Mission échouée.`, `Our ${c} has fallen. Mission failed.`), "bad");
    add(tr(`${c} ${g("ennemi")} ${g("détruit")}`, `Enemy ${c} destroyed`), "epic", "head");
    for (const f of SIDES) {
      line(tr(`${c} ${SIDE[f]} ${g("attaqué")}`, `${SIDE[f]} ${c} under attack`), "bad");
      line(tr(`${c} ${SIDE[f]} ${g("détruit")}`, `${SIDE[f]} ${c} destroyed`), "epic");
    }
  }
  line(tr("Gargantua ennemi détruit", "Enemy Gargantua destroyed"), "epic", true);
  line(tr("Gargantua d'élite ennemi détruit", "Enemy elite Gargantua destroyed"), "epic");
  line(tr("Gargantua perdu", "Gargantua lost"), "bad", true);
  line(tr("Gargantua perdu dans la chute", "Gargantua lost in the drop"), "bad");
  line(tr("Gargantua ennemi en production", "Enemy Gargantua in production"), "bad", true);
  line(tr("Gargantua ennemi presque terminé", "Enemy Gargantua nearly complete"), "bad", true);
  line(tr("Gargantua prêt", "Gargantua ready"), "good", true);
  line(tr("Gargantua ennemi sur le terrain", "Enemy Gargantua on the field"), "bad", true);
  line(tr("Gargantua ancré", "Gargantua anchored"), "good");
  line(tr("Gargantua ennemi en ancrage", "Enemy Gargantua anchoring"), "bad");
  line(tr("Gargantua ennemi lève l'ancre", "Enemy Gargantua weighing anchor"), "info");
  line(tr("Gargantua en vol", "Gargantua airborne"), "good");
  line(tr("Gargantua lâché !", "Gargantua dropped!"), "bad");
  line(tr("Gargantua ennemi en vol", "Enemy Gargantua airborne"), "bad");
  line(tr("Gargantua ennemi lâché !", "Enemy Gargantua dropped!"), "good");
  // weapon systems: one system is a whole line; several at once are pieced together
  // (the Zénith's own systems, its lines reworded: "Zénith : canons Branly hors ligne")
  for (const [what, say] of WEAPONS.flatMap((w) => [[GOLIATH_WORD[w]!, (s: string) => s], [ZENITH_WORD[w]!, zenithLine]] as const)) {
    line(say(tr(`Gargantua : ${what} hors ligne`, `Gargantua: ${what} offline`)), "bad");
    line(say(tr(`Gargantua : ${what} de nouveau en ligne`, `Gargantua: ${what} back online`)), "good");
    line(say(tr(`Gargantua ennemi : ${what} hors service !`, `Enemy Gargantua: ${what} knocked out!`)), "good");
    line(say(tr(`Gargantua ennemi : ${what} de nouveau en ligne`, `Enemy Gargantua: ${what} back online`)), "bad");
    for (const f of SIDES) line(say(tr(`Gargantua ${SIDE[f]} : ${what} hors service`, `${SIDE[f]} Gargantua: ${what} out of action`)), "info");
  }
  for (const words of [GOLIATH_WORD, ZENITH_WORD])
    for (const ws of arrangements(WEAPONS)) if (ws.length > 1) add(listWords(ws.map((w) => words[w]!)), "info", "mid");
  for (const h of tr(
    ["Gargantua :", "Gargantua ennemi :", ...SIDES.map((f) => `Gargantua ${SIDE[f]} :`)],
    ["Gargantua:", "Enemy Gargantua:", ...SIDES.map((f) => `${SIDE[f]} Gargantua:`)]
  ))
    add(h, "info", "head");
  for (const t of tr(["hors ligne", "hors service", "de nouveau en ligne"], ["offline", "out of action", "back online"])) add(t, "info", "tail");
  // the end
  line(tr("GQG ennemi détruit. Victoire !", "Enemy GHQ destroyed. Victory!"), "epic", true);
  line(tr("Dernier Gargantua ennemi détruit. Victoire !", "Last enemy Gargantua destroyed. Victory!"), "epic", true);
  line(tr("Notre GQG est tombé. Mission échouée.", "Our GHQ has fallen. Mission failed."), "bad", true);
  line(tr("Notre dernier Gargantua est tombé. Mission échouée.", "Our last Gargantua has fallen. Mission failed."), "bad", true);
  line(tr("Ils sont tombés amoureux. Match nul.", "They fell in love. A draw."), "good");
  line(tr("Match nul.", "A draw."), "good");
  line(tr("Base submergée. Le dernier Gargantua est tombé.", "Base overrun. The last Gargantua has fallen."), "bad");
  line(tr("Base submergée. Le GQG est tombé.", "Base overrun. The GHQ has fallen."), "bad");

  // ---- the calldown suffix: "Creusot ennemi détruit par un Feu roulant" ------
  for (const p of POWERS) add(tr(`par ${powerPhrase(p)}`, `by ${powerPhrase(p)}`), "good", "tail");

  // ---- spectators: a neutral caster -----------------------------------------
  for (const f of SIDES) {
    const s = SIDE[f];
    line(tr(`GQG ${s} attaqué`, `${s} GHQ under attack`), "bad");
    line(tr(`Gargantua ${s} attaqué`, `${s} Gargantua under attack`), "bad");
    line(tr(`GQG ${s} détruit`, `${s} GHQ destroyed`), "epic");
    line(tr(`Premier sang pour ${s}`, `First blood for ${s}`), "epic");
    add(tr(`pour ${s}`, `for ${s}`), "info", "tail");
    line(tr(`Débarquement ${s}`, `${s} landing`), "info");
    line(tr(`Gargantua ${s} en production`, `${s} Gargantua in production`), "info");
    line(tr(`Gargantua ${s} presque terminé`, `${s} Gargantua nearly complete`), "info");
    line(tr(`Gargantua ${s} sur le terrain`, `${s} Gargantua on the field`), "epic");
    line(tr(`Gargantua ${s} en ancrage`, `${s} Gargantua anchoring`), "info");
    line(tr(`Gargantua ${s} en vol`, `${s} Gargantua airborne`), "info");
    line(tr(`Gargantua ${s} lâché !`, `${s} Gargantua dropped!`), "info");
    line(tr(`Aviation ${s} en approche`, `${s} aircraft inbound`), "bad");
    line(tr(`${s} remporte la bataille`, `${s} wins the battle`), "epic");
    add(tr(`Dernier Gargantua ${s} détruit.`, `${s} last Gargantua destroyed.`), "epic", "head");
    line(tr(`Gargantua ${s} abattu`, `${s} Gargantua down`), "epic");
    line(tr(`Gargantua d'élite ${s} abattu`, `${s} elite Gargantua down`), "epic");
    line(tr(`${s} prend un Relais`, `${s} takes a Relay`), "info");
    line(tr(`${s} abandonne`, `${s} resigns`), "epic");
    // "<building> Rouge détruite", "<unit> Bleu abattu": the name, then the side and participle
    // (English: "Red Creusot down": the side, then the name, then the participle)
    if (EN) add(s, "info", "head");
    else for (const p of ["détruit", "détruite", "détruites", "abattu", "abattue"]) add(`${s} ${p}`, "info", "tail");
  }

  // ---- fragments: names, for the templates pieced together ------------------
  // (a big kill under a streak, "Creusot détruit"; promotions; spectator kills)
  for (const k of UNIT_KINDS) {
    const names = new Set([name(k), label(k)]);
    for (const n of names) add(n, "info", "head");
    if (k !== "goliath") add(eliteLabel(label(k), true), "info", "head");
  }
  for (const { name } of BUILDING_NAMES) add(name, "info", "head");
  for (const t of tr(
    ["détruit", "détruite", "détruites", "abattu", "abattue", "abattues", "promu", "promue", "promu élite", "promue élite"],
    ["destroyed", "down", "promoted", "promoted to elite"]
  ))
    add(t, "info", "tail");

  // ---- banners (announce(), read out) ---------------------------------------
  line(tr("Essai radio", "Radio check"), "info", true);
  banner(tr("Relais capturé", "Relay captured"), "good", true);
  banner(tr("Relais perdu", "Relay lost"), "bad", true);
  banner(tr("Largage rare !", "Rare drop!"), "epic", true);
  banner(tr("Largage de ravitaillement en approche", "Supply drop inbound"), "epic", true);
  banner(tr("Obus Méliès opérationnel", "Méliès Shell ready"), "epic", true);
  banner(tr("Obus Méliès en approche !", "Méliès Shell incoming!"), "info");
  banner(tr("Obus Méliès ennemi en approche !", "Enemy Méliès Shell incoming!"), "bad", true);
  banner(tr("BUTIN DE RÉCUPÉRATION", "SALVAGE HAUL"), "good");
  banner(tr("Mutateurs actifs", "Mutators active"), "info");
  for (const id of OPENER_IDS) banner(tr(`${OPENERS[id].name} !`, `${OPENERS[id].name}!`), "good", true);
  // ops
  // (the Trials' and the campaign's titles; game/ops.ts: « Mission réussie / échouée » and the scripts' events)
  for (const op of OPS) banner(op.title, "info");
  banner(tr("Tiens encore une minute", "Hold one more minute"), "info");
  banner(tr("Plus qu'une minute", "One minute left"), "bad");
  banner(tr("Op réussie", "Op complete"), "epic");
  banner(tr("Op échouée", "Op failed"), "bad");
  banner(tr("Mission réussie", "Mission complete"), "epic");
  banner(tr("Mission échouée", "Mission failed"), "bad");
  banner(tr("Ferrand l'a fini !", "Ferrand's done it!"), "good");
  banner(tr("Le Colosse se met en marche !", "The Colossus marches!"), "bad");
  // Last Stand
  for (const n of Object.values(THEME_NAMES)) banner(n, "bad");
  for (const n of BOSS_WAVE_NAMES) banner(n, "epic");
  for (let n = 1; n <= RECORDED_WAVES; n++) banner(tr(`Vague ${n} repoussée${n % 10 === 0 ? " !" : ""}`, `Wave ${n} repelled${n % 10 === 0 ? "!" : ""}`), n % 10 === 0 ? "epic" : "good");
  banner(tr("Nouveau record !", "New record!"), "epic");
  banner(tr("Base submergée", "Base overrun"), "bad");
  // inbound raids (awareness.ts): every domain and lead
  for (const domain of ["air", "ground", "mixed"] as const)
    for (const k of UNIT_KINDS) {
      const { what, enemy } = raidAdvice(domain, k);
      line(raidTexts(what, enemy).text, "bad", true);
    }
  // heroes: "Viper passe Élite"
  for (const c of CALLSIGNS) banner(tr(`${c} passe Élite`, `${c} reaches Elite`), "epic");
  // the finale's result banner, every way a match ends
  for (const cause of ["hq", "goliath", "resign", "love"] as const)
    for (const winner of ["blue", "red", "draw"] as const)
      for (const spectator of [false, true])
        for (const n of NATIONS) {
          const b = finaleBanner({ cause, winner, player: "blue", spectator, x: 0, y: 0, nations: { blue: n, red: n } });
          banner(b.say ?? b.text, b.tone ?? "info", n === "classique");
        }
  // the Zénith: every Gargantua line as the République's airship says it (callouts.ts zenithLine)
  // (not the Gargantua's weapon systems: the Zénith has its own, above)
  const gWords = new RegExp(`: (${Object.values(GOLIATH_WORD).join("|")})`);
  for (const l of [...out.values()]) {
    // (nor what a Zénith never does: be lifted and dropped, flood a Last Stand base, or the Gantry's lines)
    if (gWords.test(l.text) || tr(/lâché|en vol|chute|submergée|Galerie/, /dropped|airborne|in the drop|overrun|Galerie/).test(l.text)) continue;
    const z = zenithLine(l.text);
    if (z !== l.text) add(z, l.tone, l.part);
  }
  return [...out.values()];
}

let lines: VoiceLine[] | null = null;
let index: Map<string, VoiceLine> | null = null;

/** The phrase book, built once. */
export function voiceLines(): readonly VoiceLine[] {
  return (lines ??= build());
}

/** Phrase book entry by key. */
export function voiceLine(key: string): VoiceLine | undefined {
  index ??= new Map(voiceLines().map((l) => [l.key, l]));
  return index.get(key);
}

/** Longest entry, in words (bounds the planner's search). */
let maxWords = 0;

/**
 * The clips that say `text`, in order: the whole line when the book has it,
 * else the fewest fragments that cover it word for word; null when it can't
 * be covered (the line falls back to speech synthesis).
 */
export function planVoice(text: string): VoiceLine[] | null {
  const key = voiceKey(text);
  if (!key) return null;
  const whole = voiceLine(key);
  if (whole) return [whole];
  if (!maxWords) maxWords = Math.max(...voiceLines().map((l) => l.key.split(" ").length));
  const words = key.split(" ");
  const n = words.length;
  // best[i]: fewest clips covering words[0..i)
  const best: { cost: number; prev: number; line: VoiceLine | null }[] = [{ cost: 0, prev: -1, line: null }];
  for (let i = 1; i <= n; i++) {
    best[i] = { cost: Infinity, prev: -1, line: null };
    for (let j = Math.max(0, i - maxWords); j < i; j++) {
      if (best[j]!.cost === Infinity) continue;
      const l = voiceLine(words.slice(j, i).join(" "));
      if (l && best[j]!.cost + 1 < best[i]!.cost) best[i] = { cost: best[j]!.cost + 1, prev: j, line: l };
    }
  }
  if (best[n]!.cost === Infinity) return null;
  const out: VoiceLine[] = [];
  for (let i = n; i > 0; i = best[i]!.prev) out.unshift(best[i]!.line!);
  return out;
}
