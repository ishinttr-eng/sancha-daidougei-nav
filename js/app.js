// UI本体: 画面描画・イベント処理

import { store } from "./store.js";
import {
  el,
  minToHm,
  fmtDate,
  DAYS,
  normalize,
  perfKey,
  hmToMin,
} from "./util.js";

const WEATHER_ICON = { 0: "☀️", 1: "🌤", 2: "⛅", 3: "☁️", 45: "🌫", 61: "🌦", 63: "🌧", 65: "🌧", 80: "🌦", 95: "⛈" };
function weatherIcon(code) {
  if (code === undefined || code === null) return "";
  return WEATHER_ICON[code] || (code < 3 ? "🌤" : code < 50 ? "☁️" : "🌧");
}

let currentTab = "now";
const main = document.getElementById("main");
const changeBadge = document.getElementById("change-badge");

const TABS = [
  { id: "now", label: "演奏中", icon: "🎪" },
  { id: "timetable", label: "出演者", icon: "🗓" },
  { id: "map", label: "マップ", icon: "🗺" },
  { id: "mytimetable", label: "マイタイムテーブル", icon: "★" },
];

function render() {
  main.innerHTML = "";
  if (currentTab === "now") renderNow(main);
  else if (currentTab === "timetable") renderTimetable(main);
  else if (currentTab === "map") renderMap(main);
  else if (currentTab === "mytimetable") renderMyTimetable(main);
  renderTabBar();
  renderChangeBadge();
}

function renderTabBar() {
  const bar = document.getElementById("tabbar");
  bar.innerHTML = "";
  for (const t of TABS) {
    bar.appendChild(
      el(
        "button",
        {
          class: "tab" + (currentTab === t.id ? " active" : ""),
          onclick: () => {
            currentTab = t.id;
            render();
          },
        },
        [el("span", { class: "tab-icon" }, t.icon), el("span", { class: "tab-label" }, t.label)]
      )
    );
  }
}

function renderChangeBadge() {
  const hasChanges = store.changes?.history?.length > 0;
  changeBadge.style.display = hasChanges ? "inline-flex" : "none";
  changeBadge.onclick = () => openChangesModal();
}

// ---------------- 演奏中タブ ----------------
function renderNow(root) {
  const nowMin = store.currentMin();
  const date = store.currentDate();
  const loc = store.currentLocation();

  const playing = store.performances.filter(
    (p) => p.date === date && p.startMin <= nowMin && nowMin < p.endMin
  );
  const soon = store.performances.filter(
    (p) => p.date === date && p.startMin > nowMin && p.startMin - nowMin <= 30
  );

  root.appendChild(el("h2", { class: "section-title" }, `演奏中 (${fmtDate(date)} ${minToHm(nowMin)}時点)`));

  if (!loc) {
    root.appendChild(
      el("div", { class: "callout" }, [
        "現在地が未取得です。取得すると会場までの徒歩時間が表示されます。",
        el("button", { class: "btn-inline", onclick: async () => { await store.requestLocation(); render(); } }, "現在地を取得"),
      ])
    );
  }

  root.appendChild(el("h3", null, `いま演奏中 (${playing.length})`));
  if (playing.length === 0) root.appendChild(el("p", { class: "muted" }, "現在演奏中の出演者はいません。"));
  for (const p of playing) root.appendChild(perfCard(p, { loc }));

  root.appendChild(el("h3", null, `まもなく開始 (30分以内・${soon.length})`));
  if (soon.length === 0) root.appendChild(el("p", { class: "muted" }, "30分以内に開始予定の出演者はいません。"));
  for (const p of soon) root.appendChild(perfCard(p, { loc }));
}

function perfCard(p, { loc } = {}) {
  const venue = store.venueById(p.venueId);
  const fav = store.isFavorite(p);
  const w = store.weatherAt(p.date, p.startMin);

  let walkInfo = null;
  if (loc && venue) {
    const walkMin = store.walkMinFromLocation(loc.lat, loc.lng, venue.id);
    const arriveMin = store.currentMin() + walkMin;
    const ok = arriveMin <= p.endMin;
    walkInfo = el("div", { class: "walk-info " + (ok ? "ok" : "ng") }, `徒歩${walkMin}分 ・ ${ok ? "間に合う" : "間に合わない可能性"}`);
  }

  return el("div", { class: "perf-card", onclick: () => openDetail(p) }, [
    el("div", { class: "perf-top" }, [
      el("span", { class: "perf-time" }, `${p.start}-${p.end}`),
      el("span", { class: "perf-venue" }, venue?.name || p.venueId),
      w ? el("span", { class: "perf-weather" }, `${weatherIcon(w.code)} ${Math.round(w.temp)}℃`) : null,
    ]),
    el("div", { class: "perf-mid" }, [
      el("span", { class: "perf-name" }, p.name),
      p.genre ? el("span", { class: "perf-genre" }, p.genre) : null,
    ]),
    walkInfo,
    el(
      "button",
      {
        class: "fav-btn " + (fav ? "active" : ""),
        onclick: (e) => {
          e.stopPropagation();
          store.toggleFavorite(p);
          render();
        },
      },
      fav ? "★" : "☆"
    ),
  ]);
}

// ---------------- 出演者/タイムテーブルタブ ----------------
let ttState = { date: "all", query: "", venue: "", genre: "" };

function renderTimetable(root) {
  root.appendChild(el("h2", { class: "section-title" }, "出演者・タイムテーブル"));

  const dateTabs = el("div", { class: "date-tabs" });
  for (const d of ["all", ...DAYS]) {
    dateTabs.appendChild(
      el(
        "button",
        {
          class: "date-tab" + (ttState.date === d ? " active" : ""),
          onclick: () => {
            ttState.date = d;
            render();
          },
        },
        d === "all" ? "すべて" : fmtDate(d)
      )
    );
  }
  root.appendChild(dateTabs);

  const searchRow = el("div", { class: "search-row" }, [
    el("input", {
      type: "search",
      placeholder: "名前・かな・部門で検索",
      value: ttState.query,
      oninput: (e) => {
        ttState.query = e.target.value;
        render();
      },
    }),
  ]);
  root.appendChild(searchRow);

  const venues = [...new Set(store.performances.map((p) => p.venueId))];
  const genres = [...new Set(store.performances.map((p) => p.genre).filter(Boolean))];
  const filterRow = el("div", { class: "filter-row" }, [
    selectEl(ttState.venue, [["", "会場: すべて"], ...venues.map((id) => [id, store.venueById(id)?.name || id])], (v) => {
      ttState.venue = v;
      render();
    }),
    selectEl(ttState.genre, [["", "ジャンル: すべて"], ...genres.map((g) => [g, g])], (v) => {
      ttState.genre = v;
      render();
    }),
  ]);
  root.appendChild(filterRow);

  const q = normalize(ttState.query);
  let list = store.performances.filter((p) => {
    if (ttState.date !== "all" && p.date !== ttState.date) return false;
    if (ttState.venue && p.venueId !== ttState.venue) return false;
    if (ttState.genre && p.genre !== ttState.genre) return false;
    if (q) {
      const hay = normalize(`${p.name}${p.kana || ""}${p.awardEntry || ""}`);
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  list.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  root.appendChild(el("p", { class: "muted" }, `${list.length}件`));
  for (const p of list) root.appendChild(perfCard(p, { loc: store.currentLocation() }));
}

function selectEl(value, options, onChange) {
  const s = el(
    "select",
    { onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => {
      const o = el("option", { value: v }, label);
      if (v === value) o.selected = true;
      return o;
    })
  );
  return s;
}

// ---------------- マップタブ ----------------
let leafletMap = null;
let myRouteMode = false;

function renderMap(root) {
  root.appendChild(el("h2", { class: "section-title" }, "マップ"));
  root.appendChild(
    el("label", { class: "toggle-row" }, [
      el("input", {
        type: "checkbox",
        checked: myRouteMode ? "checked" : null,
        onchange: (e) => {
          myRouteMode = e.target.checked;
          render();
        },
      }),
      " マイルートモード（次に向かうお気に入り会場への経路を自動表示）",
    ])
  );
  const mapDiv = el("div", { id: "leaflet-map", class: "map-box" });
  root.appendChild(mapDiv);

  requestAnimationFrame(() => initLeaflet(mapDiv));
}

function initLeaflet(container) {
  if (typeof L === "undefined") {
    container.appendChild(el("p", { class: "muted" }, "地図ライブラリの読み込みに失敗しました（オフラインの可能性があります）。"));
    return;
  }
  const map = L.map(container).setView([35.6435, 139.6702], 16);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);

  for (const v of store.venues) {
    L.circleMarker([v.lat, v.lng], { radius: 8, color: "#106b64", fillColor: "#106b64", fillOpacity: 0.8 })
      .addTo(map)
      .bindPopup(`<strong>${v.name}</strong>`);
  }
  for (const s of store.tieup) {
    L.circleMarker([s.lat, s.lng], { radius: 6, color: "#a86c1f", fillColor: "#a86c1f", fillOpacity: 0.6 })
      .addTo(map)
      .bindPopup(`<strong>${s.name}</strong>${s.sponsor ? `<br>${s.sponsor}` : ""}`);
  }

  if (myRouteMode) drawMyRoute(map);
  leafletMap = map;
}

function drawMyRoute(map) {
  const nowMin = store.currentMin();
  const date = store.currentDate();
  const favs = store
    .favoritePerformances()
    .filter((p) => p.date === date && p.endMin > nowMin)
    .sort((a, b) => a.startMin - b.startMin);

  if (favs.length < 1) return;

  const loc = store.currentLocation();
  const points = [];
  if (loc) points.push([loc.lat, loc.lng]);
  for (const p of favs) {
    const v = store.venueById(p.venueId);
    if (v) points.push([v.lat, v.lng]);
  }
  if (points.length >= 2) {
    L.polyline(points, { color: "#a86c1f", weight: 4, dashArray: "6 6" }).addTo(map);
    map.fitBounds(points, { padding: [30, 30] });
  }
}

// ---------------- マイタイムテーブルタブ ----------------
function renderMyTimetable(root) {
  root.appendChild(el("h2", { class: "section-title" }, "マイタイムテーブル"));

  const favs = store.favoritePerformances();
  if (favs.length === 0) {
    root.appendChild(el("p", { class: "muted" }, "お気に入り（☆）に登録した出演者がここに表示されます。"));
    renderShareRow(root);
    return;
  }

  const date = store.currentDate();
  const nowMin = store.currentMin();
  const todays = favs.filter((p) => p.date === date).sort((a, b) => a.startMin - b.startMin);

  root.appendChild(el("p", { class: "muted" }, `${fmtDate(date)} のお気に入り: ${todays.length}件`));

  // 移動時間の警告チェック
  for (let i = 0; i < todays.length - 1; i++) {
    const a = todays[i];
    const b = todays[i + 1];
    if (a.venueId === b.venueId) continue;
    const walk = store.walkMinBetween(a.venueId, b.venueId);
    const gap = b.startMin - a.endMin;
    if (walk !== null && gap < walk) {
      root.appendChild(
        el(
          "div",
          { class: "callout warn", onclick: () => { currentTab = "map"; myRouteMode = true; render(); } },
          `⚠️ ${a.name} → ${b.name}: 移動${walk}分必要ですが間隔は${gap}分しかありません（タップでマップへ）`
        )
      );
    }
  }

  const list = renderScheduleColumns(todays);
  root.appendChild(list);

  for (const p of todays) {
    const isCurrent = p.startMin <= nowMin && nowMin < p.endMin;
    const card = perfCard(p, { loc: store.currentLocation() });
    if (isCurrent) card.classList.add("current");
    root.appendChild(card);
  }

  renderShareRow(root);
}

// グリーディ法で重なりを列に振り分け、最大3列。4列目以降は横スクロール領域へ
function renderScheduleColumns(items) {
  const cols = []; // 各列の最後の終了時刻
  const placed = items.map((p) => {
    let col = cols.findIndex((endMin) => endMin <= p.startMin);
    if (col === -1) {
      col = cols.length;
      cols.push(p.endMin);
    } else {
      cols[col] = p.endMin;
    }
    return { p, col };
  });
  const maxCol = Math.max(1, ...placed.map((x) => x.col + 1));
  const wrap = el("div", { class: "schedule-wrap" + (maxCol > 3 ? " scrollable" : "") });
  const grid = el("div", { class: "schedule-grid", style: `--cols:${maxCol}` });
  for (const { p, col } of placed) {
    const venue = store.venueById(p.venueId);
    grid.appendChild(
      el("div", { class: "schedule-block", style: `grid-column:${col + 1}` }, [
        el("div", { class: "sb-time" }, `${p.start}-${p.end}`),
        el("div", { class: "sb-name" }, p.name),
        el("div", { class: "sb-venue" }, venue?.name || p.venueId),
      ])
    );
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderShareRow(root) {
  root.appendChild(
    el("div", { class: "share-row" }, [
      el("button", { class: "btn", onclick: () => copyShareUrl() }, "共有リンクをコピー"),
      el("button", { class: "btn", onclick: () => downloadFavorites() }, "ファイルに書き出し"),
      el("label", { class: "btn file-btn" }, [
        "ファイルから読み込み",
        el("input", { type: "file", accept: "application/json", style: "display:none", onchange: (e) => uploadFavorites(e) }),
      ]),
    ])
  );
}

async function copyShareUrl() {
  const url = store.favoriteShareUrl();
  try {
    await navigator.clipboard.writeText(url);
    alert("共有リンクをコピーしました");
  } catch {
    prompt("以下のURLをコピーしてください", url);
  }
}

function downloadFavorites() {
  const blob = new Blob([store.exportFavorites()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sancha-daidougei-favorites.json";
  a.click();
}

function uploadFavorites(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      const keys = json.fav || [];
      const mode = confirm(`${keys.length}件のお気に入りを読み込みます。既存に追加する場合はOK、置き換える場合はキャンセル→再度置き換えを選択してください`) ? "merge" : "replace";
      store.importFavorites(keys, mode);
      render();
    } catch {
      alert("読み込みに失敗しました");
    }
  };
  reader.readAsText(file);
}

// ---------------- 詳細モーダル ----------------
function openDetail(p) {
  const venue = store.venueById(p.venueId);
  const modal = document.getElementById("modal");
  modal.innerHTML = "";
  modal.appendChild(
    el("div", { class: "modal-card" }, [
      el("button", { class: "modal-close", onclick: closeModal }, "×"),
      el("h3", null, p.name),
      el("p", { class: "muted" }, `${fmtDate(p.date)} ${p.start}-${p.end} / ${venue?.name || p.venueId}`),
      p.genre ? el("p", null, `ジャンル: ${p.genre}`) : null,
      p.region ? el("p", null, `活動地域: ${p.region}`) : null,
      p.intro ? el("p", null, p.intro) : null,
      p.awardEntry ? el("p", { class: "muted" }, `エントリー: ${p.awardEntry}`) : null,
    ])
  );
  modal.classList.add("open");
}

function openChangesModal() {
  const modal = document.getElementById("modal");
  modal.innerHTML = "";
  const history = store.changes?.history || [];
  modal.appendChild(
    el("div", { class: "modal-card" }, [
      el("button", { class: "modal-close", onclick: closeModal }, "×"),
      el("h3", null, "変更履歴"),
      ...history.map((h) =>
        el("div", { class: "change-entry" }, [
          el("div", { class: "muted" }, h.checkedAt),
          ...h.items.map((it) => el("div", null, `[${it.kind}] ${it.summary || JSON.stringify(it)}`)),
        ])
      ),
      history.length === 0 ? el("p", { class: "muted" }, "変更履歴はまだありません。") : null,
    ])
  );
  modal.classList.add("open");
}

function closeModal() {
  document.getElementById("modal").classList.remove("open");
}
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});

// ---------------- 設定モーダル ----------------
document.getElementById("settings-btn").addEventListener("click", openSettings);
function openSettings() {
  const modal = document.getElementById("modal");
  modal.innerHTML = "";
  modal.appendChild(
    el("div", { class: "modal-card" }, [
      el("button", { class: "modal-close", onclick: closeModal }, "×"),
      el("h3", null, "設定"),
      el("label", { class: "settings-row" }, [
        "文字サイズ: ",
        selectEl(store.settings.fontSize, [["normal", "標準"], ["large", "大"]], (v) => {
          store.settings.fontSize = v;
          store.saveSettings();
          applyFontSize();
        }),
      ]),
      el("label", { class: "settings-row" }, [
        "時刻シミュレーション: ",
        el("input", {
          type: "time",
          value: store.settings.simTime || "",
          onchange: (e) => {
            store.settings.simTime = e.target.value || null;
            store.saveSettings();
          },
        }),
      ]),
      el("p", { class: "muted" }, "会場非公開でも動作確認できるよう、現在地シミュレーションはマップタップで今後対応予定。"),
    ])
  );
  modal.classList.add("open");
}

function applyFontSize() {
  document.documentElement.dataset.fontsize = store.settings.fontSize;
}

// ---------------- 起動 ----------------
async function boot() {
  await store.init();
  applyFontSize();
  const importedFav = store.importFromUrl();
  if (importedFav && importedFav.length) {
    if (confirm(`共有リンクからお気に入り${importedFav.length}件を取り込みますか？`)) {
      store.importFavorites(importedFav, "merge");
    }
  }
  render();
  store.requestLocation().then(() => render());
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
