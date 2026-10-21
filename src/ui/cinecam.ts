/**
 * AI vs AI: the 🎥 cinematic-camera toggle, under the zoom buttons (above ⚡).
 * Lit while the director has the camera, dimmed while it's off, and ringed
 * while the player has taken the camera for a moment (it hands back by itself).
 */
export interface CineToggle {
  set(on: boolean, held: boolean): void;
  destroy(): void;
}

export function mountCineToggle(root: HTMLElement, onToggle: () => void): CineToggle {
  const b = document.createElement("button");
  b.className = "zb cine";
  b.innerHTML = `<span class="ci">🎥</span>`;
  const stack = root.querySelector(".zoombtns");
  const jump = stack?.querySelector(".jump");
  if (jump) stack!.insertBefore(b, jump);
  else stack?.appendChild(b);
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.addEventListener("click", () => onToggle());
  let last = "";
  return {
    set(on, held) {
      const key = `${on}|${held}`;
      if (key === last) return;
      last = key;
      b.classList.toggle("on", on);
      b.classList.toggle("held", on && held);
      b.setAttribute("aria-pressed", String(on));
      b.title = !on
        ? "Caméra cinéma : off (C)"
        : held
        ? "Caméra cinéma : reprend sous peu, ou touche pour couper (C)"
        : "Caméra cinéma : on (C)";
    },
    destroy() {
      b.remove();
    }
  };
}
