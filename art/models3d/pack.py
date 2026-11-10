"""Passes brutes d'une cuisson (kit.py, auto.py : art/models3d/out/<nom>/) -> les trois textures du jeu.

  python3 art/models3d/pack.py creusot [--size 1024]
  python3 art/models3d/pack.py --all       # tout ce qui a été cuit, puis la liste src/game/three/skins-list.ts

- color.webp  : la couleur (un peu d'occlusion cuite dedans), alpha = masque de la couleur du camp
- normal.webp : le relief (espace tangent, +Y), alpha = masque des lampes
- orm.webp    : occlusion, rugosité, métal
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

here = os.path.dirname(os.path.abspath(__file__))
models = os.path.join(here, "..", "..", "public", "assets", "models")


def pack(name, size=None):
    raw = os.path.join(here, "out", name)
    d = os.path.join(models, name)
    if size is None:
        f = os.path.join(raw, "size.txt")
        size = int(open(f).read()) if os.path.exists(f) else 512
    load = lambda n: np.asarray(Image.open(os.path.join(raw, f"_{n}.png")).convert("RGB"), dtype=np.float32) / 255  # noqa: E731
    color, orm, extra, normal = load("color"), load("orm"), load("extra"), load("normal")
    # hors des îlots (rien de cuit : relief nul), chaque pixel prend son voisin cuit le plus proche,
    # pour que les réductions de la texture ne bavent pas de noir sur les coutures
    empty = normal.max(axis=2) < 0.02
    if empty.any() and not empty.all():
        dist, idx = ndimage.distance_transform_edt(empty, return_indices=True)
        # (sur quelques pixels seulement : au-delà, un fond uni se compresse mieux)
        far = (dist > 12 * color.shape[0] / 1024)[..., None]
        flat = (np.zeros(3), np.array([0.5, 0.5, 0.5]), np.zeros(3), np.array([0.5, 0.5, 1.0]))
        color, orm, extra, normal = (np.where(far, f, a[idx[0], idx[1]]).astype(np.float32) for a, f in zip((color, orm, extra, normal), flat))
    # (l'occlusion ne joue en jeu que sur la lumière ambiante : on en peint aussi dans la couleur, comme une texture peinte)
    color = color * (0.42 + 0.58 * np.clip(orm[..., 0:1] * 1.15, 0, 1))

    def save(arr, file, alpha=None, quality=90):
        to8 = lambda a, mode: Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)).convert(mode)  # noqa: E731
        fit = lambda im: im if im.width == size else im.resize((size, size), Image.LANCZOS)  # noqa: E731
        # (couleur et alpha réduits chacun de son côté : réduite en RGBA, la couleur serait multipliée par le masque)
        img = fit(to8(arr, "RGB"))
        if alpha is not None:
            img.putalpha(fit(to8(alpha, "L")))
        img.save(os.path.join(d, file), quality=quality, method=6, exact=True)
        return os.path.getsize(os.path.join(d, file))

    n = save(color, "color.webp", extra[..., 0], 84) + save(normal, "normal.webp", extra[..., 1], 86) + save(orm, "orm.webp", None, 75)
    return n + os.path.getsize(os.path.join(d, name + ".glb"))


args = [a for a in sys.argv[1:] if not a.startswith("--")]
size = int(sys.argv[sys.argv.index("--size") + 1]) if "--size" in sys.argv else None
if "--size" in sys.argv:
    args.remove(str(size))
names = args or sorted(n for n in os.listdir(os.path.join(here, "out")) if os.path.exists(os.path.join(here, "out", n, "_color.png")))
total = 0
for n in names:
    k = pack(n, size)
    total += k
    print(f"{n}: {k // 1024} Ko")
print(f"total {total / 1048576:.1f} Mo")
if "--all" in sys.argv:
    done = sorted(n for n in os.listdir(models) if os.path.exists(os.path.join(models, n, "color.webp")))
    with open(os.path.join(here, "..", "..", "src", "game", "three", "skins-list.ts"), "w") as f:
        f.write("// Écrit par art/models3d/pack.py --all : les modèles cuits présents dans public/assets/models.\n")
        f.write("export const SKIN_NAMES: readonly string[] = [\n" + "".join(f'  "{n}",\n' for n in done) + "];\n")
