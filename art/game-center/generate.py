#!/usr/bin/env python3
"""Les 21 médailles des succès Game Center (1024×1024, PNG opaque) : art/game-center/raw/<id>.png.

    cd ~/cnvsSC && fnox exec -- uv run --with requests --with pillow python ~/panache/art/game-center/generate.py [ids…]

Grok Imagine (xAI, XAI_API_KEY) : la clé OpenAI d'art/imagegen.py n'avait plus de crédit le 27/10/2026.
"""
import base64
import io
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from PIL import Image


def generate(prompt: str) -> Image.Image:
    for attempt in range(5):
        r = requests.post(
            "https://api.x.ai/v1/images/generations",
            headers={"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"},
            json={"model": "grok-imagine-image-2.0", "prompt": prompt, "n": 1, "aspect_ratio": "1:1", "resolution": "2k", "response_format": "b64_json"},
            timeout=300,
        )
        if r.ok:
            return Image.open(io.BytesIO(base64.b64decode(r.json()["data"][0]["b64_json"])))
        print("retry", r.status_code, r.text[:200], file=sys.stderr, flush=True)
        time.sleep(5 * (attempt + 1))
    raise RuntimeError("xAI: échec")

OUT = Path(__file__).parent / "raw"
STYLE = (
    "A single Belle Epoque French military decoration (circa 1900), centred, shown straight on, filling about 80% of the frame, "
    "on a deep midnight-blue velvet background with a soft warm vignette. Polished brass, gold and enamel, finely engraved, "
    "Art Nouveau ornaments, warm sunset lighting like a steampunk Paris painting, rich and painterly, high detail. "
    "Readable at small size: one strong central motif, bold silhouette. No text, no letters, no numbers, no words anywhere. "
    "The medal's central motif: "
)
MEDALS = {
    "premier-jour": "a white leather gauntlet pointing a finger, on a plain round bronze medal (first day of military training)",
    "deuxieme-jour": "two white leather gauntlets crossed over a parade ground map with a small flag, on a round bronze medal",
    "premiere-victoire": "a small tricolour French flag planted on a hill, laurel sprig, on a round bronze medal",
    "acte-1": "a sealed ultimatum letter with a red wax seal and a quill, on a round silver medal with laurel",
    "acte-2": "snowy mountain peaks with a steam airship flying between them, on a round silver medal with laurel",
    "acte-3": "the Eiffel Tower with fireworks, on a large gold star-shaped medal with a tricolour ribbon",
    "trente-six-etoiles": "a constellation of many small gold stars forming a crown, on a radiant gold medal with blue enamel",
    "epreuves": "a brass steam tank and a brass clockwork soldier crossed like a coat of arms, on a round silver medal",
    "difficile": "a grim iron skull wearing a kepi with crossed sabres, on a dark blackened steel medal with red enamel",
    "vingt-cinq-victoires": "a thick laurel wreath around crossed sabres, on a round gold medal",
    "lieutenant": "a shoulder epaulette with two thin gold stripes, on a silver shield-shaped insignia",
    "colonel": "a shoulder epaulette with five gold stripes and gold fringe, on a gold shield-shaped insignia",
    "marechal": "a marshal's baton, blue velvet with gold stars, crossed with laurel, on a magnificent gold seven-pointed star",
    "resistant": "a stone fortress tower standing firm under falling shells, on a round bronze medal",
    "inebranlable": "a lighthouse-like iron tower glowing in a storm of shells, on a round gold medal",
    "dix-medailles": "a fan of ten small different medals with ribbons, on a velvet cushion, gold frame",
    "tueur-de-gargantua": "a giant walking steam fortress toppling over, struck by a lightning bolt, on a round dark bronze medal",
    "voyage-dans-la-lune": "the Moon with a human face and a brass shell stuck in its eye (Melies), on a round silver medal with blue enamel",
    "sept-jours": "a tear-off calendar page with seven small flames above it, on a round copper medal",
    "duel": "two antique telephones facing each other with crossed sabres between them, on a round silver medal",
    "eclair-gagne": "a brass stopwatch with a lightning bolt across it, on a round gold medal with blue enamel",
}

def job(k: str) -> str:
    img = generate(STYLE + MEDALS[k]).convert("RGB").resize((1024, 1024), Image.LANCZOS)
    img.save(OUT / f"{k}.png")
    return k

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    ids = sys.argv[1:] or [k for k in MEDALS if not (OUT / f"{k}.png").exists()]
    with ThreadPoolExecutor(6) as ex:
        for k in ex.map(job, ids):
            print("ok", k, flush=True)
