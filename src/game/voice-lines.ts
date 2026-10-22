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
import { CALLOUTS, GOLIATH_WORD, SHORT, SIDE, ZENITH_WORD, listWords, speakable, zenithLine } from "./callouts";
import { finaleBanner } from "./finale";
import { raidAdvice } from "./awareness";
import { CALLSIGNS } from "./heroes";

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
export const BOSS_WAVE_NAMES = ["Fer de lance Creusot", "Escadre de bombardiers", "Force d'élite"] as const;
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
  line("Alerte : notre GQG est attaqué", "bad", true);
  line("Notre base est attaquée", "bad", true);
  line("Nos unités sont sous le feu", "bad", true);
  line("Notre Gargantua est attaqué", "bad", true);
  line("Escouade perdue", "bad", true);
  line("Fardier perdu", "bad", true);
  line("Charbon insuffisant", "info", true);
  line("Construction impossible ici", "info", true);
  line("Construction terminée", "good", true);
  line("Aviation ennemie détectée", "bad", true);
  line("Troupes déployées", "good", true);
  line("Débarquement ennemi !", "bad", true);
  line("Montgolfière abattue ! Les troupes sautent", "bad");
  line("Montgolfière abattue avec une escouade à bord", "bad");
  for (let n = 2; n <= 4; n++) line(`Montgolfière abattue avec ${n} escouades à bord`, "bad");
  line("Montgolfière de remplacement en approche, une escouade à bord", "good");
  line("Montgolfière de remplacement en approche", "good");
  for (const l of Object.values(CALLOUTS.calldownLines)) if (l) line(l.text, "bad", true);
  for (const tier of CALLOUTS.tiers) {
    line(tier.text, tier.tone, true);
    for (const p of POWERS) line(`${POWER_NAMES[p]} : ${tier.text.toLowerCase()}`, tier.tone);
  }
  line("Premier sang", "epic", true);
  line("Coup en plein au but !", "good"); // (the "Coup au but !" banner: said in full, the short form comes out garbled)
  // buildings: ours lost, theirs destroyed
  for (const { b, n, name } of BUILDING_NAMES) {
    line(`Bâtiment perdu : ${name}`, "bad", n === "classique");
    line(`${name} ${agree(b, "ennemi", n)} ${agree(b, "détruit", n)}`, "good", n === "classique");
  }
  // units: kills (plain and elite), losses (plain and veteran)
  for (const k of UNIT_KINDS) {
    if (k === "goliath") continue;
    for (const elite of [false, true]) {
      const l = `${label(k)}${elite ? " d'élite" : ""}`;
      line(`${l} ${agree(k, "ennemi")} ${agree(k, "détruit")}`, "good", !elite && !UNITS[k].nation);
    }
    if (k !== "harvester") {
      line(`${name(k)} ${agree(k, "perdu")}`, "bad");
      line(`${name(k)} ${agree(k, "vétéran")} ${agree(k, "perdu")}`, "bad");
    }
  }
  // the HQ and Goliaths
  line("Notre GQG est tombé", "bad", true);
  line("GQG ennemi détruit", "epic", true);
  // the Empire's HQ is its Citadelle: the same lines in the feminine
  {
    const c = displayName("hq", "empire");
    const g = (w: string) => agree("hq", w, "empire");
    line(`Alerte : notre ${c} est ${g("attaqué")}`, "bad");
    line(`Notre ${c} est ${g("tombé")}`, "bad");
    line(`${c} ${g("ennemi")} ${g("détruit")}`, "epic");
    line(`${c} ${g("ennemi")} ${g("détruit")}. Victoire !`, "epic");
    line(`Notre ${c} est ${g("tombé")}. Mission échouée.`, "bad");
    add(`${c} ${g("ennemi")} ${g("détruit")}`, "epic", "head");
    for (const f of SIDES) {
      line(`${c} ${SIDE[f]} ${g("attaqué")}`, "bad");
      line(`${c} ${SIDE[f]} ${g("détruit")}`, "epic");
    }
  }
  line("Gargantua ennemi détruit", "epic", true);
  line("Gargantua d'élite ennemi détruit", "epic");
  line("Gargantua perdu", "bad", true);
  line("Gargantua perdu dans la chute", "bad");
  line("Gargantua ennemi en production", "bad", true);
  line("Gargantua ennemi presque terminé", "bad", true);
  line("Gargantua prêt", "good", true);
  line("Gargantua ennemi sur le terrain", "bad", true);
  line("Gargantua ancré", "good");
  line("Gargantua ennemi en ancrage", "bad");
  line("Gargantua ennemi lève l'ancre", "info");
  line("Gargantua en vol", "good");
  line("Gargantua lâché !", "bad");
  line("Gargantua ennemi en vol", "bad");
  line("Gargantua ennemi lâché !", "good");
  // weapon systems: one system is a whole line; several at once are pieced together
  // (the Zénith's own systems, its lines reworded: "Zénith : canons Branly hors ligne")
  for (const [what, say] of WEAPONS.flatMap((w) => [[GOLIATH_WORD[w]!, (s: string) => s], [ZENITH_WORD[w]!, zenithLine]] as const)) {
    line(say(`Gargantua : ${what} hors ligne`), "bad");
    line(say(`Gargantua : ${what} de nouveau en ligne`), "good");
    line(say(`Gargantua ennemi : ${what} hors service !`), "good");
    line(say(`Gargantua ennemi : ${what} de nouveau en ligne`), "bad");
    for (const f of SIDES) line(say(`Gargantua ${SIDE[f]} : ${what} hors service`), "info");
  }
  for (const words of [GOLIATH_WORD, ZENITH_WORD])
    for (const ws of arrangements(WEAPONS)) if (ws.length > 1) add(listWords(ws.map((w) => words[w]!)), "info", "mid");
  for (const h of ["Gargantua :", "Gargantua ennemi :", ...SIDES.map((f) => `Gargantua ${SIDE[f]} :`)]) add(h, "info", "head");
  for (const t of ["hors ligne", "hors service", "de nouveau en ligne"]) add(t, "info", "tail");
  // the end
  line("GQG ennemi détruit. Victoire !", "epic", true);
  line("Dernier Gargantua ennemi détruit. Victoire !", "epic", true);
  line("Notre GQG est tombé. Mission échouée.", "bad", true);
  line("Notre dernier Gargantua est tombé. Mission échouée.", "bad", true);
  line("Ils sont tombés amoureux. Match nul.", "good");
  line("Match nul.", "good");
  line("Base submergée. Le dernier Gargantua est tombé.", "bad");
  line("Base submergée. Le GQG est tombé.", "bad");

  // ---- the calldown suffix: "Creusot ennemi détruit par un Feu roulant" ------
  for (const p of POWERS) add(`par ${powerPhrase(p)}`, "good", "tail");

  // ---- spectators: a neutral caster -----------------------------------------
  for (const f of SIDES) {
    const s = SIDE[f];
    line(`GQG ${s} attaqué`, "bad");
    line(`Gargantua ${s} attaqué`, "bad");
    line(`GQG ${s} détruit`, "epic");
    line(`Premier sang pour ${s}`, "epic");
    add(`pour ${s}`, "info", "tail");
    line(`Débarquement ${s}`, "info");
    line(`Gargantua ${s} en production`, "info");
    line(`Gargantua ${s} presque terminé`, "info");
    line(`Gargantua ${s} sur le terrain`, "epic");
    line(`Gargantua ${s} en ancrage`, "info");
    line(`Gargantua ${s} en vol`, "info");
    line(`Gargantua ${s} lâché !`, "info");
    line(`Aviation ${s} en approche`, "bad");
    line(`${s} remporte la bataille`, "epic");
    add(`Dernier Gargantua ${s} détruit.`, "epic", "head");
    line(`Gargantua ${s} abattu`, "epic");
    line(`Gargantua d'élite ${s} abattu`, "epic");
    line(`${s} prend un Relais`, "info");
    line(`${s} abandonne`, "epic");
    // "<building> Rouge détruite", "<unit> Bleu abattu": the name, then the side and participle
    for (const p of ["détruit", "détruite", "détruites", "abattu", "abattue"]) add(`${s} ${p}`, "info", "tail");
  }

  // ---- fragments: names, for the templates pieced together ------------------
  // (a big kill under a streak, "Creusot détruit"; promotions; spectator kills)
  for (const k of UNIT_KINDS) {
    const names = new Set([name(k), label(k)]);
    for (const n of names) add(n, "info", "head");
    if (k !== "goliath") add(`${label(k)} d'élite`, "info", "head");
  }
  for (const { name } of BUILDING_NAMES) add(name, "info", "head");
  for (const t of ["détruit", "détruite", "détruites", "abattu", "abattue", "abattues", "promu", "promue", "promu élite", "promue élite"])
    add(t, "info", "tail");

  // ---- banners (announce(), read out) ---------------------------------------
  line("Essai radio", "info", true);
  banner("Relais capturé", "good", true);
  banner("Relais perdu", "bad", true);
  banner("Largage rare !", "epic", true);
  banner("Largage de ravitaillement en approche", "epic", true);
  banner("Obus Méliès opérationnel", "epic", true);
  banner("Obus Méliès en approche !", "info");
  banner("Obus Méliès ennemi en approche !", "bad", true);
  banner("BUTIN DE RÉCUPÉRATION", "good");
  banner("Mutateurs actifs", "info");
  for (const id of OPENER_IDS) banner(`${OPENERS[id].name} !`, "good", true);
  // ops
  for (const op of OPS) banner(op.title, "info");
  banner("Tiens encore une minute", "info");
  banner("Plus qu'une minute", "bad");
  banner("Op réussie", "epic");
  banner("Op échouée", "bad");
  // Last Stand
  for (const n of Object.values(THEME_NAMES)) banner(n, "bad");
  for (const n of BOSS_WAVE_NAMES) banner(n, "epic");
  for (let n = 1; n <= RECORDED_WAVES; n++) banner(`Vague ${n} repoussée${n % 10 === 0 ? " !" : ""}`, n % 10 === 0 ? "epic" : "good");
  banner("Nouveau record !", "epic");
  banner("Base submergée", "bad");
  // inbound raids (awareness.ts): every domain and lead
  for (const domain of ["air", "ground", "mixed"] as const)
    for (const k of UNIT_KINDS) {
      const { what, enemy } = raidAdvice(domain, k);
      line(`${what[0]!.toUpperCase()}${what.slice(1)} ${enemy} en approche`, "bad", true);
    }
  // heroes: "Viper passe Élite"
  for (const c of CALLSIGNS) banner(`${c} passe Élite`, "epic");
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
    if (gWords.test(l.text) || /lâché|en vol|chute|submergée|Galerie/.test(l.text)) continue;
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
