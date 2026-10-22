"""Every generated asset in Battle Drones: prompt, canvas size, transparency.

Sprites are generated for the BLUE faction only; `process.py` derives the
red faction by hue-shifting the team-color panels, so every prompt keeps
blue strictly confined to team markings.
"""

# ------------------------------------------------------------ style contracts

STYLE = (
    "Game art for a modern top-down real-time strategy game about autonomous battle drones. "
    "Strictly top-down orthographic view, camera looking straight down from directly above "
    "(no perspective, no isometric angle, no side view, no tilt). Semi-realistic hand-painted "
    "sci-fi military style with crisp hard edges, a bold readable silhouette and rich detail "
    "that still reads when shown small on a phone. Soft studio lighting from the upper left. "
    "Materials: weathered gunmetal and dark graphite armor plates with vivid royal-blue "
    "team-color panels and stripes. Blue appears ONLY on the team-color panels: all glass, "
    "lenses and indicator lights are warm amber or smoked dark glass. "
    "No text, letters, numbers, logos, emblems or symbols anywhere."
)

ISOLATED = (
    "Isolated on a fully transparent background with generous empty margin on every side "
    "(nothing touches the image edges). No ground plane, no cast shadow, no drop shadow, "
    "no outer glow, no halo, no scenery, no border, no frame."
)

FACING = (
    "The machine faces straight up toward the top of the image: its nose, front and "
    "main gun point north."
)

PAIR = (
    "Show TWO separate parts side by side at exactly the same scale and in the same style, "
    "with a wide empty gap between them so they do not touch or overlap: "
)

UNIT = f"{STYLE} {FACING} {ISOLATED}"
BUILDING = (
    f"{STYLE} The structure is seen from directly above and fills a square footprint; "
    f"its outer edge is a clean square foundation slab. {ISOLATED}"
)

TEXTURE = (
    "Seamless tileable top-down ground texture for a real-time strategy game map, "
    "viewed from directly above, filling the entire square image edge to edge. "
    "Landscapes of France around 1900, painted like a Belle Époque illustration: soft "
    "painterly gouache and watercolour brushwork, a warm natural palette with a slight golden "
    "light. Natural detail at a scale where the whole image covers roughly 20 by 20 meters. "
    "Calm, low-contrast and low-noise so small game units stay readable on top of it. "
    "Even, flat, diffuse lighting with no strong directional shadows, no vignette, no large "
    "distinct objects, no horizon, no modern objects, no metal debris, no text. "
)

DOODADS = (
    "Top-down game decoration sprite sheet, viewed from directly above, for a real-time "
    "strategy map set around 1900, painted like a Belle Époque "
    "illustration (soft painterly gouache brushwork, warm natural palette, slight golden light). "
    "Nine separate objects arranged in a loose 3 by 3 grid with wide transparent gaps between "
    "them so none touch or overlap, in reading order (left to right, top row first). "
    "Each object is complete and uncut. Fully transparent background, no ground under the "
    "objects, no cast shadows, no modern machines, no metal wreckage, no text, no numbers. "
    "Objects, separated by semicolons: "
)

# -------------------------------------------------------------------- assets
# name -> dict(prompt, size, quality, transparent)

A: dict[str, dict] = {}


def unit(name: str, desc: str, size: str = "1024x1024") -> None:
    A[name] = dict(prompt=f"{desc} {UNIT}", size=size, quality="high", transparent=True)


def pair(name: str, what: str, left: str, right: str, kind: str = "unit") -> None:
    base = UNIT if kind == "unit" else BUILDING
    A[name] = dict(
        prompt=f"{what} {PAIR} LEFT: {left} RIGHT: {right} {base}",
        size="1536x1024",
        quality="high",
        transparent=True,
    )


# --- units -------------------------------------------------------------------

pair(
    "harvester",
    "An unmanned industrial scrap-harvester vehicle: a chunky, wide six-wheeled armored "
    "hauler with a heavy front grinder intake scoop and a large open-topped cargo bin "
    "taking up the rear half of the vehicle.",
    "the harvester with its cargo bin EMPTY (the bare metal bin floor is visible).",
    "the identical harvester with its cargo bin heaped FULL of rusty scrap metal chunks, "
    "gears and broken drone parts.",
)
unit(
    "scout",
    "A tiny, fragile reconnaissance quadcopter drone: a small teardrop central pod with one "
    "large amber camera eye at the front, four thin carbon arms in an X, and four rotors "
    "drawn as faint translucent spinning blur discs.",
)
pair(
    "stinger",
    "A small, fast unmanned light tank drone called the Stinger.",
    "the low tracked hull/chassis ALONE with an empty circular turret ring on top (no turret).",
    "the matching small turret ALONE: a compact armored dome with one long slender cannon "
    "barrel pointing straight up.",
)
pair(
    "flak-crawler",
    "A squat, low anti-aircraft tracked drone vehicle called the Flak Crawler.",
    "the wide low tracked hull ALONE with an empty circular turret ring on top (no turret).",
    "the matching anti-aircraft turret ALONE: a boxy mount with four short rapid-fire "
    "barrels pointing straight up and a small radar dish on the back.",
)
pair(
    "mortar",
    "A mobile artillery drone vehicle called the Mortar: long six-wheeled armored carrier "
    "with stabilizer legs folded along its sides.",
    "the six-wheeled carrier hull ALONE with an empty circular turret mount at its rear "
    "(no weapon).",
    "the matching artillery turret ALONE: a heavy squat mount with one very thick short "
    "mortar tube pointing straight up.",
)
pair(
    "mastodon",
    "A massive unmanned super-heavy battle tank called the Mastodon, broad and brutal.",
    "the huge hull ALONE: wide twin tracks on each side, thick sloped armor, an empty large "
    "circular turret ring in the middle (no turret).",
    "the matching huge turret ALONE: heavily armored wedge-shaped turret with TWO thick "
    "long cannon barrels side by side pointing straight up.",
)
pair(
    "lancer",
    "A sleek unmanned hover tank called the Lancer that floats on anti-gravity pads (no "
    "tracks, no wheels).",
    "the smooth angular hover hull ALONE with four round glowing amber thruster pads "
    "underneath the corners and an empty circular turret ring on top (no turret).",
    "the matching slim turret ALONE: a sleek mount with one long laser lance emitter "
    "pointing straight up, ending in an amber crystal focusing lens.",
)
unit(
    "wasp",
    "An aggressive dart-shaped strike drone called the Wasp: narrow arrowhead fuselage with "
    "a sharp nose, two small forward wings carrying rocket pods, and two ducted fans at the "
    "tail.",
)
unit(
    "raptor",
    "A sleek air-superiority interceptor drone called the Raptor: like a small unmanned "
    "stealth fighter jet with swept delta wings, twin tail fins, twin engine nozzles at the "
    "back and a pointed nose.",
)
unit(
    "hornet",
    "A heavy bomber drone called the Hornet: a big broad armored flying-wing body with four "
    "large ducted fans, one at each corner, and an open central bomb bay holding a rack of "
    "bombs. Bulky, heavy and menacing.",
)
unit(
    "mender",
    "A support repair drone called the Mender: a rounded hovering drone with a central "
    "repair module, two small articulated manipulator arms with welding tools at the front, "
    "a few small green status lights, and three small rotors drawn as faint translucent "
    "blur discs.",
)
unit(
    "condor",
    "A troop-transport dropship drone called the Condor: a long boxy armored fuselage with an "
    "armored nose at the top end carrying a small amber cockpit canopy, a large OPEN-TOPPED "
    "troop bay in the middle of the fuselage showing two rows of fold-down seats either side "
    "of a central amber floor stripe, a lowered loading ramp at the tail end, two short stubby "
    "wings sticking straight out sideways from the middle of the fuselage with one large round "
    "ducted fan at each wingtip (fan blades visible inside the shroud), and a single small "
    "tail fin at the rear. Chunky and utilitarian.",
)

# Infantry: squads of small bipedal robots, several robots in one image.
SQUAD = (
    "Seen from directly overhead like a drone camera looking straight down: only the tops of "
    "the heads, the shoulder pads, the backs and the weapons are visible, the legs mostly "
    "hidden under the bodies. Every robot faces north (toward the top of the image) and "
    "holds its weapon pointing north; small gaps between them so they do not overlap."
)
unit(
    "trooper",
    "A Trooper Squad: a tight wedge formation of FIVE small identical bipedal combat robots. "
    "Each robot is chunky and blocky: a small square light-grey head with a thin amber visor "
    "slit and a short antenna with an amber tip, two big blocky royal-blue shoulder pads, a "
    "dark graphite torso and backpack, and a compact dark assault rifle held forward. "
    f"{SQUAD}",
)
unit(
    "rocket-squad",
    "A Rocket Squad: THREE bulky heavy bipedal combat robots in a tight triangle formation. "
    "Each robot is broad and blocky: a small grey head with an amber visor, big blocky "
    "royal-blue shoulder pads, a wide dark graphite back carrying a small rack of three spare "
    "rockets with red-tipped noses, and a long thick dark rocket-launcher tube resting on its "
    f"right shoulder, its open muzzle pointing north. {SQUAD}",
)
unit(
    "sniper",
    "A Sniper Team: TWO lean bipedal sniper robots standing side by side, one slightly ahead "
    "of the other. Each robot wears a SHORT olive-green camouflage poncho draped over its "
    "shoulders and back (a compact cape with a few frayed edges, not trailing behind), a small "
    "rounded olive hood over the head whose opening faces north toward the rifle (the face is "
    "hidden under it, seen only as the top of the hood), and a royal-blue collar panel at the "
    "shoulders; its slim dark graphite arms reach forward to hold a long slender rail rifle "
    "with small amber coil rings along the barrel, the barrel reaching about one body length "
    "ahead of the robot. The two robots are drawn large and together fill a roughly square "
    f"area. {SQUAD}",
)

# --- buildings -----------------------------------------------------------------

def building(name: str, desc: str) -> None:
    A[name] = dict(prompt=f"{desc} {BUILDING}", size="1024x1024", quality="high", transparent=True)


building(
    "hq",
    "Command headquarters of a drone army: a large fortified armored command center with a "
    "central domed command module, antenna and sensor arrays, heavy armored corner bastions, "
    "landing lights, and a wide vehicle bay door on the bottom edge.",
)
building(
    "fab-plant",
    "Ground vehicle factory: an industrial assembly plant with a large vehicle bay door on "
    "the bottom edge, overhead gantry crane rails, roof vents and exhaust stacks, and "
    "stacked parts containers.",
)
building(
    "airpad",
    "Drone airfield launch pad: a raised square landing platform with a large circular pad "
    "marking ring (no letters), corner service towers, refuelling hoses, and rows of small "
    "amber landing lights.",
)
building(
    "tech-lab",
    "High-tech research laboratory: an advanced sci-fi facility with a glass-domed amber "
    "reactor core in the middle, coolant pipes, server racks, a small satellite dish and "
    "sleek white-and-graphite modules.",
)
building(
    "depot",
    "Scrap refinery drop-off depot: an industrial building with a large open receiving "
    "hopper, crushers, conveyor belts and neat stacks of processed metal ingots.",
)
building(
    "assembly-bay",
    "Robot infantry factory (assembly bay): an open-roofed industrial assembly floor with a "
    "central assembly cradle holding a half-built blocky bipedal robot (grey head with an "
    "amber visor, royal-blue shoulder pads, legs not yet attached), two articulated robotic "
    "gantry arms with welding tools reaching over it, a conveyor belt carrying robot parts "
    "across the floor, a row of three finished robot frames docked in charging alcoves along "
    "the top edge, a round exit pad near the bottom edge, and amber work lights.",
)
pair(
    "turret",
    "A defensive autocannon gun turret emplacement.",
    "the square armored foundation base ALONE with an empty circular mount in the middle "
    "(no gun).",
    "the rotating gun head ALONE: an armored round head with twin autocannon barrels "
    "pointing straight up.",
    kind="building",
)
pair(
    "sam-site",
    "A surface-to-air missile defense site.",
    "the square armored foundation base ALONE with an empty circular mount in the middle "
    "(no launcher).",
    "the rotating launcher head ALONE: a boxy launcher holding a pack of six missiles, their "
    "white-tipped noses pointing straight up.",
    kind="building",
)
pair(
    "radar",
    "A radar sensor station.",
    "the square armored foundation base ALONE with equipment cabinets and an empty circular "
    "mount in the middle (no dish).",
    "the rotating radar antenna ALONE: a wide curved rectangular radar dish on a small hub, "
    "seen from above.",
    kind="building",
)
# --- map objectives (neutral: no team colour, the engine draws the owner's ring) ---

NEUTRAL = (
    "Game art for a modern top-down real-time strategy game about autonomous battle drones. "
    "Strictly top-down orthographic view, camera looking straight down from directly above "
    "(no perspective, no isometric angle, no side view, no tilt). Semi-realistic hand-painted "
    "sci-fi military style with crisp hard edges, a bold readable silhouette and rich detail "
    "that still reads when shown small on a phone. Soft studio lighting from the upper left. "
    "This object is NEUTRAL and belongs to no army: weathered gunmetal and dark graphite "
    "armor with hazard-yellow and black safety stripes and warm amber lights. Absolutely NO "
    "blue and NO red anywhere. No text, letters, numbers, logos, emblems or symbols anywhere."
)

A["uplink"] = dict(
    prompt=(
        "A capturable battlefield uplink relay station that any army can seize. "
        f"{PAIR} LEFT: the round flat armored relay platform ALONE, a low circular deck like a "
        "landing pad, ringed by a raised steel rim with hazard-yellow and black chevron "
        "stripes, four small equipment cabinets with amber beacon lights evenly spaced around "
        "the rim, cable trunks running inward, and an empty circular mount in the exact centre "
        "(no antenna). RIGHT: the matching rotating relay antenna head ALONE: a compact armored "
        "hub carrying one wide curved satellite dish and two slim antenna spikes, seen from "
        f"directly above. {NEUTRAL} {ISOLATED}"
    ),
    size="1536x1024",
    quality="high",
    transparent=True,
)
A["supply-crate"] = dict(
    prompt=(
        "An air-dropped military supply crate seen from directly above: a sturdy square armored "
        "cargo container with reinforced dark corner brackets, bold hazard-yellow and black "
        "striped edges, a grid of lashing straps across the lid, four amber beacon lights on "
        f"the corners and lifting lugs. Compact and chunky, perfectly square. {NEUTRAL} {ISOLATED}"
    ),
    size="1024x1024",
    quality="high",
    transparent=True,
)

A["rubble"] = dict(
    prompt=(
        "Top-down game sprite sheet of FOUR separate destroyed-building rubble piles arranged "
        "in a 2 by 2 grid with wide transparent gaps between them: broken concrete slabs, "
        "twisted steel girders, scorched armor plates, burned debris and black scorch marks, "
        "each pile roughly square. Viewed from directly above, semi-realistic hand-painted "
        "style, dark grey and charred. Fully transparent background, no ground, no text."
    ),
    size="1024x1024",
    quality="high",
    transparent=True,
)
A["decals"] = dict(
    prompt=(
        "Top-down game decal sprite sheet of SIX separate ground decals arranged in a 3 by 2 "
        "grid with wide transparent gaps: a small blast crater, a large blast crater with "
        "scattered debris, a black scorch burn mark, a dark oil stain splatter, a pair of "
        "tank track marks, a small scorched crater with embers. Viewed from directly above, "
        "semi-realistic hand-painted style, soft natural edges that fade out. Fully "
        "transparent background, no text."
    ),
    size="1536x1024",
    quality="high",
    transparent=True,
)
A["scrap"] = dict(
    prompt=(
        "Top-down game sprite sheet of SIX separate piles of salvageable scrap metal arranged "
        "in a 3 by 2 grid with wide transparent gaps between them: rusty broken machine "
        "parts, gears, pipes, bent plates, wires and wrecked drone pieces, each pile a "
        "compact roughly round heap of a different shape. Viewed from directly above, "
        "semi-realistic hand-painted style, rusty orange-brown and grey metal. No blue. "
        "Fully transparent background, no ground, no shadows, no text."
    ),
    size="1536x1024",
    quality="high",
    transparent=True,
)
A["crystal"] = dict(
    prompt=(
        "Top-down game sprite sheet of SIX separate clusters of large glowing emerald-green "
        "energy crystals growing out of small rocks, arranged in a 3 by 2 grid with wide "
        "transparent gaps between them. Each cluster is compact and roughly round with sharp "
        "faceted shards pointing outward. Viewed from directly above, semi-realistic "
        "hand-painted style, vivid green and teal-green, luminous. No blue. Fully transparent "
        "background, no ground, no text."
    ),
    size="1536x1024",
    quality="high",
    transparent=True,
)
A["explosion"] = dict(
    prompt=(
        "Game VFX sprite sheet: EIGHT frames of one explosion animation arranged in a 4 by 2 "
        "grid (read left to right, top row then bottom row), all frames the same scale and "
        "centered in equal cells with transparent gaps: 1 a small white-hot flash, 2 a bright "
        "yellow-orange expanding fireball, 3 a large billowing orange fireball with sparks, "
        "4 the biggest fireball starting to darken, 5 fire breaking up into dark smoke, "
        "6 mostly dark grey smoke with glowing embers, 7 thinning grey smoke puffs, 8 faint "
        "dissipating wisps. Viewed from directly above, semi-realistic painted style. Fully "
        "transparent background, no text, no numbers."
    ),
    size="1536x1024",
    quality="high",
    transparent=True,
)

# --- terrain materials per biome ----------------------------------------------------

BIOMES: dict[str, dict[str, str]] = {
    # French bocage (Riverlands, Proving Grounds)
    "temperate": {
        "ground": "soft green pasture of short even meadow grass with a warm golden-green tint, "
        "a few tiny clover leaves and scattered daisies, gentle low-contrast brushwork",
        "ground2": "worn ochre-brown beaten earth of a farmyard or meadow path, packed dry soil "
        "with faint straw, sparse grass tufts and a few small pebbles",
        "rough": "freshly ploughed field of rich warm brown earth with soft irregular furrows, "
        "clods and a little straw stubble",
        "rock": "pale cream-grey limestone outcrop with layered ledges, cracks, grey and ochre "
        "lichen and small tufts of grass in the joints",
        "liquid": "calm river water, deep green-blue, with gentle ripples and soft pale sky "
        "reflections",
        "road": "old French country road paved with rounded grey granite cobblestones (pavés) "
        "set in tight irregular rows, sand and a little moss in the joints",
        "forest": "dense oak and beech woodland canopy seen from directly above: tightly packed "
        "round tree crowns in warm greens with touches of olive and gold, dark shade between "
        "the crowns",
    },
    # period-neutral desert (Dune Sea)
    "desert": {
        "ground": "fine warm golden desert sand with soft wind ripples",
        "ground2": "rocky desert reg: pale tan packed gravel plain with small flat stones",
        "rough": "rocky desert scree of loose broken ochre stones and gravel with a few dry "
        "scrub tufts",
        "rock": "warm ochre and red sandstone bedrock with layered strata, cracks and wind "
        "erosion",
        "liquid": "open clear blue-green oasis water with gentle ripples, water only edge to "
        "edge: no islands, no plants, no sand banks",
        "road": "packed dusty caravan track of pale earth with two faint wagon-wheel ruts and "
        "small stones",
        "forest": "dense grove of date palms and dry scrub seen from directly above, packed "
        "palm fronds and olive-green shrubs with dark shade between",
    },
    # Alpine winter (Frostbite)
    "arctic": {
        "ground": "smooth fresh white alpine snowfield, very calm and even, only faint soft "
        "undulations and the lightest cool blue shadows, almost no texture",
        "ground2": "wind-packed snow and pale blue ice with fine cracks",
        "rough": "trampled snow with sled-runner tracks, footprints and patches of dry "
        "straw-coloured alpine grass showing through",
        "rock": "grey alpine granite rock with frost and small patches of snow in the cracks",
        "liquid": "dark teal glacial lake water with thin floating ice floes",
        "road": "snowy mountain track of packed snow with sled-runner and wagon tracks and a "
        "little gravel showing through",
        "forest": "dense alpine forest canopy seen from directly above: tightly packed spruce, "
        "pine and larch tops dusted with snow, dark shade between them",
    },
    # Auvergne volcanic land, the puys (Ashlands)
    "volcanic": {
        "ground": "dark grey-brown volcanic ash soil with sparse short olive-green grass tufts "
        "and small dark pebbles",
        "ground2": "dark cracked basalt slabs with dusty seams and a little moss",
        "rough": "loose black and rust-red volcanic scoria cinders (pouzzolane) and gravel",
        "rock": "dark grey basalt rock with the hexagonal tops of basalt columns, cracks and "
        "pale lichen",
        "liquid": "molten glowing orange-yellow lava with dark cooling crust plates",
        "road": "old road paved with worn dark basalt cobblestones (pavés) set in irregular "
        "rows, ash in the joints",
        "forest": "sparse dark pine woods seen from directly above, ash-dusted pine crowns "
        "with a few charred bare trunks and dark gaps between",
    },
    # Brittany coast (Archipelago)
    "tropical": {
        "ground": "Breton coastal moorland: short wind-cropped green turf with soft patches of "
        "purple heather and small yellow gorse flecks, low contrast",
        "ground2": "pale golden beach sand, fine and soft, with tiny shell fragments and faint "
        "footprint dimples",
        "rough": "wet grey-brown tidal flat (estran) of sand and mud with strands of brown "
        "kelp and bladderwrack seaweed and small shallow pools",
        "rock": "rounded weathered pink-grey Breton granite rock with smooth eroded forms, "
        "cracks and orange and yellow lichen",
        "liquid": "open clear emerald-turquoise Atlantic cove water over a pale sandy bottom, "
        "with soft light ripples, water only edge to edge: no seaweed, no rocks, no islands",
        "road": "pale sandy cart track running lengthwise with two parallel wagon-wheel ruts "
        "and a thin strip of grass along the middle",
        "forest": "dense windswept coastal woodland canopy seen from directly above: tightly "
        "packed maritime pine crowns and round oak crowns in deep greens with dark shade "
        "between the crowns",
    },
}

for biome, mats in BIOMES.items():
    for mat, desc in mats.items():
        A[f"tex-{biome}-{mat}"] = dict(
            prompt=f"{TEXTURE}Material: {desc}.",
            size="1024x1024",
            quality="medium",
            transparent=False,
        )

# In reading order; the painter (art/terrain.py) keys off the cell: 0-2 are always tree crowns.
DOODAD_SETS = {
    "temperate": "a large round oak tree crown; a round lighter-green beech tree crown; "
    "a round apple tree crown dotted with small red apples; a big pale limestone boulder "
    "with moss; a small cluster of pale limestone stones; a round golden haystack; "
    "a neat stack of cut firewood logs; an old wooden two-wheeled farm cart with big spoked "
    "wheels loaded with hay; a small patch of red poppies and wildflowers",
    "desert": "a date palm top with radiating fronds; a smaller palm top; a dense palm "
    "top with dry brown fronds; a large ochre sandstone boulder; a cluster of small red "
    "stones; a dry thorny scrub bush; a broken wicker hot-air-balloon basket lying on its "
    "side with loose ropes; a small stack of abandoned wooden expedition crates with rope "
    "lashings; an abandoned wooden covered wagon with one broken spoked wheel",
    "arctic": "a snow-covered spruce top; a snow-dusted larch top; a small snowy pine "
    "top; a snowy dark granite boulder; a cluster of ice chunks; a frozen shrub poking "
    "through snow; a soft snow drift mound; the roofless ruin of a small stone alpine "
    "refuge hut with snow inside its walls; a wooden sled loaded with wooden crates and "
    "ice axes",
    "volcanic": "a dark ash-dusted pine crown; a half-charred pine crown with bare black "
    "branches; a small dark pine crown; a dark basalt boulder; a cluster of small "
    "dark lava stones with faint glowing orange cracks; a tight cluster of hexagonal "
    "basalt column tops; an abandoned wooden mine cart on a short length of rail; the "
    "roofless ruin of a small dark lava-stone hut; a tuft of dry yellow grass and heather",
    "tropical": "a windswept maritime pine crown; a broad round oak crown; a dense "
    "gorse bush covered in small yellow flowers; a lichen-covered pink-grey granite "
    "boulder; a scatter of seashells and small pebbles; a small beached wooden rowing "
    "boat; a low clump of purple heather; a beached Breton wooden sailing fishing boat "
    "with a furled red-brown sail; a stack of wicker lobster pots with coiled rope",
}
for biome, objs in DOODAD_SETS.items():
    A[f"doodads-{biome}"] = dict(
        prompt=f"{DOODADS}{objs}.", size="1024x1024", quality="high", transparent=True
    )

# --- menu art ------------------------------------------------------------------------

KEY_ART = (
    "Epic cinematic key art for a French Belle Époque real-time strategy game called Panache "
    "(about 1900, steampunk-tinged but grounded): a dramatic high-angle view over a "
    "battlefield in the French countryside at golden dusk. A navy-blue-bannered army clashes "
    "with a burgundy-bannered army across a river valley: riveted bronze land ironclads on "
    "tracks, steam traction engines, early armoured cars with spoked wheels, six-legged brass "
    "mechanical spider guns, clockwork automaton soldiers in képis; overhead, cigar-shaped "
    "dirigibles, a Montgolfier-style balloon transport, bat-winged flying machines and a "
    "Jules-Verne-style rotor airship. In the background a distant Eiffel-like iron lattice "
    "radio tower and smokestacks of a foundry. Cannon smoke, Congreve rocket trails, shell "
    "bursts, gaslight glows. Painterly semi-realistic concept art in the spirit of a Belle "
    "Époque poster and Jules Verne engravings, warm sepia-gold light against cool shadows, "
    "strong depth. Leave the upper third as calmer sky suitable for a title overlay. "
    "Absolutely no text, letters, logos or UI."
)
A["keyart-portrait"] = dict(prompt=KEY_ART, size="1024x1536", quality="high", transparent=False)
A["keyart-landscape"] = dict(prompt=KEY_ART, size="1536x1024", quality="high", transparent=False)
A["icon"] = dict(
    prompt=(
        "Mobile game app icon for Panache, a French Belle Époque strategy game: a proud "
        "cigar-shaped observation dirigible with a varnished cream canvas envelope ringed with "
        "polished brass bands, a navy-blue stripe and navy fins, a wooden gondola with warm "
        "gaslit windows and a spinning propeller, seen at a dynamic three-quarter angle, "
        "flying toward the viewer over a deep navy night sky with a soft golden glow and a "
        "hint of cannon smoke behind it. Bold, simple, high contrast, readable at small sizes, "
        "subject centered inside the middle 75 percent. Painterly semi-realistic style. "
        "No text, no letters, no border."
    ),
    size="1024x1024",
    quality="high",
    transparent=False,
)

# ------------------------------------------------------------------ title screen (Panache)
# Parallax layers for the cinematograph title screen (src/ui/title.ts): a painted backdrop and
# cut-out actors that CSS drifts in front of it.
TITLE_STYLE = (
    "Painterly semi-realistic Belle Époque illustration in the spirit of a 1900 Paris poster and "
    "Jules Verne engravings, warm sepia-gold dusk light against cool shadows. No text, no letters, "
    "no logos, no UI."
)
A["titre-fond"] = dict(
    prompt=(
        "Wide panoramic backdrop: Paris at golden dusk seen from the heights of Montmartre around "
        "1900, a sea of grey slate mansard roofs and chimneys, the Seine glinting, the Eiffel Tower "
        "standing tall in the middle distance, factory smokestacks and a few searchlight beams, a "
        "huge dramatic sky with glowing clouds taking the upper half. Keep the sky EMPTY of any "
        "aircraft or balloons. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=False,
)
A["titre-dirigeable"] = dict(
    prompt=(
        "A single cigar-shaped observation dirigible seen exactly from the side, flying to the "
        "right: varnished cream canvas envelope ringed with polished brass bands, a navy-blue "
        "stripe along its length and navy tail fins, a small wooden gondola with warm gaslit "
        "windows hanging below, a spinning propeller at the back. Isolated on a fully transparent "
        "background, no ground, no shadow. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=True,
)
A["titre-montgolfiere"] = dict(
    prompt=(
        "A single ornate Montgolfier-style hot-air balloon, upright: an envelope of alternating "
        "navy-blue and ivory vertical gores with gilded bands and garlands, a wicker-and-wood "
        "basket with a small brass brazier glowing, a few ropes. Isolated on a fully transparent "
        "background, no ground. " + TITLE_STYLE
    ),
    size="1024x1536",
    quality="high",
    transparent=True,
)
A["titre-gargantua"] = dict(
    prompt=(
        "A giant two-legged walking steam fortress called Gargantua, seen in three-quarter view "
        "mid-stride: riveted bronze body like a small mansion with a navy-blue mansard roof, twin "
        "smokestacks puffing coal smoke, gaslit portholes, round turrets with cannon on each "
        "shoulder, a diving-helmet head with one glowing porthole eye, massive elephant-like "
        "riveted legs with brass bands. Isolated on a fully transparent background, no ground. "
        + TITLE_STYLE
    ),
    size="1024x1536",
    quality="high",
    transparent=True,
)
A["titre-heros"] = dict(
    prompt=(
        "Foreground hero character, waist-up and slightly from below, looking proudly to the "
        "right: a clockwork automaton officer of the French army around 1900, polished brass "
        "body with an ivory clock-dial face and warm amber glowing eyes, a navy-blue greatcoat "
        "with brass buttons and gold epaulettes, a navy képi, a curled brass moustache, one hand "
        "holding a sabre raised, a wind-up key on its back. Isolated on a fully transparent "
        "background. " + TITLE_STYLE
    ),
    size="1024x1536",
    quality="high",
    transparent=True,
)
# The intro "silent film" (src/ui/title.ts): wide shots the camera pans across.
A["intro-marche"] = dict(
    prompt=(
        "Wide cinematic shot of a misty battlefield in the French countryside at dawn around 1900: "
        "a giant two-legged riveted bronze steam walking fortress with a navy-blue mansard roof and "
        "twin smoking stacks strides forward through coal smoke, while long ranks of clockwork brass "
        "automaton soldiers in navy-blue kepis and greatcoats march in step with Lebel rifles, "
        "riveted land ironclads on tracks behind them, navy banners. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=False,
)
A["intro-feu"] = dict(
    prompt=(
        "Wide cinematic shot at dusk of a great artillery duel in the French countryside around 1900: "
        "in the foreground a French 75 field gun fires, a huge billowing cloud of white black-powder "
        "smoke and a bright muzzle flash; across a river valley burgundy-bannered steam war machines "
        "and a six-legged brass mechanical spider gun; the sky is full of bat-winged flying "
        "machines, a striped Montgolfier hot-air balloon, cigar-shaped dirigibles and bursting "
        "Congreve firework rockets. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=False,
)

# Nation crests (PANACHE-CONCEPTION.md §1.1; menu picker, HUD pill, end screens):
# fictional heraldry only, no real coat of arms, no text.
CREST_STYLE = (
    "Belle Époque heraldic emblem in the style of an 1900 enamelled brass badge and engraved "
    "Art Nouveau poster ornament: crisp clean silhouette that stays readable when shrunk to "
    "32 pixels, rich enamel colours, polished brass and gold rims, soft painterly shading. "
    "Centered, upright, symmetric. Isolated on a fully transparent background with a small "
    "empty margin, no ground, no shadow outside the badge. No text, no letters, no numbers, "
    "no banners with writing, no flags of real countries, no real coat of arms."
)
A["crest-republique"] = dict(
    prompt=(
        "A fictional republican crest: a rounded shield of deep navy-blue enamel framed by a "
        "golden laurel wreath; on the shield the profile head of a serene allegorical young woman "
        "wearing a Phrygian-like cap with a star, in polished brass relief, crossed behind her by "
        "a stylised golden lightning bolt; small electric sparks; a thin cream and brass rim; a small five-pointed star at the top of the wreath and a knot of ribbon at its base (no fleur-de-lis, no crown). "
        + CREST_STYLE
    ),
    size="1024x1024",
    quality="high",
    transparent=True,
)
A["crest-empire"] = dict(
    prompt=(
        "A fictional industrial empire crest: a squared heater shield of deep burgundy-crimson "
        "enamel with a riveted blackened iron rim; on the shield a heavy blacksmith anvil over a "
        "large brass cog wheel, two factory smokestacks rising behind them puffing small grey "
        "smoke curls; above the shield a crenellated mural crown of dark iron and brass. "
        "Stern, heavy, steam-and-coal mood. " + CREST_STYLE
    ),
    size="1024x1024",
    quality="high",
    transparent=True,
)

# ------------------------------------------------------------------ campaign chapters (Panache)
# « La Campagne de 1900 » (src/ui/cine.ts): one still per chapter, shown under the silent-film
# intertitles before a mission (sepia-filtered on screen). Fictional nations only: the République
# (navy blue, brass, glass, electric arcs) and the Empire de Carbonie (burgundy, rivets, coal smoke).
# No real flags, insignia, uniforms or real battles.
A["chap-1"] = dict(
    prompt=(
        "Wide cinematic shot of a stone bridge over a broad river at dawn on the edge of Paris around "
        "1900, the Eiffel Tower faint in the mist far behind: on the near bank two tall copper "
        "electric coil towers crackle with blue arcs beside a lattice wireless mast, slim streamlined "
        "electric racing cars painted navy blue wait behind sandbags; on the far bank a column of "
        "boxy burgundy steam armoured cars puffs black coal smoke toward the bridge. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=False,
)
A["chap-carbonie"] = dict(
    prompt=(
        "Wide comic cinematic shot of a volcanic plateau at sunset, smoking craters and glowing lava "
        "rivers: a pompous stout marshal with enormous waxed moustaches, a monocle, a burgundy "
        "greatcoat covered in brass medals and a plumed bicorne hat proudly points his sabre, beside "
        "a gigantic riveted steam mortar on a tracked locomotive carriage firing a huge shell with a "
        "cloud of black smoke; clockwork automaton soldiers in burgundy salute stiffly. Playful, "
        "never cruel. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=False,
)
A["chap-2"] = dict(
    prompt=(
        "Wide cinematic shot of a snowy Alpine mountain pass at dusk around 1900: a convoy of padded "
        "navy-blue electric delivery vans with spoked wheels, carrying crates that glow faint green, "
        "climbs a winding road toward a railway tunnel mouth, escorted by a sleek navy hover-boat on "
        "the frozen lake; above the pass, burgundy riveted steam tanks with smokestacks and dug-in "
        "sandbag trenches wait in ambush, an eagle soars over the peaks. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=False,
)
A["chap-3"] = dict(
    prompt=(
        "Wide cinematic shot of a desert of golden dunes under a violent night storm around 1900: "
        "eerie green-white radium lightning crackles between the clouds and strikes brass machines; "
        "in the foreground a young woman chemist in a long Edwardian dress and lab apron holds up a "
        "glowing glass vial, beside a navy-blue officer with a magnificent moustache and a kepi; far "
        "away burgundy steam machines advance through the sand. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=False,
)
A["chap-paris"] = dict(
    prompt=(
        "Wide cinematic shot of the Champ-de-Mars in Paris on a summer evening around 1900, the Eiffel "
        "Tower towering in the centre with a wireless antenna at its top and a festive tricolour-free "
        "string of lanterns: a colossal two-legged riveted burgundy steam walking fortress with "
        "smokestacks strides across the Seine bridge toward the tower, while above it a huge sleek "
        "navy-blue rigid airship with a glazed gondola and four propellers swoops down, searchlights "
        "blazing, fireworks bursting in the sky. " + TITLE_STYLE
    ),
    size="1536x1024",
    quality="high",
    transparent=False,
)
