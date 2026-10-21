/**
 * The menu's "🎬 Watch a replay" sheet: paste a battle record (the JSON an
 * agent battle writes to battles/, AGENT-BATTLES.md "Battle records") or pick
 * its file, and watch it in the battle viewer. The viewer itself loads only
 * once a record is chosen (main.ts).
 */
import { openSheet } from "./career";

export function showReplayPicker(host: HTMLElement, watch: (json: string) => Promise<void>): void {
  const wrap = openSheet(
    host,
    "replaysheet",
    `<h2>🎬 Voir une rediffusion</h2>
     <p class="sh-sub">Colle un enregistrement de bataille : le fichier <b>.json</b> qu'une bataille d'agents écrit dans <code>battles/</code> (<code>llm battledrones run</code>, <code>tools/arena.ts</code>). Ou choisis le fichier.</p>
     <textarea id="replay-json" spellcheck="false" autocomplete="off" placeholder='{"v":1,"map":"riverlands",…}'></textarea>
     <label class="cta alt replay-file">📂 Choisir un fichier…<input type="file" accept=".json,application/json" hidden></label>
     <p class="sh-note replay-error" role="alert" hidden></p>
     <div class="sh-actions"><button class="cta alt sheet-close">Annuler</button><button class="cta" id="replay-go">▶ Regarder</button></div>`
  );
  const text = wrap.querySelector<HTMLTextAreaElement>("#replay-json")!;
  const error = wrap.querySelector<HTMLElement>(".replay-error")!;
  const go = wrap.querySelector<HTMLButtonElement>("#replay-go")!;
  const play = async (json: string) => {
    error.hidden = true;
    go.disabled = true;
    try {
      await watch(json);
      wrap.remove();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
      error.hidden = false;
      go.disabled = false;
    }
  };
  go.addEventListener("click", () => void play(text.value));
  wrap.querySelector<HTMLInputElement>("input[type=file]")!.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    text.value = await file.text();
    void play(text.value);
  });
  text.focus();
}
