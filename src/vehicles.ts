// Standalone vehicles page (vehicles.html): every unit's card (unit-info.ts),
// plus the damage-type table, read from balance.ts so the page never drifts
// from the game.
import { DAMAGE_VS, UNITS } from "./sim/balance";
import { GROUPS, card } from "./unit-info";
import type { ArmorClass, DamageType, UnitKind } from "./sim/types";

document.getElementById("nav")!.innerHTML = GROUPS.flatMap((g) => g.kinds)
  .map((k) => `<a href="#${k}"><img src="./assets/icons/${k}.webp" alt="" />${UNITS[k].name}</a>`)
  .join("");

document.getElementById("units")!.innerHTML = GROUPS.map(
  (g) => `<h2 class="group">${g.title}</h2><div class="grid">${g.kinds.map((k) => card(k)).join("")}</div>`
).join("");

// the damage table: every damage type against every armour class, straight from DAMAGE_VS
const ARMOR_NAME: Record<ArmorClass, string> = {
  light: "Léger", medium: "Moyen", heavy: "Lourd", structure: "Bâtiments", infantry: "Infanterie"
};
const armors = Object.keys(ARMOR_NAME) as ArmorClass[];
const users = (t: DamageType): string =>
  (Object.keys(UNITS) as UnitKind[]).filter((k) => UNITS[k].dmgType === t).map((k) => UNITS[k].name).join(", ");
const DMG_NAME: Record<DamageType, string> = {
  kinetic: "cinétique", cannon: "canon", flak: "DCA", missile: "missile", explosive: "explosif", laser: "arc électrique", precision: "précision"
};
const cell = (m: number): string => `<td class="${m >= 1.2 ? "hi" : m <= 0.7 ? "lo" : ""}">×${String(m).replace(".", ",")}</td>`;
document.getElementById("damage")!.innerHTML = `<table class="dmg">
  <thead><tr><th>Dégâts</th>${armors.map((a) => `<th>${ARMOR_NAME[a]}</th>`).join("")}</tr></thead>
  <tbody>${(Object.keys(DAMAGE_VS) as DamageType[])
    .map((t) => `<tr><th>${DMG_NAME[t]}<small>${users(t)}</small></th>${armors.map((a) => cell(DAMAGE_VS[t][a])).join("")}</tr>`)
    .join("")}</tbody>
</table>`;
