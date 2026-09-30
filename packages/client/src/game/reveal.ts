/* Reveal de puntajes del modo infinito (cada 5 rondas): los puntajes de todos en una línea y
   después, de a uno, los datos graciosos de la partida (quién tiró más patadas, quién se cayó más).
   La animación de tipeo la hace el componente; acá solo se arma el contenido. */

import type { MatchStats } from "@lss/shared";
import { scoreReveal, type RevealSeg } from "../app/ui";
import { t } from "../app/i18n";
import { audio } from "../audio/audio";

const STAT_KEYS: (keyof MatchStats)[] = ["kicks", "punches", "falls", "hitsLanded", "hitsTaken"];

export function showScoreReveal(
  roster: number[], scores: Record<number, number>, stats: Record<number, MatchStats> | undefined,
  nameFor: (id: number) => string, colorFor: (id: number) => string,
) {
  const ids = roster.slice().sort((a, b) => a - b);
  const line1: RevealSeg[] = [];
  ids.forEach((id, i) => {
    if (i > 0) line1.push({ text: "   ·   ", color: null });
    line1.push({ text: nameFor(id) + " " + (scores[id] || 0), color: colorFor(id) });
  });
  const order = STAT_KEYS.slice().sort(() => Math.random() - 0.5);
  const seq: RevealSeg[] = [];
  for (const key of order) {
    let bestId: number | null = null, bestN = 0;
    for (const id of ids) {
      const n = (stats && stats[id] && stats[id][key]) || 0;
      if (n > bestN) { bestN = n; bestId = id; }
    }
    if (bestId !== null) seq.push({ text: t("stat." + key, { name: nameFor(bestId), v: bestN }), color: colorFor(bestId) });
  }
  audio.on.uiClick();
  scoreReveal.set({ line1, stats: seq });
}

export function hideScoreReveal() {
  scoreReveal.set(null);
}
