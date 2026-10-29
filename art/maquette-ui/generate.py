#!/usr/bin/env python3
"""Matières et icônes de l'UI « émail, laiton, papier » : art/maquette-ui/raw/<id>.webp (puis process.py).

    cd ~/famcrawl && fnox exec -- uv run --with requests --with pillow python art/maquette-ui/generate.py (depuis ~/famcrawl, avec le chemin complet) [ids…]

fal.ai (nano-banana-pro) : xAI et OpenAI n'avaient plus de crédit le 29/10/2026.
"""
import base64, io, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import requests
from PIL import Image

def generate(prompt, ratio):
    for attempt in range(5):
        r = requests.post("https://fal.run/fal-ai/nano-banana-pro",
            headers={"Authorization": f"Key {os.environ['FAL_KEY']}"},
            json={"prompt": prompt, "num_images": 1, "aspect_ratio": ratio, "resolution": "2K", "output_format": "png"},
            timeout=300)
        if r.ok:
            return Image.open(io.BytesIO(requests.get(r.json()["images"][0]["url"], timeout=120).content))
        print("retry", r.status_code, r.text[:200], file=sys.stderr, flush=True)
        time.sleep(5 * (attempt + 1))
    raise RuntimeError("fal: échec")

OUT = Path(__file__).parent / "raw"
NOTEXT = " Absolutely no text, no letters, no numbers, no words, no logo anywhere."
FLAT = " Photographed perfectly straight on, flat orthographic, even soft studio light, no perspective, no shadow outside the object."
ICON = ("A single round engraved medallion icon, circa 1900 Paris: polished brass relief motif on a deep navy-blue vitreous enamel disc, "
        "thin brass rim, the medallion fills the whole frame edge to edge. One bold simple motif readable at 40 pixels, "
        "Art Nouveau engraving, warm light." + FLAT + NOTEXT + " Motif: ")
JOBS = {
    "plaque": ("16:9", "An empty rectangular Paris street-name enamel plaque from 1900: smooth deep navy-blue vitreous enamel field, "
        "a thin ivory inner border line, a narrow polished brass bevelled outer frame with a small brass rivet in each corner. "
        "The plaque fills the entire image edge to edge, the field is plain and uniform so text can be placed on it later." + FLAT + NOTEXT),
    "plaque-bordeaux": ("16:9", "An empty rectangular enamel plaque from 1900: smooth deep burgundy-red vitreous enamel field, "
        "a thin ivory inner border line, a narrow polished brass bevelled outer frame with a small brass rivet in each corner. "
        "The plaque fills the entire image edge to edge, plain uniform field." + FLAT + NOTEXT),
    "bouton": ("21:9", "A long empty horizontal polished brass nameplate, like a 1900 locomotive builder's plate: warm golden brass, "
        "slightly domed, bevelled edges, fine Art Nouveau engraved border along the edge, plain smooth centre, a small rivet at each end. "
        "The plate fills the entire image edge to edge." + FLAT + NOTEXT),
    "papier": ("1:1", "Seamless texture of aged ivory lithograph poster paper from 1900: warm cream colour, subtle fibres, very faint foxing, "
        "uniform, no stains in the centre, no folds, flat lit, tileable." + NOTEXT),
    "cadran": ("1:1", "An empty round brass gauge bezel from a 1900 steam engine: thick polished knurled brass ring, inside a plain smooth "
        "navy-blue enamel face with nothing on it, glass reflection very subtle. Fills the frame edge to edge." + FLAT + NOTEXT),
    "frise": ("21:9", "An ornamental Art Nouveau brass divider in the style of Hector Guimard Paris Metro ironwork: a thin horizontal "
        "flowing whiplash line with a small floral motif in the centre, polished brass, isolated on a pure black background, "
        "occupying a thin horizontal band across the full width." + FLAT + NOTEXT),
    "i-campagne": ("1:1", ICON + "a rolled military map with a compass rose"),
    "i-escarmouche": ("1:1", ICON + "two crossed cavalry sabres"),
    "i-survie": ("1:1", ICON + "a stone fortress tower behind a shield"),
    "i-duel": ("1:1", ICON + "two antique candlestick telephones facing each other"),
    "i-arsenal": ("1:1", ICON + "a large wrench crossed over a cog wheel"),
    "i-archives": ("1:1", ICON + "an antique hand-cranked film camera"),
    "i-instruction": ("1:1", ICON + "a French kepi on top of an open book"),
    "i-medaille": ("1:1", ICON + "a military medal with ribbon"),
    "i-flamme": ("1:1", ICON + "a single flame"),
    "i-reglages": ("1:1", ICON + "a single cog wheel"),
    "i-construire": ("1:1", ICON + "a hammer and a trowel crossed"),
    "i-armee": ("1:1", ICON + "a flag on a pole with crossed rifles"),
    "i-pouvoir": ("1:1", ICON + "a lightning bolt"),
    "i-charbon": ("1:1", ICON + "a pile of coal lumps"),
    "i-selection": ("1:1", ICON + "four brass picture-frame corner brackets forming a square"),
    "i-stop": ("1:1", ICON + "an open raised gloved hand, palm forward"),
    "i-repli": ("1:1", ICON + "a curved arrow turning back towards a small flag"),
    "i-pause": ("1:1", ICON + "an antique pocket watch"),
    "i-baionnette": ("1:1", ICON + "a rifle with a long bayonet, diagonal"),
    "i-base": ("1:1", ICON + "a small factory with a tall chimney"),
    "i-vehicules": ("1:1", ICON + "a vintage 1900 armoured car seen from the side"),
    "i-infanterie": ("1:1", ICON + "the head and shoulders of a clockwork soldier wearing a kepi"),
    "i-cadenas": ("1:1", ICON + "an ornate antique padlock"),
    "i-cabinet": ("1:1", ICON + "an antique writing desk with a quill and an inkwell"),
    "i-encyclopedie": ("1:1", ICON + "a thick open book with a cog wheel on the page"),
    "i-aviation": ("1:1", ICON + "an early 1900 biplane seen from above"),
}

def job(k):
    ratio, prompt = JOBS[k]
    generate(prompt, ratio).convert("RGB").save(OUT / f"{k}.webp", quality=90)
    return k

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    ids = sys.argv[1:] or [k for k in JOBS if not (OUT / f"{k}.webp").exists()]
    with ThreadPoolExecutor(8) as ex:
        for k in ex.map(job, ids):
            print("ok", k, flush=True)
