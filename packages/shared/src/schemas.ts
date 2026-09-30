/* Validación de los mensajes del cliente (solo servidor). */
import { z } from "zod";
import { INPUT_KEYS } from "./constants";
import type { ClientMsg } from "./protocol";

const nick = z.string().max(40).optional();
const color = z.string().max(16).nullish();
const hat = z.string().max(16).nullish();
const code = z.string().max(8);
const anyData = z.unknown();

export const ClientMsgSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ping"), ts: z.number() }),
  z.object({ t: z.literal("create"), nick, color, hat }),
  z.object({ t: z.literal("join"), code, nick, color, hat }),
  z.object({ t: z.literal("rejoin"), code, token: z.string().max(64) }),
  // Frames de input en lote: el cliente puede mandar más de uno por paquete si se atrasó.
  z.object({ t: z.literal("in"), f: z.array(z.tuple([z.number().int(), z.number().int().min(0).max(31)])).max(12) }),
  z.object({ t: z.literal("setMode"), mode: z.string().max(16) }),
  z.object({ t: z.literal("setRounds"), rounds: z.number() }),
  z.object({ t: z.literal("start") }),
  z.object({ t: z.literal("again") }),
  z.object({ t: z.literal("endMatch") }),
  z.object({ t: z.literal("leave") }),
  // Sala de mandos (celulares como control del modo Local)
  z.object({ t: z.literal("padCreate"), token: z.string().max(64).optional() }),
  z.object({ t: z.literal("padTo"), pad: z.number().int(), data: anyData }),
  z.object({ t: z.literal("padAll"), data: anyData }),
  z.object({ t: z.literal("padKick"), pad: z.number().int(), reason: z.string().max(32).nullish() }),
  z.object({ t: z.literal("padClose") }),
  z.object({ t: z.literal("padJoin"), code, nick, token: z.string().max(64).optional() }),
  z.object({ t: z.literal("padInput"), k: z.enum(INPUT_KEYS), d: z.boolean() }),
  z.object({ t: z.literal("padMsg"), data: anyData }),
]);


// el esquema y el tipo tienen que coincidir: si alguien agrega un mensaje a uno solo, esto no compila
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const _schemaMatchesType: Same<z.infer<typeof ClientMsgSchema>, ClientMsg> = true;
