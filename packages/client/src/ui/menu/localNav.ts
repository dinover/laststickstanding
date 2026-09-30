import { couch } from "../../app/local";
import { go } from "../../app/actions";

/** Entrar al armado del sillón desde el menú principal (arranca vacío, como en V1). */
export function openLocalSetup() {
  couch.set([]);
  go("localSetup");
}
