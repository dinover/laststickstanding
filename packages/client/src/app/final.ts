import { finalScreen, type FinalState } from "./ui";
import { t } from "./i18n";

export interface FinalInput {
  ranked: number[];
  scores: Record<number, number>;
  nameFor(id: number): string;
  colorFor(id: number): string;
  hatFor(id: number): string;
  canRematch: boolean;
  showChangeMode: boolean;
  showBackMenu: boolean;
  unit?: string;
}

/** Arma la pantalla de resultados (compartida por Local y Online). */
export function showFinal(f: FinalInput) {
  const winner = f.ranked[0];
  const state: FinalState = {
    title: winner !== undefined ? t("final.wins", { name: f.nameFor(winner).toUpperCase() }) : t("final.noWinner"),
    winnerId: winner ?? null,
    winnerColor: winner !== undefined ? f.colorFor(winner) : "#35f0e0",
    winnerHat: winner !== undefined ? f.hatFor(winner) : "none",
    rows: f.ranked.map((id) => ({ id, name: f.nameFor(id), color: f.colorFor(id), score: f.scores[id] || 0 })),
    canRematch: f.canRematch,
    showChangeMode: f.showChangeMode,
    showBackMenu: f.showBackMenu,
    unit: f.unit || t("final.pts"),
  };
  finalScreen.set(state);
}

export function hideFinal() {
  finalScreen.set(null);
}
