/**
 * The audio rig's words in the player's language. The rig (src/link) stays out
 * of the page's modules (it also runs in the AudioWorklet's graph), so its few
 * French sentences are translated here, where the lobby and the feed show them.
 */
import { EN } from "../lang";
import { RIG_ADVICE, RIG_MESSAGES, type RigErrorReason } from "../link/rig";

const MESSAGES_EN: Readonly<Record<Exclude<RigErrorReason, "rate">, string>> = {
  "no-audio": "This browser can't play the sound link",
  "no-worklet": "This browser can't run the sound link",
  "mic-refused": "Microphone refused",
  "no-mic": "No microphone available: close the other apps using it and try again",
  update: "A new version is ready: reload this phone (and your friend's)"
};

const ADVICE_EN: Readonly<Partial<Record<RigErrorReason, string>>> = {
  "mic-refused": "Allow the microphone for this site in the browser settings, then try again.",
  rate: "Try again with the headset and Bluetooth disconnected.",
  "no-audio": "Try another browser.",
  "no-worklet": "Try another browser."
};

/** What to do about a reason, in the player's language (undefined: nothing to say). */
export const rigAdvice = (reason: RigErrorReason): string | undefined => (EN ? ADVICE_EN[reason] : RIG_ADVICE[reason]);

/** A rig error's message in the player's language (an unknown sentence is left as it is). */
export function rigMessage(reason: RigErrorReason | undefined, message: string): string {
  if (!EN) return message;
  if (reason && reason !== "rate" && message === RIG_MESSAGES[reason]) return MESSAGES_EN[reason];
  if (message === "L'audio de ce téléphone ne peut pas porter la liaison sonore") return "This phone's audio can't carry the sound link";
  if (message === "Le dispositif audio a été fermé") return "The audio device was closed";
  if (message === "le processeur audio de la liaison sonore a échoué") return "the sound link's audio processor failed";
  const stopped = /^le modem s'est arrêté : (.*)$/s.exec(message);
  if (stopped) return `the modem stopped: ${stopped[1]}`;
  const mic = /^Le micro de ce téléphone tourne à (\d+) Hz, inutilisable pour la liaison sonore$/.exec(message);
  if (mic) return `This phone's microphone runs at ${mic[1]} Hz, unusable for the sound link`;
  const audio = /^L'audio de ce téléphone tourne à (\d+) Hz, inutilisable pour la liaison sonore$/.exec(message);
  if (audio) return `This phone's audio runs at ${audio[1]} Hz, unusable for the sound link`;
  return message;
}

