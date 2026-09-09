// 状態管理・データ読み込み・現在地/お気に入り/天気

import { perfKey, estimateWalkMin, nowMin, todayStr, DAYS } from "./util.js";

const FAV_KEY = "sancha-daidougei-favs";
const SETTINGS_KEY = "sancha-daidougei-settings";
const WEATHER_LAT = 35.6435; // 三軒茶屋付近。TODO: 実際の会場エリアに合わせて調整
const WEATHER_LNG = 139.6702;

export const store = {
  venues: [],
  performances: [],
  walktimes: null,
  routes: null,
  tieup: [],
  checked: null,
  changes: null,
  favorites: new Set(),
  weather: null, // { byHour: {"HH": {code, temp}} }
  location: null, // { lat, lng } または null
  settings: {
    fontSize: "normal", // "normal" | "large"
    simTime: null, // "HH:MM" or null（実時刻を使う）
    simLocation: null, // { lat, lng } or null
  },

  async init() {
    this._loadSettings();
    this._loadFavorites();
    const [venuesRes, perfRes, walkRes, tieupRes, checkedRes, changesRes] = await Promise.all([
      fetch("data/venues.json").then((r) => r.json()),
      fetch("data/performances.json").then((r) => r.json()),
      fetch("data/walktimes.json").then((r) => r.json()),
      fetch("data/tieup.json").then((r) => r.json()).catch(() => ({ stages: [] })),
      fetch("data/checked.json").then((r) => r.json()).catch(() => null),
      fetch("data/changes.json").then((r) => r.json()).catch(() => null),
    ]);
    this.venues = venuesRes.venues || [];
    this.performances = (perfRes.performances || []).map((p) => ({
      ...p,
      startMin: hmToMinSafe(p.start),
      endMin: hmToMinSafe(p.end),
    }));
    this.walktimes = walkRes;
    this.tieup = tieupRes.stages || [];
    this.checked = checkedRes;
    this.changes = changesRes;
    try {
      this.routes = await fetch("data/routes.json").then((r) => r.json());
    } catch {
      this.routes = null;
    }
    await this._loadWeather();
  },

  // ---- 時刻シミュレーション込みの「現在」 ----
  currentMin() {
    if (this.settings.simTime) return hmToMinSafe(this.settings.simTime);
    return nowMin();
  },
  currentDate() {
    return DAYS.includes(todayStr()) ? todayStr() : DAYS[0];
  },
  currentLocation() {
    return this.settings.simLocation || this.location;
  },

  // ---- 会場 ----
  venueById(id) {
    return this.venues.find((v) => v.id === id);
  },

  // ---- 徒歩時間 ----
  walkMinBetween(idA, idB) {
    if (idA === idB) return 0;
    if (this.routes?.routes) {
      const key1 = [idA, idB].sort().join("|");
      const r = this.routes.routes[key1];
      if (r) return r.durMin;
    }
    if (this.walktimes?.ids) {
      const i = this.walktimes.ids.indexOf(idA);
      const j = this.walktimes.ids.indexOf(idB);
      if (i >= 0 && j >= 0) return this.walktimes.minutes[i][j];
    }
    const a = this.venueById(idA);
    const b = this.venueById(idB);
    if (a && b) return estimateWalkMin(a.lat, a.lng, b.lat, b.lng);
    return null;
  },

  walkMinFromLocation(lat, lng, venueId) {
    const v = this.venueById(venueId);
    if (!v) return null;
    return estimateWalkMin(lat, lng, v.lat, v.lng);
  },

  // ---- お気に入り ----
  isFavorite(p) {
    return this.favorites.has(perfKey(p));
  },
  toggleFavorite(p) {
    const key = perfKey(p);
    if (this.favorites.has(key)) this.favorites.delete(key);
    else this.favorites.add(key);
    this._saveFavorites();
  },
  favoritePerformances() {
    return this.performances.filter((p) => this.favorites.has(perfKey(p)));
  },
  exportFavorites() {
    return JSON.stringify({ fav: [...this.favorites] });
  },
  importFavorites(keys, mode = "merge") {
    if (mode === "replace") this.favorites = new Set(keys);
    else for (const k of keys) this.favorites.add(k);
    this._saveFavorites();
  },
  favoriteShareUrl() {
    const url = new URL(location.href);
    url.searchParams.set("fav", [...this.favorites].join(","));
    return url.toString();
  },
  importFromUrl() {
    const params = new URLSearchParams(location.search);
    const fav = params.get("fav");
    if (fav) return fav.split(",").filter(Boolean);
    return null;
  },

  _loadFavorites() {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      this.favorites = new Set(raw ? JSON.parse(raw) : []);
    } catch {
      this.favorites = new Set();
    }
  },
  _saveFavorites() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify([...this.favorites]));
    } catch {
      /* noop */
    }
  },

  // ---- 設定 ----
  _loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) Object.assign(this.settings, JSON.parse(raw));
    } catch {
      /* noop */
    }
  },
  saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* noop */
    }
  },

  // ---- 現在地 ----
  requestLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this.location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          resolve(this.location);
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  },

  // ---- 天気（Open-Meteo、APIキー不要） ----
  async _loadWeather() {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LNG}&hourly=temperature_2m,weathercode&timezone=Asia%2FTokyo`;
      const res = await fetch(url);
      const json = await res.json();
      const byHour = {};
      (json.hourly?.time || []).forEach((t, i) => {
        const hh = t.slice(11, 13);
        const date = t.slice(0, 10);
        byHour[`${date}T${hh}`] = {
          code: json.hourly.weathercode[i],
          temp: json.hourly.temperature_2m[i],
        };
      });
      this.weather = { byHour };
    } catch {
      this.weather = null;
    }
  },
  weatherAt(dateStr, startMin) {
    if (!this.weather) return null;
    const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
    return this.weather.byHour[`${dateStr}T${hh}`] || null;
  },
};

function hmToMinSafe(hm) {
  if (!hm) return null;
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}
