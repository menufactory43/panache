#!/usr/bin/env python3
"""
Record the announcer's phrase book with OpenAI TTS (Panache).

Reads public/assets/voice/manifest.json (exported from src/game/voice-lines.ts
by `npx vite-node tools/voice-manifest.ts`) and writes one small MP3 per entry
next to it: mono, 22 kHz, 24 kb/s, silence trimmed, a touch brisker, loudness normalized to
-16 LUFS. Existing clips are kept unless --force (or --only names them).

The API key comes from the environment (OPENAI_API_KEY) and is never printed
or written anywhere. Needs the `openai` package and ffmpeg.

  python3 tools/voice-generate.py                 # record what's missing
  python3 tools/voice-generate.py --force         # re-record everything
  python3 tools/voice-generate.py --only "Fardier perdu" --force
  python3 tools/voice-generate.py --audition onyx,ash,ballad --out /tmp/voice-out/audition
"""
import argparse
import concurrent.futures as cf
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOICE_DIR = ROOT / "public" / "assets" / "voice"
MANIFEST = VOICE_DIR / "manifest.json"

MODEL = "gpt-4o-mini-tts"
VOICE = "onyx"
SPEED = 1.15
# takes are transcribed back (gpt-4o-transcribe) and retaken while they don't say the text well enough
CHECK_MODEL = "gpt-4o-transcribe"
MIN_SCORE = 0.86
MAX_TAKES = 4
LUFS = -16
# (the game plays them through a 330–3300 Hz field telephone: 22 kHz at 24 kb/s loses nothing it keeps)
BITRATE = "24k"
RATE = 22050
# a touch brisker than the TTS speaks, pitch kept (radio talk)
TEMPO = 1.1

BASE_STYLE = (
    "Officier de l'armée française vers 1900 parlant dans un téléphone de campagne : "
    "voix grave, posée, articulée, accent français neutre, ton martial mais pas criard, "
    "courte phrase radio. Débit rapide et soutenu, sans traîner, mais clair ; aucune hésitation, "
    "aucun souffle avant ni après. Les sigles se disent lettre par lettre à la française (GQG : gé-qu-gé)."
)
TONE_STYLE = {
    "bad": "Annonce une mauvaise nouvelle ou un danger : urgent, ferme, tendu, sans crier.",
    "good": "Annonce une bonne nouvelle : satisfait, assuré, sobre.",
    "epic": "Moment fort de la bataille : solennel, fier, un peu plus appuyé.",
    "info": "Information de service : neutre, net, efficace.",
}
PART_STYLE = {
    "line": "",
    "head": "Ce n'est que le début d'une phrase, la suite sera dite juste après : intonation suspendue, pas de chute finale, pas de pause.",
    "mid": "C'est le milieu d'une phrase : intonation suspendue, enchaîné, pas de chute finale.",
    "tail": "C'est la fin d'une phrase commencée juste avant : enchaîner directement, intonation finale naturelle.",
}

# How the TTS should say what the screen writes (sigles, numbers it might misread).
SAY = [
    (r"\bRuggieri\b", "Roudjiéri"),
    (r"\bCanons? de 75\b", lambda m: m.group(0).replace("75", "soixante-quinze")),
    (r"\bOp\b", "Opé"),
]


def tts_text(text: str) -> str:
    for pat, rep in SAY:
        text = re.sub(pat, rep, text)
    return text


def instructions(tone: str, part: str) -> str:
    return " ".join(x for x in (BASE_STYLE, TONE_STYLE.get(tone, ""), PART_STYLE.get(part, "")) if x)


def synthesize(client, text: str, tone: str, part: str, voice: str, model: str) -> bytes:
    res = client.audio.speech.create(
        model=model,
        voice=voice,
        input=tts_text(text),
        instructions=instructions(tone, part),
        response_format="wav",
        speed=SPEED,
    )
    return res.read()


def fold(s: str) -> str:
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = " " + re.sub(r"[^a-z0-9]+", " ", s).strip() + " "
    for words, digits in NUMBERS:
        s = s.replace(f" {words} ", f" {digits} ")
    return s.replace(" ", "")


_FR = ["zero", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
       "dix sept", "dix huit", "dix neuf", "vingt", "vingt et un"] + [f"vingt {u}" for u in "deux trois quatre cinq six sept huit neuf".split()] + ["trente", "soixante quinze"]
# number words → digits (the transcriber writes either), longest first
NUMBERS = sorted([(w, str(i if i <= 30 else 75)) for i, w in enumerate(_FR)] + [("xv", "15")], key=lambda x: -len(x[0]))
# words the transcriber knows: a take that doesn't say them clearly is retaken
MUST = ["gargantua", "victoire", "ennemi"]


def score(client, clip: Path, text: str) -> tuple[float, str]:
    """How well the clip says `text`: the transcript's similarity to it (0..1)."""
    with clip.open("rb") as f:
        heard = client.audio.transcriptions.create(model=CHECK_MODEL, file=f, language="fr").text
    said, want = fold(heard), fold(text)
    sc = difflib.SequenceMatcher(None, fold(text), said).ratio()
    for w in MUST:
        if w in want and w not in said:
            sc *= 0.8
    return sc, heard


def loudness(wav: Path) -> dict:
    """First loudnorm pass: the clip's measured loudness."""
    p = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(wav), "-af", f"loudnorm=I={LUFS}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(p.stderr[p.stderr.rindex("{"):p.stderr.rindex("}") + 1])


TRIM = (
    # trim leading and trailing silence (reverse trick for the tail), keep 30 ms of air
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,"
    "areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse"
)


def encode(raw: Path, out: Path) -> float:
    """Trim, normalize (measured loudness, then gain and a limiter) and encode `raw` to `out`; returns the duration."""
    with tempfile.TemporaryDirectory() as td:
        trimmed = Path(td) / "t.wav"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw), "-ac", "1", "-af", f"{TRIM},atempo={TEMPO}", str(trimmed)], check=True)
        m = loudness(trimmed)
        if m["input_i"] in ("-inf", "inf"):
            raise ValueError("silent take")
        # one gain to the target loudness, a limiter for the odd peak it pushes over (loudnorm's own
        # linear mode gives up on short clips, which then come out several LU apart)
        gain = LUFS - float(m["input_i"])
        tmp = out.with_suffix(".tmp.mp3")
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(trimmed),
             "-af", f"volume={gain:.2f}dB,alimiter=limit=0.84:attack=2:release=40:level=false", "-ar", str(RATE), "-ac", "1",
             "-c:a", "libmp3lame", "-b:a", BITRATE, "-map_metadata", "-1", "-write_xing", "1", str(tmp)],
            check=True,
        )
        tmp.replace(out)
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)], capture_output=True, text=True, check=True)
    return float(p.stdout.strip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="re-record clips that already exist")
    ap.add_argument("--only", action="append", default=[], help="record only this line (text or key; repeatable)")
    ap.add_argument("--match", help="record only lines whose text matches this regular expression")
    ap.add_argument("--voice", default=VOICE)
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--out", type=Path, default=VOICE_DIR, help="clip folder (default: public/assets/voice)")
    ap.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "panache-voice-raw", help="raw TTS cache (re-encode without re-recording)")
    ap.add_argument("--audition", help="comma-separated voices: record a short sample set per voice into --out/<voice>/")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--takes", type=int, default=MAX_TAKES, help="most takes per clip while the check isn't met")
    ap.add_argument("--no-check", action="store_true", help="keep the first take (no transcription check)")
    ap.add_argument("--report", type=Path, default=Path(tempfile.gettempdir()) / "panache-voice-report.json")
    args = ap.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        return 2
    from openai import OpenAI

    client = OpenAI()
    lines = json.loads(MANIFEST.read_text())["lines"]

    if args.audition:
        pick = ["Alerte : notre GQG est attaqué", "Creusot ennemi détruit", "Aviation ennemie détectée", "Gargantua ennemi sur le terrain",
                "Hotchkiss ennemie détruite", "Vague 12 repoussée", "GQG ennemi détruit. Victoire !", "Canon de 75 perdu"]
        by_text = {l["text"]: l for l in lines}
        jobs = []
        for v in args.audition.split(","):
            for t in pick:
                l = by_text[t]
                jobs.append((v, l, args.out / v / l["file"]))
    else:
        want = {x.lower() for x in args.only}
        sel = [l for l in lines if not want or l["text"].lower() in want or l["key"] in want]
        if args.match:
            sel = [l for l in sel if re.search(args.match, l["text"])]
            want = want or {"--match"}
        jobs = [(args.voice, l, args.out / l["file"]) for l in sel]
        if not want and not args.force:
            jobs = [j for j in jobs if not j[2].exists()]

    def run(job):
        voice, l, out = job
        if out.exists() and not (args.force or args.only):
            return out, None, None
        out.parent.mkdir(parents=True, exist_ok=True)
        raw = args.cache / args.model / voice / (out.stem + ".wav")
        raw.parent.mkdir(parents=True, exist_ok=True)
        if not (args.force or not raw.exists()):
            return out, encode(raw, out), None
        best = None
        for take in range(1 if args.no_check else args.takes):
            t_raw = raw.with_suffix(f".take{take}.wav")
            t_raw.write_bytes(synthesize(client, l["text"], l["tone"], l["part"], voice, args.model))
            t_out = out.with_suffix(f".take{take}.mp3")
            try:
                dur = encode(t_raw, t_out)
            except (ValueError, subprocess.CalledProcessError):
                continue  # (a silent or broken take: try again)
            sc, heard = (1.0, "") if args.no_check else score(client, t_out, l["text"])
            # (a slower take scores a little lower: the radio wants it brisk)
            rank = sc - 0.02 * max(0.0, dur - 0.5 - 0.07 * len(l["text"]))
            if best is None or rank > best[0]:
                best = (rank, take, dur, sc, heard)
            if sc >= MIN_SCORE:
                break
        if best is None:
            raise RuntimeError(f"no usable take for {l['text']!r}")
        _, take, dur, sc, heard = best
        raw.with_suffix(f".take{take}.wav").replace(raw)
        out.with_suffix(f".take{take}.mp3").replace(out)
        for p in list(raw.parent.glob(raw.stem + ".take*.wav")) + list(out.parent.glob(out.stem + ".take*.mp3")):
            p.unlink()
        return out, dur, {"text": l["text"], "file": out.name, "score": round(sc, 3), "heard": heard, "dur": round(dur, 2)}

    print(f"{len(jobs)} clip(s) to record ({args.model}, voice {args.voice if not args.audition else args.audition})")
    failed = 0
    report = []
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for i, f in enumerate(cf.as_completed([ex.submit(run, j) for j in jobs])):
            try:
                out, dur, rep = f.result()
                if rep:
                    report.append(rep)
                if dur is not None:
                    print(f"[{i + 1}/{len(jobs)}] {out.name} {dur:.2f}s" + (f"  {rep['score']:.2f} « {rep['heard']} »" if rep else ""))
            except Exception as e:  # noqa: BLE001 (report and carry on)
                failed += 1
                print(f"failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
    if report:
        args.report.write_text(json.dumps(sorted(report, key=lambda r: r["score"]), ensure_ascii=False, indent=1))
        weak = [r for r in report if r["score"] < MIN_SCORE]
        print(f"{len(weak)} clip(s) below {MIN_SCORE} after {args.takes} takes (report: {args.report})")
    total = sum(p.stat().st_size for p in args.out.rglob("*.mp3"))
    print(f"done, {failed} failed; {total / 1024:.0f} KB of clips in {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
