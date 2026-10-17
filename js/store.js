// 三茶大道芸ナビ - 状態管理・データ読み込み

import { toMin, perfKey, teamKey, DAYS, WEATHER_LAT, WEATHER_LNG } from "./util.js";

const LS = {
  favorites: "scd.favorites.v1",
  settings: "scd.settings.v1",
  seenChanges: "scd.seenChanges.v1",
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* ignore quota errors */
  }
}

export const state = {
  venues: [],
  performances: [],
  walktimes: null,
  routes: null,
  tieup: { stages: [] },
  checked: null,
  changes: null,
  appChangelog: null,
  performancesUpdatedAt: null,
  perfByKey: new Map(),
  teamSlotsMap: new Map(),
  favorites: new Set(loadJSON(LS.favorites, [])),
  settings: Object.assign(
    {
      fontSize: "normal", // normal | large
      simTime: null, // "2026-10-17T13:00" 等
      simGeo: null, // {lat,lng}
      geoOffset: null, // GPSのずれの手動補正 {dLat,dLng}。現在地(GPS)に足して使う
      autoLocate: false,
      theme: "system",
    },
    loadJSON(LS.settings, {})
  ),
  seenChangeAt: loadJSON(LS.seenChanges, null),
  currentGeo: null,
};

export function persistFavorites() {
  saveJSON(LS.favorites, [...state.favorites]);
}
export function persistSettings() {
  saveJSON(LS.settings, state.settings);
}
export function persistSeenChanges() {
  saveJSON(LS.seenChanges, state.seenChangeAt);
}

export function toggleFavorite(p) {
  const key = perfKey(p);
  if (state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  persistFavorites();
}
export function isFavorite(p) {
  return state.favorites.has(perfKey(p));
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`fetch failed: ${path}`);
  return res.json();
}

export async function loadAll() {
  const [venues, performances] = await Promise.all([
    fetchJSON("data/venues.json"),
    fetchJSON("data/performances.json"),
  ]);
  state.venues = venues.venues;
  state.performances = performances.performances.map((p) => ({
    ...p,
    startMin: toMin(p.start),
    endMin: toMin(p.end),
  }));
  state.performancesUpdatedAt = performances.updatedAt || null;
  state.perfByKey = new Map(state.performances.map((p) => [perfKey(p), p]));
  state.teamSlotsMap = new Map();
  [...state.performances]
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)
    .forEach((p) => {
      const k = teamKey(p);
      if (!state.teamSlotsMap.has(k)) state.teamSlotsMap.set(k, []);
      state.teamSlotsMap.get(k).push(p);
    });

  const optional = async (path, fallback) => {
    try {
      return await fetchJSON(path);
    } catch {
      return fallback;
    }
  };
  const [walktimes, routes, tieup, checked, changes, appChangelog] = await Promise.all([
    optional("data/walktimes.json", null),
    optional("data/routes.json", { routes: {} }),
    optional("data/tieup.json", { stages: [] }),
    optional("data/checked.json", null),
    optional("data/changes.json", { history: [] }),
    optional("data/app_changelog.json", { entries: [] }),
  ]);
  state.walktimes = walktimes;
  state.routes = routes;
  state.tieup = tieup;
  state.checked = checked;
  state.changes = changes;
  state.appChangelog = appChangelog;
}

export function perfByKey(key) {
  return state.perfByKey.get(key);
}
// 同じチームの全出演枠（日付・開始順）
export function teamSlots(p) {
  return state.teamSlotsMap.get(teamKey(p)) || [p];
}

export function venueById(id) {
  return state.venues.find((v) => v.id === id);
}

export function walkMinutes(idA, idB) {
  if (!state.walktimes || idA === idB) return 0;
  const { ids, minutes } = state.walktimes;
  const i = ids.indexOf(idA);
  const j = ids.indexOf(idB);
  if (i === -1 || j === -1) return null;
  return minutes[i][j];
}

export function routeBetween(idA, idB) {
  if (!state.routes) return null;
  const key = [idA, idB].sort().join("|");
  return state.routes.routes[key] || null;
}

export async function fetchWeather() {
  // Open-Meteoの予報は16日先まで。範囲外の日付を投げると400になるので、開催日が近づくまでは取得しない
  const firstDay = new Date(`${DAYS[0]}T00:00:00+09:00`);
  if (firstDay - Date.now() > 15 * 24 * 60 * 60 * 1000) {
    console.warn("[weather] 開催日が予報の取得可能期間（約16日）より先のため取得しません");
    return null;
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LNG}&hourly=temperature_2m,precipitation_probability,weathercode&timezone=Asia%2FTokyo&start_date=${DAYS[0]}&end_date=${DAYS[DAYS.length - 1]}`;
    const res = await fetch(url);
    if (!res.ok) {
      // 原因の切り分け用。取得できない間も画面側はプレースホルダーで枠を残す
      const body = await res.json().catch(() => null);
      console.warn("[weather] 取得に失敗:", res.status, body?.reason || "");
      return null;
    }
    const data = await res.json();
    const map = {};
    data.hourly.time.forEach((t, i) => {
      map[t] = {
        temp: data.hourly.temperature_2m[i],
        pop: data.hourly.precipitation_probability[i],
        code: data.hourly.weathercode[i],
      };
    });
    return map;
  } catch (e) {
    console.warn("[weather] 取得に失敗:", e);
    return null;
  }
}

export function weatherIcon(code) {
  if (code == null) return "";
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "☁️";
}
