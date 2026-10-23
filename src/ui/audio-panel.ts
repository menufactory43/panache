/**
 * Sound settings: a row of four toggles (All / Music / Effects / Voice)
 * bound to the shared audio engine's persisted settings. Used in the pause
 * menu; the top-left speaker button stays a one-tap master mute. Voice has
 * three states, cycled by tapping: Voice (announcer speech and unit chirps)
 * → Chirps (no speech: unit chirps and radio codes) → off.
 */
import { sfx, type AudioChannel } from "../game/audio";
import { radioCheck } from "../game/announcer";
import { BELLE_EPOQUE } from "../game/three/theme";
import { voices } from "../game/voices";
import { tr } from "../lang";

/** What the unit voices are called: robot "bips", or (Belle Époque) the machines' whistles and clockwork. */
const CHIRPS = BELLE_EPOQUE
  ? {
      label: tr("Machines", "Machines"), icon: "⚙️",
      title: tr("Sifflets et rouages des unités, et télégraphe, sans parole (touche pour couper)", "Unit whistles and clockwork, and telegraph, no speech (tap to mute)"),
      both: tr("Annonceur, sifflets et rouages des unités (touche pour les machines seules)", "Announcer, unit whistles and clockwork (tap for machines only)")
    }
  : {
      label: tr("Bips", "Beeps"), icon: "🤖",
      title: tr("Bips des unités et codes radio, sans parole (touche pour couper)", "Unit beeps and radio codes, no speech (tap to mute)"),
      both: tr("Annonceur et bips des unités (touche pour les bips seuls)", "Announcer and unit beeps (tap for beeps only)")
    };

const TOGGLES: { id: "muted" | AudioChannel; icon: string; label: string }[] = [
  { id: "muted", icon: "🔊", label: tr("Son", "Sound") },
  { id: "music", icon: "🎵", label: tr("Musique", "Music") },
  { id: "sfx", icon: "💥", label: tr("Effets", "Effects") },
  { id: "voice", icon: "🗣", label: tr("Voix", "Voice") }
];

/** Render the toggles into `host`; returns a cleanup function. */
export function mountAudioToggles(host: HTMLElement): () => void {
  host.classList.add("sound-row");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", tr("Réglages du son", "Sound settings"));
  host.innerHTML = TOGGLES.map(
    (t) =>
      `<button class="snd" data-k="${t.id}" aria-pressed="false"><span class="si">${t.icon}</span><span class="sl">${t.label}</span></button>`
  ).join("");
  const sync = () => {
    const s = sfx.settings;
    host.querySelectorAll<HTMLButtonElement>(".snd").forEach((b) => {
      const k = b.dataset.k as (typeof TOGGLES)[number]["id"];
      const on = k === "muted" ? !s.muted : s[k];
      b.classList.toggle("on", on);
      // a bus switched on under a master mute is still silent: show it greyed
      b.classList.toggle("held", k !== "muted" && on && s.muted);
      b.setAttribute("aria-pressed", String(on));
      if (k === "muted") b.querySelector(".si")!.textContent = on ? "🔊" : "🔇";
      if (k === "voice") {
        const chirps = on && !s.speech;
        b.querySelector(".sl")!.textContent = chirps ? CHIRPS.label : tr("Voix", "Voice");
        b.querySelector(".si")!.textContent = chirps ? CHIRPS.icon : "🗣";
        b.title = chirps ? CHIRPS.title : on ? CHIRPS.both : tr("Voix coupée (touche pour activer)", "Voice off (tap to turn on)");
      }
    });
  };
  host.querySelectorAll<HTMLButtonElement>(".snd").forEach((b) =>
    b.addEventListener("click", () => {
      const k = b.dataset.k as (typeof TOGGLES)[number]["id"];
      sfx.unlock();
      if (k === "muted") sfx.setMuted(!sfx.muted);
      else if (k === "voice") {
        // Voice → Chirps → off → Voice
        const s = sfx.settings;
        if (!s.voice) {
          sfx.setSpeech(true);
          sfx.setChannel("voice", true);
        } else if (s.speech) sfx.setSpeech(false);
        else sfx.setChannel("voice", false);
        // a sample of what the setting sounds like: a unit answers, then the radio
        if (sfx.settings.voice) {
          voices.say("stinger", "select", 7);
          radioCheck();
        }
        return;
      } else sfx.setChannel(k, !sfx.settings[k]);
      sfx.play("click", 0.5);
    })
  );
  sync();
  return sfx.onChange(sync);
}
