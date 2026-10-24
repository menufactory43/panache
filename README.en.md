# Panache

*[Version française](README.md)*

**Panache** is a real-time strategy game for phones and browsers, set in Belle Époque France (around 1900): airships, Steam Wagons, armoured Creusots, automata in kepis, Gargantua the walking fortress — and plenty of panache.

**Play: <https://menufactory43.github.io/panache/en/>** (in French: <https://menufactory43.github.io/panache/>)

Panache is a French adaptation of Simon Willison's [Battle Drones](https://github.com/simonw/battledrones) (Apache 2.0 licence): translation, new names, 3D models, effects, sound, music, title screen and a reworked mobile interface, then modes and mechanics of its own. Add `?style=original` to the address to compare with the original style.

## What's inside

- **Training**, two lessons guided by a gloved hand, one gesture at a time. *First Day* (3 min): camera, selection, orders, building, production, a unit's card (long-press), ⚔ Army, coal, the Rolling Barrage. *Second Day* (4 min): double tap, ▢ Frame, groups, routes, marching in order, ⚑ Fall back, idle units, a skill.
- **The 1900 Campaign**: 12 missions in three acts (*The Ultimatum*, *The War of the Peaks*, *Paris!*), played now for the Republic, now for the Empire of Carbonia, with silent-film title cards, a briefing and three stars each. Three levels to pick in the briefing: **Recruit**, **Normal**, **Veteran** — stars are only earned on Normal, but a win on any level opens the next mission. Alongside it, 8 **Classic Trials**.
- **Two asymmetric nations**, the Republic and the Empire of Carbonia, each with its own units, buildings and powers — or Classic mode, symmetric.
- **Skirmish** against an AI with several personalities and three difficulties, on 6 maps (Proving Grounds, River Lands, Sea of Dunes, Frostbite, Ashlands, Archipelago) or a generated map, playable blind (*Uncharted*). Mutators change the rules for both sides.
- **Online duel** between two phones with a room code (the relay is a Cloudflare Worker, in `relay/`), and **Lightning** mode: a six-minute match on points.
- **Last Stand**: announced waves, endless, with a boss every fifth.
- **Real RTS controls under a finger**: marching in order (long-press the destination, then drag to draw the front), drawn routes and patrols, groups 1–3, looping production ↻, six unit **skills** (Fix bayonets!, Full throttle, Dig in, Precision shot, Charge, Barrage), commander powers.
- **Career** (ranks, medals, stars), **Daily Op**, **Archives** with replays and highlights, and **resuming** an interrupted match.
- **French and English**, down to the radio voice (over 600 recorded lines in each language).

The game's full help is under **? How to play**.

## Development

```bash
npm install
npm run dev            # Vite dev server
npx vitest run         # the tests
npm run build          # typecheck + build into dist/
npm run smoke          # the real touch flow, headless (against dist/)
npm run ios            # the iPhone app: build, copy into ios/ (Capacitor) and open Xcode
```

Before every push to `main`: `npx vitest run`, `npm run build` and `npm run smoke`. The push runs the **Publier Panache** workflow (GitHub Pages, about a minute). The duel relay deploys separately, from `relay/` (see `relay/README.md`).

Design documents (in French): `PANACHE-CONCEPTION.md` (nations and campaign), `ANGLAIS.md` (the English version's glossary), `DUEL.md`, `DESIGN.md`, `GOLIATH.md`, `INFANTRY.md`. The original Battle Drones README, with its tools (arena, balance, art), follows the French text in [README.md](README.md).
