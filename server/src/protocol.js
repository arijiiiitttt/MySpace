/**
 * Wire protocol shared (by convention) with client/src/net/protocol.js.
 *
 * A room has several maps. Movement, seats, computers and voice/video are per map; chat is shared.
 *
 * Everything is a JSON text frame: { t: <type>, ...fields }.
 * Short keys keep the 20 Hz movement stream small.
 *
 * client -> server
 *   join    { name, avatar, room, key?, map?, x?, y? }   map = which map to start on (reconnects send it)
 *   move    { x, y, a }               a = "idle_down" | "run_left" | "sit_up" ...
 *   chat    { text }
 *   emote   { e }
 *   sit     { chair }     stand {}
 *   pc      { id, on }                 use / leave a computer
 *   share   { id, on }                 start / stop screen sharing at a computer
 *   media   { mic, cam }               announce mic / camera state
 *   profile { name?, avatar? }
 *   rtc     { to, ch, pc?, d }         WebRTC signalling relay
 *   portal  { id }                     walk through the door `id` (you must be standing on it)
 *   ping    { n }
 *
 * server -> client
 *   hello   { id, you, room, map, where, spawn, players, seats, pcs, history, ice, serverTime }
 *   map     { map, you, spawn, players, seats, pcs }   you went through a door: this is the new map
 *   where   { c: { mapId: count } }     how many people are on each map
 *   joined  { p, from? }   left { id, to? }    from/to = the other map when someone used a door
 *   moves   { m: [[id, x, y, a], ...] }
 *   snap    { x, y }                    "you went somewhere you can't be"
 *   chat    { id, name, text, ts }      emote { id, e }
 *   seat    { chair, id|null }          pc { id, users, sharer }
 *   media   { id, mic, cam }            player { id, name?, avatar? }
 *   rtc     { from, ch, pc?, d }        pong { n }
 *   err     { code, msg }
 */

export const AVATARS = ["adam", "ash", "lucy", "nancy"];

export const EMOTES = ["wave", "laugh", "heart", "like", "party", "wow", "coffee", "think"];

export const LIMITS = {
  NAME_MAX: 20,
  CHAT_MAX: 280,
  CHAT_HISTORY: 50,
  ROOM_ID_MAX: 24,
  KEY_MAX: 64,
  MAX_MESSAGE_BYTES: 16 * 1024, // generous: SDP offers are the biggest thing we relay
  RTC_PAYLOAD_MAX: 12 * 1024,
};

export const ANIM_RE = /^(idle|run|sit)_(up|down|left|right)$/;
export const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** Strip control chars / zero-width tricks, collapse whitespace, clamp length. */
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function cleanRoomId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ROOM_RE.test(id) ? id : null;
}
