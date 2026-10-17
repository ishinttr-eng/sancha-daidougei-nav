import * as store from "./store.js";
import {
  DAYS,
  DAY_LABELS,
  el,
  normalize,
  perfKey,
  teamKey,
  isPerfFinished,
  fmtRange,
  todayStr,
  nowMin,
  toMin,
  minToHHMM,
  estimateWalkMin,
  isVenueFinished,
  isFestivalOver,
  debounce,
} from "./util.js";

const $main = document.getElementById("main");
const $modalRoot = document.getElementById("modal-root");

let activeTab = "now";
const ui = {
  artistsDay: null, // null=未選択（開催日ならその日、それ以外は初日）| 日付 | "team"
  artistsSearch: "",
  artistsVenue: "",
  artistsGenre: "",
  mapMode: "normal", // normal | myroute
  mapSearch: "",
  myttMode: null, // list | schedule | null（未指定=お気に入り会場数から自動選択。明示選択が優先）
};
const finishedOpen = { now: new Set(), artists: new Set(), mytt: new Set(), slots: new Set(), warn: new Set() };
const MYTT_LIST_MAX_VENUES = 8; // この会場数以下ならリスト、超えたらスケジュール表を既定にする
const HELP_URL = "help.html";
const LS_HELP_SEEN = "scd.helpSeen.v1";
const venueCollapseOpen = new Set();

const mapState = {
  instance: null,
  center: null,
  zoom: null,
  layer: null,
  geoMarker: null,
  singleRoute: null,
  myRouteSegInfo: null,
  myRouteApplyHighlight: null,
  myRouteFocusMap: null,
  selectedVenueId: null,
};

// 選択中の会場ピンの色を即座に反映する（地図タブを表示中なら再描画、そうでなければ何もしない）
function refreshMapMarkers() {
  if (mapState.instance) {
    const { date, min } = curDateMin();
    drawMapLayer(date, min);
  }
}
let weatherData = null;
let geoWatchStarted = false;
let myRouteIndex = 0; // マイルートでフォーカス中の区間（カードのスワイプで移動）
const ROUTE_COLORS = ["#ff2f92", "#3ddc84", "#3f7dff", "#ffb703", "#a78bfa", "#f97316", "#22d3ee", "#f43f5e"];
const MYROUTE_CARD_H = 56; // 1カード分の高さ(px)。スワイプの1コマ分＝この高さ

// ---------- time / geo helpers ----------
function effectiveNow() {
  if (store.state.settings.simTime) return new Date(store.state.settings.simTime);
  return new Date();
}
function effectiveGeo() {
  if (store.state.settings.simGeo) return store.state.settings.simGeo;
  return store.state.currentGeo;
}
function curDateMin() {
  const d = effectiveNow();
  return { date: todayStr(d), min: nowMin(d) };
}

function isNowPlaying(p, date, min) {
  return p.date === date && p.startMin <= min && min < p.endMin;
}
function isSoon(p, date, min) {
  // 演目が30分に満たない場合は「まもなく」が意味を成さないので出さない
  return p.endMin - p.startMin >= 30 && p.date === date && p.startMin > min && p.startMin <= min + 30;
}

// ---------- generic render ----------
function render() {
  applyTabVisibility();
  document.getElementById("app").classList.toggle("screen-map", activeTab === "map");
  $main.innerHTML = "";
  const { date, min } = curDateMin();
  const over = isFestivalOver(store.state.performances, date, min);

  if (over && (activeTab === "artists" || activeTab === "map")) activeTab = "now";

  if (activeTab === "now") renderNow($main, date, min, over);
  else if (activeTab === "artists") renderArtists($main, date, min);
  else if (activeTab === "map") renderMap($main, date, min);
  else if (activeTab === "mytt") renderMyTT($main, date, min, over);

  syncTabButtons();
}

function applyTabVisibility() {
  const { date, min } = curDateMin();
  const over = isFestivalOver(store.state.performances, date, min);
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const t = btn.dataset.tab;
    const hide = over && (t === "artists" || t === "map");
    btn.hidden = hide;
  });
}
function syncTabButtons() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === activeTab);
  });
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    render();
  });
});

// ---------- weather badge ----------
function weatherBadgeFor(dateStr, startMin) {
  // 予報が取れない間もバッジは消さず「-」で残す（壊れているのか時期が早いだけなのか区別するため）
  const hour = Math.floor(startMin / 60);
  const key = `${dateStr}T${String(hour).padStart(2, "0")}:00`;
  const w = weatherData?.[key];
  if (!w) return el("span", { class: "badge weather" }, "- -° -%");
  return el("span", { class: "badge weather" }, `${store.weatherIcon(w.code)} ${Math.round(w.temp)}° ${w.pop}%`);
}

// ---------- performance card ----------
function perfCard(p, { date, min, showVenue = true, showDate = false } = {}) {
  const venue = store.venueById(p.venueId);
  const playing = isNowPlaying(p, date, min);
  const soon = isSoon(p, date, min);
  const card = el("div", {
    class: `perf-card${playing ? " now" : ""}${soon ? " soon" : ""}`,
    onclick: () => openDetailModal(p),
  });
  const timeCol = el("div", { class: "time" }, [
    document.createTextNode(fmtRange(p.start, p.end)),
    showDate ? el("div", {}, DAY_LABELS[p.date] || p.date) : null,
  ]);
  const body = el("div", { class: "body" });
  body.appendChild(el("div", { class: "name" }, p.name));
  if (showVenue && venue) body.appendChild(el("div", { class: "venue-name" }, `${venue.stageNo}. ${venue.name}`));

  const badges = el("div", { class: "badges" });
  if (playing) badges.appendChild(el("span", { class: "badge ok" }, "● 上演中"));
  else if (soon) badges.appendChild(el("span", { class: "badge" }, "まもなく開始"));

  const geo = effectiveGeo();
  if (geo && venue && (playing || soon)) {
    const walk = estimateWalk(geo, venue);
    const remain = p.startMin - min;
    const ok = playing || walk <= Math.max(remain, 0);
    badges.appendChild(
      el("span", { class: `badge ${ok ? "ok" : "ng"}` }, `🚶 徒歩${walk}分 ${ok ? "間に合う" : "間に合わない"}`)
    );
  }
  const wb = weatherBadgeFor(p.date, p.startMin);
  if (wb) badges.appendChild(wb);
  if (badges.children.length) body.appendChild(badges);

  const favBtn = favButton(p);
  card.append(timeCol, body, favBtn);
  applyFavState(favBtn, p); // カードに繋がってから反映する（作成時はclosestがnullになるため）
  return card;
}

// ---------- お気に入りの見分けと時間の重なり ----------
// ☆の見た目: 登録済み=★ / 同じチームの別枠が登録済み=☆(アクセント色) / どちらでもない=☆(グレー)
// カード: 登録済み=塗り+帯 / 登録済みの別の枠と時間が重なる=薄い青の塗り+バッジ（出演者タブのみ）
function favButton(p) {
  return el(
    "button",
    {
      class: "fav-btn",
      "data-pid": perfKey(p), // idではなくperfKey。同じidが複数枠を持つため
      "aria-label": "お気に入り",
      onclick: (e) => {
        e.stopPropagation();
        onToggleFav(p);
      },
    },
    "☆"
  );
}

function hasOtherSlotFavorite(p) {
  return store.teamSlots(p).some((q) => q !== p && store.isFavorite(q));
}

// 同じ日で時間が重なり、登録済みの別の枠（端が接するだけは重ならない）
function conflictingFavorite(p) {
  if (store.state.favorites.size === 0 || store.isFavorite(p)) return null;
  return (
    store.state.performances.find(
      (x) => x.date === p.date && x.startMin < p.endMin && p.startMin < x.endMin && store.isFavorite(x)
    ) || null
  );
}

function applyFavState(btn, p) {
  const fav = store.isFavorite(p);
  const slotRow = btn.closest(".slot-row");
  btn.textContent = fav ? "★" : "☆";
  btn.classList.toggle("active", fav);
  btn.classList.toggle("other", !fav && !slotRow && hasOtherSlotFavorite(p));
  slotRow?.classList.toggle("faved", fav);
  const card = btn.closest(".perf-card");
  if (!card) return;
  card.classList.toggle("faved", fav && activeTab !== "mytt");
  const clash = activeTab === "artists" ? conflictingFavorite(p) : null;
  card.classList.toggle("clash", !!clash);
  card.querySelector(".clash-badge")?.remove();
  if (clash) {
    const v = store.venueById(clash.venueId);
    card.querySelector(".body")?.appendChild(el("div", { class: "clash-badge" }, `${v ? v.stageNo + ". " : ""}${clash.name}`));
  }
}

// 画面全体を再描画するとスクロール位置や入力欄のフォーカスが失われるので、☆だけ全部更新する
function refreshFavButtons() {
  document.querySelectorAll(".fav-btn[data-pid]").forEach((b) => {
    const p = store.perfByKey(b.dataset.pid);
    if (p) applyFavState(b, p);
  });
  // 詳細モーダル上部の大きなお気に入りボタン（枠リストの☆と同期させる）
  document.querySelectorAll(".fav-main[data-pid]").forEach((b) => {
    const p = store.perfByKey(b.dataset.pid);
    if (p) applyMainFavState(b, p);
  });
}

function applyMainFavState(btn, p) {
  const fav = store.isFavorite(p);
  btn.textContent = fav ? "★ お気に入り登録済み" : "☆ お気に入りに追加";
  btn.classList.toggle("primary", fav);
}

function onToggleFav(p) {
  store.toggleFavorite(p);
  // マイタイムテーブルは一覧の中身そのものが変わるので再描画。それ以外は☆の更新だけで済ます
  if (activeTab === "mytt") render();
  refreshFavButtons(); // マイタイムテーブル再描画時も、前面の詳細モーダルの☆は更新が必要
}

function estimateWalk(geo, venue) {
  return estimateWalkMin(geo.lat, geo.lng, venue.lat, venue.lng);
}

// 現在地取得の導線。未取得時はボタンを、取得済み/シミュレーション中は状態テキストを表示する
function locationRow() {
  if (store.state.settings.simGeo) {
    return el(
      "div",
      { class: "loc-row" },
      el("span", { class: "sub-note" }, "📍 現在地シミュレーション中（⚙️設定で変更できます）")
    );
  }
  if (store.state.currentGeo) {
    return el(
      "div",
      { class: "loc-row" },
      el("span", { class: "sub-note" }, "📍 現在地取得済み（徒歩時間は直線距離からの目安）")
    );
  }
  const btn = el(
    "button",
    {
      class: "btn small",
      onclick: async (e) => {
        e.target.textContent = "取得中…";
        try {
          await locateOnce();
        } catch {
          e.target.textContent = "現在地を取得できませんでした（再試行）";
        }
      },
    },
    "📍 現在地を取得して徒歩時間を表示"
  );
  return el("div", { class: "loc-row" }, btn);
}

function finishedDetails(key, label, content) {
  const d = el("details", { class: "finished-group" });
  d.open = finishedOpen[key.screen].has(key.id);
  d.addEventListener("toggle", () => {
    if (d.open) finishedOpen[key.screen].add(key.id);
    else finishedOpen[key.screen].delete(key.id);
  });
  d.appendChild(el("summary", {}, label));
  d.appendChild(content);
  return d;
}

// ---------- Tab: 上演中 ----------
function renderNow(root, date, min, over) {
  if (over) {
    root.appendChild(overPanel());
    return;
  }
  root.appendChild(el("h1", { class: "screen-title" }, "🎪 上演中"));
  if (store.state.settings.simTime) {
    root.appendChild(el("div", { class: "sub-note" }, `⏱ 時刻シミュレーション中: ${DAY_LABELS[date] || date} ${minToHHMM(min)}`));
  }
  root.appendChild(locationRow());

  const playing = store.state.performances.filter((p) => isNowPlaying(p, date, min));
  const soon = store.state.performances.filter((p) => isSoon(p, date, min));

  if (!playing.length && !soon.length) {
    root.appendChild(
      el("div", { class: "empty-state" }, [
        el("span", { class: "emoji" }, "🤹"),
        el("div", {}, "今上演中のステージはありません"),
      ])
    );
  } else {
    if (playing.length) {
      root.appendChild(el("h3", {}, "上演中"));
      playing
        .sort((a, b) => a.startMin - b.startMin)
        .forEach((p) => root.appendChild(perfCard(p, { date, min })));
    }
    if (soon.length) {
      root.appendChild(el("h3", {}, "まもなく開始（30分以内）"));
      soon
        .sort((a, b) => a.startMin - b.startMin)
        .forEach((p) => root.appendChild(perfCard(p, { date, min })));
    }
  }

  const finishedVenues = store.state.venues.filter((v) => isVenueFinished(store.state.performances, v.id, date, date, min));
  if (finishedVenues.length) {
    const list = el("div", {});
    finishedVenues.forEach((v) =>
      list.appendChild(
        el(
          "button",
          { class: "link-btn", style: "display:block;padding:6px 0", onclick: () => openVenueModal(v.id, date) },
          `${v.stageNo}. ${v.name}`
        )
      )
    );
    root.appendChild(finishedDetails({ screen: "now", id: "fin" }, `🏁 終了したステージ（${finishedVenues.length}）`, list));
  }
}

function overPanel() {
  const panel = el("div", { class: "over-panel" });
  panel.append(
    el("div", { class: "emoji" }, "🎉"),
    el("h2", {}, "三茶de大道芸2026、終了しました"),
    el("p", {}, "ご来場ありがとうございました。マイタイムテーブルは引き続きご覧いただけます。")
  );
  return panel;
}

// ---------- Tab: 出演者 ----------
// 同じ出演者が複数回出るフェスなので、日付タブに「チーム」軸を足し「すべて」は置かない
function artistsDayValue(date) {
  return ui.artistsDay || (DAYS.includes(date) ? date : DAYS[0]);
}

function renderArtists(root, date, min) {
  root.appendChild(el("h1", { class: "screen-title" }, "📅 出演者"));

  const curDay = artistsDayValue(date);
  const dayTabs = el("div", { class: "day-tabs" });
  const mkDayTab = (val, label) =>
    el(
      "button",
      {
        class: `day-tab${curDay === val ? " active" : ""}`,
        onclick: () => {
          ui.artistsDay = val;
          render();
        },
      },
      label
    );
  dayTabs.append(...DAYS.map((d) => mkDayTab(d, DAY_LABELS[d])), mkDayTab("team", "チーム"));
  root.appendChild(dayTabs);

  const listContainer = el("div", {});

  const filterRow = el("div", { class: "filter-row" });
  const searchInput = el("input", {
    class: "search-input",
    type: "search",
    placeholder: "出演者名・かなで検索",
    value: ui.artistsSearch,
    oninput: debounce((e) => {
      // ここでfull render()すると<input>ごと作り直されてしまい、入力中にフォーカスが
      // 外れる（1文字打つたびに再フォーカスが必要になる）ため、リスト部分だけ更新する
      ui.artistsSearch = e.target.value;
      renderArtistsBody(listContainer, date, min);
    }, 200),
  });
  const venueSelect = el("select", {
    class: "filter-select",
    onchange: (e) => {
      ui.artistsVenue = e.target.value;
      render();
    },
  });
  venueSelect.appendChild(el("option", { value: "" }, "会場: すべて"));
  store.state.venues.forEach((v) => {
    venueSelect.appendChild(el("option", { value: v.id, selected: ui.artistsVenue === v.id || undefined }, `${v.stageNo}. ${v.name}`));
  });

  const genres = [...new Set(store.state.performances.map((p) => p.genre).filter(Boolean))].sort();
  const genreSelect = el("select", {
    class: "filter-select",
    onchange: (e) => {
      ui.artistsGenre = e.target.value;
      render();
    },
  });
  genreSelect.appendChild(el("option", { value: "" }, "ジャンル: すべて"));
  genres.forEach((g) => genreSelect.appendChild(el("option", { value: g, selected: ui.artistsGenre === g || undefined }, g)));

  filterRow.append(searchInput, venueSelect);
  if (genres.length) filterRow.append(genreSelect);
  root.appendChild(filterRow);

  root.appendChild(listContainer);
  renderArtistsBody(listContainer, date, min);
}

function renderArtistsBody(container, date, min) {
  if (artistsDayValue(date) === "team") renderArtistsByTeam(container, date, min);
  else renderArtistsList(container, date, min);
}

// 会場・ジャンル・検索の絞り込み（日付の絞り込みは呼び出し側）
function filterArtistPerfs(base) {
  const q = normalize(ui.artistsSearch);
  return base.filter((p) => {
    if (ui.artistsVenue && p.venueId !== ui.artistsVenue) return false;
    if (ui.artistsGenre && p.genre !== ui.artistsGenre) return false;
    if (q && !normalize(p.name).includes(q) && !normalize(p.kana).includes(q) && !normalize(p.awardEntry).includes(q)) return false;
    return true;
  });
}

function emptyArtists() {
  return el("div", { class: "empty-state" }, [el("span", { class: "emoji" }, "🔍"), el("div", {}, "該当する出演者が見つかりません")]);
}

function renderArtistsList(container, date, min) {
  container.innerHTML = "";

  const day = artistsDayValue(date);
  const list = filterArtistPerfs(store.state.performances.filter((p) => p.date === day));

  if (!list.length) {
    container.appendChild(emptyArtists());
    return;
  }

  const byVenue = new Map();
  list.forEach((p) => {
    if (!byVenue.has(p.venueId)) byVenue.set(p.venueId, []);
    byVenue.get(p.venueId).push(p);
  });

  const venuesOrdered = store.state.venues.filter((v) => byVenue.has(v.id));
  const activeVenues = [];
  const finishedVenues = [];
  venuesOrdered.forEach((v) => {
    const finished = isVenueFinished(store.state.performances, v.id, day, date, min);
    (finished ? finishedVenues : activeVenues).push(v);
  });

  const renderVenueGroup = (v, foldFinishedSlots) => {
    const group = el("div", { class: "venue-group" });
    group.appendChild(el("div", { class: "venue-group-head" }, [el("span", { class: "stageno" }, `#${v.stageNo}`), v.name]));
    const slots = byVenue.get(v.id).sort((a, b) => a.startMin - b.startMin);
    const done = foldFinishedSlots ? slots.filter((p) => isPerfFinished(p, date, min)) : [];
    slots
      .filter((p) => !done.includes(p))
      .forEach((p) => group.appendChild(perfCard(p, { date, min, showVenue: false })));
    // 会場の一部だけ終わっている時は、終わった枠だけをその会場内で畳む（これからの枠を上に残す）
    if (done.length) {
      const wrap = el("div", {});
      done.forEach((p) => wrap.appendChild(perfCard(p, { date, min, showVenue: false })));
      group.appendChild(finishedDetails({ screen: "slots", id: `${v.id}-${day}` }, `🏁 終了済み（${done.length}）`, wrap));
    }
    return group;
  };

  activeVenues.forEach((v) => container.appendChild(renderVenueGroup(v, true)));

  if (finishedVenues.length) {
    const wrap = el("div", {});
    finishedVenues.forEach((v) => wrap.appendChild(renderVenueGroup(v, false)));
    container.appendChild(finishedDetails({ screen: "artists", id: `fin-${day}` }, `🏁 終了したステージ（${finishedVenues.length}）`, wrap));
  }
}

// チームごとの表示。詳細モーダルと同じ部品（タグ・リンク・枠リスト）を使う
function renderArtistsByTeam(container, date, min) {
  container.innerHTML = "";
  const slots = filterArtistPerfs(store.state.performances);
  const teams = new Map();
  slots.forEach((p) => {
    const k = teamKey(p);
    if (!teams.has(k)) teams.set(k, []);
    teams.get(k).push(p);
  });
  if (!teams.size) {
    container.appendChild(emptyArtists());
    return;
  }
  [...teams.values()]
    .sort((a, b) => teamName(a[0]).localeCompare(teamName(b[0]), "ja"))
    .forEach((list) => {
      const p = list[0];
      const card = el("div", { class: "team-card" });
      card.appendChild(el("div", { class: "team-name" }, teamName(p)));
      const tags = teamTags(p);
      if (tags) card.appendChild(tags);
      const links = teamLinks(p);
      if (links) card.appendChild(links);
      card.appendChild(teamSlotsSection(list, { date, min, onOpen: openDetailModal }));
      container.appendChild(card);
    });
}

// 「栄通りパレード」のようにチーム名が枠名と異なるケースを除き、枠名がそのままチーム名
function teamName(p) {
  return p.name;
}

function teamTags(p) {
  if (!p.genre && !p.region) return null;
  const tags = el("div", { class: "badges" });
  if (p.genre) tags.appendChild(el("span", { class: "badge" }, p.genre));
  if (p.region) tags.appendChild(el("span", { class: "badge" }, p.region));
  if (p.awardEntry) tags.appendChild(el("span", { class: "badge" }, p.awardEntry));
  return tags;
}

function teamLinks(p) {
  if (!p.officialUrl) return null;
  return el("div", { class: "btn-row", style: "margin:8px 0" }, [
    el("button", { class: "btn small", onclick: () => openOfficialViewer(p) }, "📄 公式サイトのチーム紹介"),
  ]);
}

// 「このチームの出演枠（N）」。枠が2つ以上あるチームにだけ出す。日付ごとの箱＋枠ごとの☆、終わった枠は折りたたむ
function teamSlotsSection(slots, { date, min, currentKey = null, onOpen }) {
  if (slots.length < 2) {
    return el("div", {});
  }
  const section = el("div", { class: "team-slots" });
  section.appendChild(el("h4", {}, `このチームの出演枠（${slots.length}）`));
  const mkBoxes = (list) => {
    const wrap = el("div", {});
    const byDate = new Map();
    list.forEach((q) => {
      if (!byDate.has(q.date)) byDate.set(q.date, []);
      byDate.get(q.date).push(q);
    });
    byDate.forEach((qs, d) => {
      const box = el("div", { class: "slot-box" }, [el("div", { class: "slot-date" }, DAY_LABELS[d] || d)]);
      qs.forEach((q) => {
        const v = store.venueById(q.venueId);
        const btn = favButton(q);
        const row = el(
          "div",
          { class: `slot-row${perfKey(q) === currentKey ? " current" : ""}`, onclick: () => onOpen(q) },
          [
            el("span", { class: "slot-time" }, fmtRange(q.start, q.end)),
            el("span", { class: "slot-venue" }, v ? `${v.stageNo}. ${v.name}` : ""),
            btn,
          ]
        );
        applyFavState(btn, q);
        box.appendChild(row);
      });
      wrap.appendChild(box);
    });
    return wrap;
  };
  const upcoming = slots.filter((q) => !isPerfFinished(q, date, min));
  const done = slots.filter((q) => isPerfFinished(q, date, min));
  section.appendChild(mkBoxes(upcoming));
  if (done.length) {
    section.appendChild(finishedDetails({ screen: "slots", id: `team-${teamKey(slots[0])}` }, `🏁 終了済み（${done.length}）`, mkBoxes(done)));
  }
  return section;
}

// 公式ページをそのまま全画面で見せるビューア。出典と「公式サイトで開く」を常に出し、加工・切り取りはしない
function openOfficialViewer(p) {
  const viewer = el("div", { class: "official-viewer" });
  viewer.appendChild(
    el("div", { class: "ov-bar" }, [
      el("div", { class: "ov-title" }, [
        el("div", { class: "ov-name" }, teamName(p)),
        el("div", { class: "ov-src" }, "出典: 三茶de大道芸 公式サイト（© せたがや文化財団）"),
      ]),
      el("a", { class: "btn small", href: p.officialUrl, target: "_blank", rel: "noopener" }, "公式サイトで開く ↗"),
      el("button", { class: "modal-close", style: "position:static", onclick: () => viewer.remove(), "aria-label": "閉じる" }, "✕"),
    ])
  );
  viewer.appendChild(el("iframe", { class: "ov-frame", src: p.officialUrl, referrerpolicy: "no-referrer", title: teamName(p) }));
  viewer.appendChild(el("div", { class: "ov-note" }, "表示されない場合は、オンライン接続を確認するか「公式サイトで開く」からご覧ください。"));
  $modalRoot.appendChild(viewer);
}

// ---------- detail modal ----------
function openDetailModal(p) {
  const venue = store.venueById(p.venueId);
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } });
  const sheet = el("div", { class: "modal-sheet" });
  const close = () => backdrop.remove();
  const { date: curDate, min: curMin } = curDateMin();

  sheet.appendChild(el("button", { class: "modal-close", onclick: close, "aria-label": "閉じる" }, "✕"));
  sheet.appendChild(el("div", { class: "modal-title" }, p.name));
  sheet.appendChild(
    el("div", { class: "modal-meta" }, [
      document.createTextNode(`${DAY_LABELS[p.date] || p.date} ${fmtRange(p.start, p.end)} / `),
      venue
        ? el(
            "button",
            { class: "link-btn", onclick: () => { close(); openVenueModal(venue.id, p.date); } },
            `${venue.stageNo}. ${venue.name}`
          )
        : null,
    ])
  );
  const tags = teamTags(p);
  if (tags) sheet.appendChild(tags);
  const links = teamLinks(p);
  if (links) sheet.appendChild(links);

  const favSection = el("div", { class: "modal-section" });
  const favBtn = el(
    "button",
    {
      class: "btn block fav-main",
      "data-pid": perfKey(p),
      onclick: () => onToggleFav(p),
    },
    ""
  );
  applyMainFavState(favBtn, p);
  favSection.appendChild(favBtn);
  sheet.appendChild(favSection);

  const slots = store.teamSlots(p);
  if (slots.length > 1) {
    sheet.appendChild(
      teamSlotsSection(slots, {
        date: curDate,
        min: curMin,
        currentKey: perfKey(p),
        onOpen: (q) => {
          if (q === p) return;
          close();
          openDetailModal(q);
        },
      })
    );
  }

  if (venue) {
    const mapBtn = el(
      "button",
      { class: "btn block", style: "margin-top:6px" },
      "🗺️ マップで見る"
    );
    mapBtn.addEventListener("click", () => {
      close();
      activeTab = "map";
      mapState.selectedVenueId = venue.id;
      render();
      focusMapOnVenue(venue);
    });
    sheet.appendChild(mapBtn);
  }

  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);
}

// ---------- 会場詳細モーダル ----------
function openVenueModal(venueId, day) {
  const venue = store.venueById(venueId);
  if (!venue) return;
  const state = { day: day && venue.days.includes(day) ? day : venue.days[0] || DAYS[0], from: "here" };

  // モーダルは画面全体を覆うので、選択中の色は裏の地図には見えない。閉じて地図に戻ったときに
  // 「さっき見ていた会場」だと分かるよう、選択状態は閉じても解除せずそのまま残す
  mapState.selectedVenueId = venue.id;
  refreshMapMarkers();

  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } });
  const sheet = el("div", { class: "modal-sheet" });
  const close = () => backdrop.remove();

  function redraw() {
    sheet.innerHTML = "";
    sheet.appendChild(el("button", { class: "modal-close", onclick: close, "aria-label": "閉じる" }, "✕"));
    sheet.appendChild(el("div", { class: "modal-title" }, `${venue.stageNo}. ${venue.name}`));

    const dayTabs = el("div", { class: "day-tabs" });
    DAYS.forEach((d) => {
      const open = venue.days.includes(d);
      dayTabs.appendChild(
        el(
          "button",
          {
            class: `day-tab${state.day === d ? " active" : ""}`,
            style: open ? "" : "opacity:.4;cursor:default",
            onclick: () => { if (open) { state.day = d; redraw(); } },
          },
          DAY_LABELS[d] + (open ? "" : "（開催なし）")
        )
      );
    });
    sheet.appendChild(dayTabs);

    const fromRow = el("div", { class: "modal-section", style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" });
    const fromSelect = el("select", {
      class: "filter-select",
      onchange: (e) => { state.from = e.target.value; redraw(); },
    });
    fromSelect.appendChild(el("option", { value: "here" }, "現在地から"));
    store.state.venues
      .filter((v) => v.id !== venue.id)
      .forEach((v) => {
        fromSelect.appendChild(
          el("option", { value: v.id, selected: state.from === v.id || undefined }, `${v.stageNo}. ${v.name}`)
        );
      });
    fromSelect.value = state.from;

    let walkText;
    let fromLat = null;
    let fromLng = null;
    if (state.from === "here") {
      const geo = effectiveGeo();
      if (geo) {
        fromLat = geo.lat;
        fromLng = geo.lng;
        walkText = `🚶 徒歩 約${estimateWalk(geo, venue)}分`;
      } else {
        walkText = "（現在地未取得）";
      }
    } else {
      const fromVenue = store.venueById(state.from);
      fromLat = fromVenue.lat;
      fromLng = fromVenue.lng;
      const walk = store.walkMinutes(state.from, venue.id);
      const mins = walk != null ? walk : estimateWalkMin(fromVenue.lat, fromVenue.lng, venue.lat, venue.lng);
      walkText = `🚶 徒歩 約${mins}分`;
    }
    fromRow.append(fromSelect, el("span", { class: "sub-note", style: "margin:0" }, walkText));
    sheet.appendChild(fromRow);

    const btnRow = el("div", { class: "btn-row" });
    btnRow.appendChild(
      el(
        "button",
        {
          class: "btn",
          onclick: () => {
            close();
            activeTab = "map";
            ui.mapMode = "normal";
            mapState.singleRoute = { fromId: state.from === "here" ? null : state.from, toId: venue.id };
            render();
          },
        },
        "🗺 地図で見る"
      )
    );
    const gmaps =
      fromLat != null
        ? `https://www.google.com/maps/dir/?api=1&origin=${fromLat},${fromLng}&destination=${venue.lat},${venue.lng}&travelmode=walking`
        : `https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}&travelmode=walking`;
    btnRow.appendChild(el("a", { class: "btn", href: gmaps, target: "_blank", rel: "noopener" }, "ここへ行く"));
    sheet.appendChild(btnRow);

    const list = el("div", { class: "modal-section" });
    const ps = store.state.performances
      .filter((p) => p.date === state.day && p.venueId === venue.id)
      .sort((a, b) => a.startMin - b.startMin);
    if (ps.length) {
      const { date: curDate, min: curMin } = curDateMin();
      ps.forEach((p) => list.appendChild(perfCard(p, { date: curDate, min: curMin, showVenue: false })));
    } else {
      list.appendChild(el("p", { style: "color:var(--muted)" }, "この日の上演はありません"));
    }
    sheet.appendChild(list);
  }

  redraw();
  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);
}

// ---------- Tab: マップ ----------
function renderMap(root, date, min) {
  root.appendChild(el("h1", { class: "screen-title" }, "🗺️ マップ"));

  const toolbar = el("div", { class: "map-toolbar" });
  const searchWrap = el("div", { class: "map-search-wrap" });
  const resultsBox = el("div", { class: "map-search-results" });
  const searchInput = el("input", {
    class: "search-input",
    type: "search",
    placeholder: "ステージ番号・会場名で検索",
    value: ui.mapSearch,
    oninput: (e) => {
      ui.mapSearch = e.target.value;
      renderMapSearchResults(resultsBox, ui.mapSearch);
    },
    onkeydown: (e) => {
      if (e.key === "Escape") {
        e.target.value = "";
        ui.mapSearch = "";
        resultsBox.replaceChildren();
      }
    },
  });
  searchWrap.append(searchInput, resultsBox);
  if (ui.mapSearch) renderMapSearchResults(resultsBox, ui.mapSearch);
  toolbar.appendChild(searchWrap);
  toolbar.appendChild(
    el(
      "button",
      {
        class: `toggle-btn${ui.mapMode === "myroute" ? " active" : ""}`,
        onclick: () => {
          ui.mapMode = ui.mapMode === "myroute" ? "normal" : "myroute";
          mapState.singleRoute = null;
          render();
        },
      },
      "🎟️ マイルート"
    )
  );
  root.appendChild(toolbar);

  if (mapState.singleRoute) renderRouteBanner(root);
  else if (ui.mapMode === "myroute") renderMyRouteBanner(root, date, min);

  const mapDiv = el("div", { id: "map-view" });
  root.appendChild(mapDiv);

  ensureMapResizeListener();
  requestAnimationFrame(() => {
    initOrUpdateMap(mapDiv, date, min);
  });
}

// 地図の高さはJSで測らず、CSS（#app.screen-map のフレックスレイアウト）に任せる。
// リサイズ・端末回転のときだけLeafletに寸法の再計算を促す
let mapResizeBound = false;
function ensureMapResizeListener() {
  if (mapResizeBound) return;
  mapResizeBound = true;
  window.addEventListener("resize", () => mapState.instance?.invalidateSize());
}

// 会場詳細モーダルから「地図で見る」で指定された、現在地または特定会場→会場の単一区間ルート
function singleRouteInfo(spec) {
  const to = store.venueById(spec.toId);
  if (!to) return null;
  const from = spec.fromId ? store.venueById(spec.fromId) : effectiveGeo();
  if (!from) return { to, from: null };
  let walkMin = null;
  let hasRoute = false;
  let latlngs = [[from.lat, from.lng], [to.lat, to.lng]];
  if (spec.fromId) {
    const route = store.routeBetween(spec.fromId, spec.toId);
    if (route && route.poly) {
      latlngs = decodePolyline(route.poly);
      walkMin = route.durMin;
      hasRoute = true;
    } else {
      walkMin = store.walkMinutes(spec.fromId, spec.toId);
    }
  }
  if (walkMin == null) walkMin = estimateWalkMin(from.lat, from.lng, to.lat, to.lng);
  return { to, from, walkMin, hasRoute, latlngs };
}

function drawSingleRoute(layer, spec) {
  const info = singleRouteInfo(spec);
  if (!info || !info.from) return;
  L.polyline(info.latlngs, { color: "#ffffff", weight: 8, opacity: 0.9, lineCap: "round" }).addTo(layer);
  L.polyline(info.latlngs, { color: "#ff2f92", weight: 4, opacity: 1, lineCap: "round" }).addTo(layer);
  L.circleMarker([info.from.lat, info.from.lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#ff2f92", fillOpacity: 1 }).addTo(layer);
  const mid = info.latlngs[Math.floor(info.latlngs.length / 2)];
  L.marker(mid, { icon: walkTimeIcon(info.walkMin, "#ff2f92"), interactive: false, zIndexOffset: 1200 }).addTo(layer);
  mapState.instance.fitBounds(L.latLngBounds(info.latlngs), { padding: [56, 56], animate: false });
}

function renderRouteBanner(root) {
  const spec = mapState.singleRoute;
  if (!spec) return;
  const info = singleRouteInfo(spec);
  const toLabel = info?.to ? `${info.to.stageNo}. ${info.to.name}` : "";
  const fromVenue = spec.fromId ? store.venueById(spec.fromId) : null;
  const fromLabel = spec.fromId ? (fromVenue ? `${fromVenue.stageNo}. ${fromVenue.name}` : "") : "現在地";

  const banner = el("div", { class: "route-banner" });
  banner.appendChild(
    el("div", { class: "route-banner-head" }, [
      el("div", { class: "route-banner-title" }, `${fromLabel} → ${toLabel}`),
      el(
        "button",
        { class: "modal-close", style: "position:static", onclick: () => { mapState.singleRoute = null; render(); } },
        "✕"
      ),
    ])
  );
  let subText;
  if (!info || !info.from) subText = "現在地が未取得です（マップ左上の📍ボタンで取得できます）";
  else if (info.hasRoute) subText = `🚶 徒歩約${info.walkMin}分`;
  else subText = `📏 直線距離からの概算 徒歩約${info.walkMin}分（実測ルート未取得）`;
  banner.appendChild(el("div", { class: "sub-note", style: "margin:0" }, subText));
  if (info && info.from) {
    const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${info.from.lat},${info.from.lng}&destination=${info.to.lat},${info.to.lng}&travelmode=walking`;
    banner.appendChild(el("a", { class: "btn small", href: gmaps, target: "_blank", rel: "noopener" }, "Googleマップで開く"));
  }
  root.appendChild(banner);
}

// ステージ番号または会場名でマップ上の会場を検索し、候補をリスト表示する
function renderMapSearchResults(resultsBox, query) {
  const nq = normalize(query);
  if (!nq) {
    resultsBox.replaceChildren();
    return;
  }
  const matches = store.state.venues
    .filter((v) => String(v.stageNo).includes(nq) || normalize(v.name).includes(nq))
    .slice(0, 8);
  resultsBox.replaceChildren(
    ...(matches.length
      ? matches.map((v) =>
          el(
            "button",
            { class: "map-search-row", onclick: () => selectMapSearchResult(v) },
            `${v.stageNo}. ${v.name}`
          )
        )
      : [el("div", { class: "map-search-empty" }, "該当する会場がありません")])
  );
}

// 検索結果タップ: その会場にズームし、ピンをハイライトして検索欄・候補は閉じる
function selectMapSearchResult(v) {
  mapState.selectedVenueId = v.id;
  focusMapOnVenue(v);
  refreshMapMarkers();
  ui.mapSearch = "";
  const wrap = document.querySelector(".map-search-wrap");
  const input = wrap?.querySelector(".search-input");
  if (input) input.value = "";
  wrap?.querySelector(".map-search-results")?.replaceChildren();
}

function focusMapOnVenue(venue) {
  // mapState.center/zoomも更新しておく。タブ切替直後はrequestAnimationFrame内で
  // initOrUpdateMap()がこの値を使って再度setViewするため、ここを更新しないと
  // 下記のsetViewがその後の再アタッチ処理で上書きされて元の表示位置に戻ってしまう
  mapState.center = L.latLng(venue.lat, venue.lng);
  mapState.zoom = 18;
  if (mapState.instance) {
    mapState.instance.setView([venue.lat, venue.lng], 18, { animate: false });
  }
}

function pinDivIcon(label, color, offset) {
  const style = offset
    ? `transform:translate(${offset[0]}px,${offset[1]}px);`
    : "";
  return L.divIcon({
    className: "",
    html: `<div class="pin-tieup" style="${style}background:${color};color:#14131a;font-weight:700;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13 + (offset ? -offset[1] : 0)],
  });
}

// 会場マーカー: ステージ番号を常時表示する円形ピン（下向きの吹き出し尻尾付き）
function venueDivIcon(stageNo, color, finished) {
  const size = stageNo >= 10 ? 34 : 30;
  const opacity = finished ? 0.42 : 1;
  const tail = 8;
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:${size}px;height:${size + tail}px;opacity:${opacity}">
      <div style="position:absolute;top:0;left:0;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2.5px solid #14131a;box-shadow:0 2px 6px rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;color:#14131a;font-weight:800;font-size:13px;line-height:1;font-family:'IBM Plex Mono',ui-monospace,monospace">${stageNo}</div>
      <div style="position:absolute;top:${size - 3}px;left:${size / 2 - tail / 2}px;width:0;height:0;border-left:${tail / 2}px solid transparent;border-right:${tail / 2}px solid transparent;border-top:${tail}px solid #14131a"></div>
    </div>`,
    iconSize: [size, size + tail],
    iconAnchor: [size / 2, size + tail],
    popupAnchor: [0, -(size + tail)],
  });
}

function decodePolyline(str, precision = 5) {
  let index = 0,
    lat = 0,
    lng = 0,
    coords = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let result = 1,
      shift = 0,
      b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

function initOrUpdateMap(mapDiv, date, min) {
  if (!window.L) return;
  if (!mapState.instance) {
    const vs = store.state.venues;
    const map = L.map(mapDiv, { inertiaMaxSpeed: 1500 });
    if (mapState.center) {
      map.setView(mapState.center, mapState.zoom || 16, { animate: false });
    } else if (vs.length) {
      // 初期表示は全会場が収まるようfitBoundsで合わせる（会場によって駅から離れた場所もあるため、
      // 固定ズームの重心表示だと見切れたり余白が偏ったりする）
      map.fitBounds(L.latLngBounds(vs.map((v) => [v.lat, v.lng])), { padding: [32, 32], animate: false });
    } else {
      map.setView([35.6437, 139.671], 16, { animate: false });
    }
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
    }).addTo(map);
    map.on("moveend", () => {
      mapState.center = map.getCenter();
      mapState.zoom = map.getZoom();
    });

    const locBtn = L.control({ position: "topleft" });
    locBtn.onAdd = () => {
      const b = L.DomUtil.create("button", "map-loc-btn");
      b.type = "button";
      b.textContent = "📍";
      b.title = "現在地を取得";
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", async (e) => {
        L.DomEvent.stop(e);
        b.textContent = "…";
        try {
          const geo = await locateOnce();
          b.textContent = "📍";
          map.setView([geo.lat, geo.lng], 16, { animate: false });
        } catch {
          b.textContent = "❌";
          setTimeout(() => { b.textContent = "📍"; }, 1500);
        }
      });
      return b;
    };
    locBtn.addTo(map);

    mapState.instance = map;
  } else {
    // 別のdivへ再アタッチ（タブ切替でDOMが作り直されるため）
    mapDiv.appendChild(mapState.instance.getContainer());
    mapState.instance.invalidateSize();
    if (mapState.center) mapState.instance.setView(mapState.center, mapState.zoom, { animate: false });
  }
  drawMapLayer(date, min);
}

function drawMapLayer(date, min) {
  const map = mapState.instance;
  if (mapState.layer) {
    map.removeLayer(mapState.layer);
  }
  const layer = L.layerGroup().addTo(map);
  mapState.layer = layer;

  // 座標重複検出
  const coordCount = new Map();
  const keyOf = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
  store.state.venues.forEach((v) => coordCount.set(keyOf(v.lat, v.lng), (coordCount.get(keyOf(v.lat, v.lng)) || 0) + 1));
  const tieupOffsetSeen = new Map();

  store.state.venues.forEach((v) => {
    const finished = isVenueFinished(store.state.performances, v.id, null, date, min);
    const isSelected = mapState.selectedVenueId === v.id;
    const marker = L.marker([v.lat, v.lng], {
      icon: venueDivIcon(v.stageNo, isSelected ? "#ffb020" : "#39e0c9", finished),
      zIndexOffset: isSelected ? 500 : 0,
    }).addTo(layer);
    // ポップアップは挟まず、タップで直接その日の会場詳細（タイムテーブル）を開く
    marker.on("click", () => openVenueModal(v.id, date));
  });

  (store.state.tieup.stages || []).forEach((s) => {
    const key = keyOf(s.lat, s.lng);
    let offset = null;
    if (coordCount.get(key)) {
      const n = tieupOffsetSeen.get(key) || 0;
      tieupOffsetSeen.set(key, n + 1);
      offset = n === 0 ? [0, -22] : n % 2 === 1 ? [-18, -14] : [18, -14];
    }
    const marker = L.marker([s.lat, s.lng], { icon: pinDivIcon("T", "#e6a740", offset) }).addTo(layer);
    marker.bindPopup(`<b>${s.name}</b>${s.sponsor ? `<br>${s.sponsor}` : ""}${s.approx ? "<br><i>位置は近似</i>" : ""}`);
  });

  if (ui.mapMode === "myroute") {
    drawMyRoute(layer, date, min);
  }
  if (mapState.singleRoute) {
    drawSingleRoute(layer, mapState.singleRoute);
  }

  const geo = effectiveGeo();
  if (geo) {
    L.circleMarker([geo.lat, geo.lng], { radius: 9, color: "#fff", weight: 3, fillColor: "#3d8bff", fillOpacity: 1 })
      .addTo(layer)
      .bindPopup("現在地");
  }
}

// ルート線の始点・終点マーカー。始点=丸いリング、終点=雫形のピンで形から見分けられるようにする
function endpointIcon(kind, color) {
  return kind === "start"
    ? L.divIcon({
        className: "route-endpoint start",
        html: `<span style="--dot-color:${color}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      })
    : L.divIcon({
        className: "route-endpoint end",
        html: `<span style="--dot-color:${color}"></span>`,
        iconSize: [20, 20],
        iconAnchor: [10, 19],
      });
}

// 経路線の中間地点に添える徒歩時間ラベル
function walkTimeIcon(minutes, color = "#0f9c8c") {
  return L.divIcon({
    className: "",
    html: `<div style="display:inline-block;width:max-content;background:${color};color:#14131a;font-weight:700;font-size:11px;font-family:'IBM Plex Mono',ui-monospace,monospace;padding:3px 8px;border-radius:20px;border:2px solid #14131a;box-shadow:0 2px 6px rgba(0,0,0,.5);white-space:nowrap;transform:translate(-50%,-50%)">🚶 ${minutes}分</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

// 現在時刻（シミュレーション込み）を基準に、マイタイムテーブルでまだ終了していない移動区間を
// すべて求める（直前の（終了済み最後の）お気に入り→次のお気に入り→その次…と連なる区間の配列）
function computeMyRouteSegments(date, min) {
  const favs = [...store.state.favorites]
    .map((key) => store.state.performances.find((p) => perfKey(p) === key))
    .filter((p) => p && p.date === date)
    .sort((a, b) => a.startMin - b.startMin);
  if (!favs.length) return { message: "本日のお気に入りが登録されていません" };

  const upcoming = favs.filter((p) => p.startMin > min);
  if (!upcoming.length) return { message: "本日のお気に入り予定はすべて終了しました" };

  const prevList = favs.filter((p) => p.startMin <= min);
  const prev = prevList.length ? prevList[prevList.length - 1] : null;

  // 時系列で同じ会場が続く間は移動が発生しないので、1区間（最初の開始〜最後の終了）に集約する。
  // 別会場を挟んで戻る場合は集約せず別区間にする
  const segments = [];
  let fromId = prev ? prev.venueId : null; // null = 最初の区間のみ「現在地から」
  upcoming.forEach((p) => {
    if (fromId !== p.venueId) {
      segments.push({ fromId, toId: p.venueId, toPerf: p, lastPerf: p, count: 1 });
    } else if (segments.length && segments[segments.length - 1].toId === p.venueId) {
      const last = segments[segments.length - 1];
      last.lastPerf = p;
      last.count++;
    }
    fromId = p.venueId;
  });
  if (!segments.length) return { message: "残りのお気に入りはすべて同じ会場のため、移動はありません" };
  return { segments };
}

// 区間ごとの座標・徒歩時間・ラベルをLeaflet非依存で計算する（地図描画・カード表示の両方から使う）
function myRouteSegmentDetails(segments) {
  return segments.map((seg) => {
    const to = store.venueById(seg.toId);
    let from = null;
    let coords = null;
    let hasRoute = false;
    let walkMin = null;
    if (seg.fromId) {
      from = store.venueById(seg.fromId);
      const route = store.routeBetween(seg.fromId, seg.toId);
      if (route && route.poly) {
        coords = decodePolyline(route.poly);
        walkMin = route.durMin;
        hasRoute = true;
      } else {
        coords = [[from.lat, from.lng], [to.lat, to.lng]];
        walkMin = store.walkMinutes(seg.fromId, seg.toId);
      }
    } else {
      from = effectiveGeo();
      if (from) coords = [[from.lat, from.lng], [to.lat, to.lng]];
    }
    if (walkMin == null && coords) {
      const last = coords[coords.length - 1];
      walkMin = estimateWalkMin(coords[0][0], coords[0][1], last[0], last[1]);
    }
    const fromLabel = seg.fromId ? (from ? `${from.stageNo}. ${from.name}` : "") : from ? "現在地" : "現在地（未取得）";
    let legText;
    if (!coords) legText = "現在地が未取得です";
    else if (hasRoute) legText = `🚶約${walkMin}分`;
    else legText = `📏約${walkMin}分（概算）`;
    return { seg, to, from, coords, hasRoute, walkMin, fromLabel, legText };
  });
}

// マイルートモード: 区間ごとに色分けして地図に描く。カルーセルのスクロールと連動できるよう、
// ハイライト適用・地図フォーカスの関数をmapStateに残しておく（フルre-renderせずに更新するため）
function drawMyRoute(layer, date, min) {
  const { segments } = computeMyRouteSegments(date, min);
  if (!segments || !segments.length) {
    mapState.myRouteSegInfo = null;
    mapState.myRouteApplyHighlight = null;
    mapState.myRouteFocusMap = null;
    return;
  }
  myRouteIndex = Math.max(0, Math.min(myRouteIndex, segments.length - 1));
  const details = myRouteSegmentDetails(segments);

  const segInfo = details.map((d, i) => {
    const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
    let halo = null;
    let line = null;
    let startMarker = null;
    let endMarker = null;
    let timeMarker = null;
    if (d.coords) {
      const dash = d.hasRoute ? null : "7 9";
      halo = L.polyline(d.coords, { color: "#ffffff", weight: 5, opacity: 0.15, dashArray: dash }).addTo(layer);
      line = L.polyline(d.coords, { color, weight: 3, opacity: 0.3, dashArray: dash }).addTo(layer);
      startMarker = L.marker(d.coords[0], { icon: endpointIcon("start", color), interactive: false, zIndexOffset: 1000 }).addTo(layer);
      endMarker = L.marker(d.coords[d.coords.length - 1], { icon: endpointIcon("end", color), interactive: false, zIndexOffset: 1000 }).addTo(layer);
      const mid = d.coords[Math.floor(d.coords.length / 2)];
      timeMarker = L.marker(mid, { icon: walkTimeIcon(d.walkMin, color), interactive: false, zIndexOffset: 1200, opacity: 0 }).addTo(layer);
    }
    return { ...d, halo, line, startMarker, endMarker, timeMarker };
  });

  // フォーカス中の区間だけ太く・不透明に、徒歩時間ラベルも付ける。他は細く薄く（太さ3・透明度0.3）して「今どの線か」を一目で分かるようにする
  const applyHighlight = (idx) => {
    segInfo.forEach((s, i) => {
      if (!s.line) return;
      const focused = i === idx;
      s.halo.setStyle({ weight: focused ? 8 : 5, opacity: focused ? 0.95 : 0.15 });
      s.line.setStyle({ weight: focused ? 5 : 3, opacity: focused ? 1 : 0.3 });
      s.startMarker.setOpacity(focused ? 1 : 0.3);
      s.endMarker.setOpacity(focused ? 1 : 0.3);
      s.timeMarker?.setOpacity(focused ? 1 : 0);
      if (focused) s.line.bringToFront();
    });
  };
  const focusMap = (idx) => {
    const s = segInfo[idx];
    if (s && s.line) mapState.instance.fitBounds(s.line.getBounds(), { padding: [56, 90], animate: false });
  };

  mapState.myRouteSegInfo = segInfo;
  mapState.myRouteApplyHighlight = applyHighlight;
  mapState.myRouteFocusMap = focusMap;
  applyHighlight(myRouteIndex);
  focusMap(myRouteIndex);
}

// マイルートのバナー: カードを上下スワイプ（スクロールスナップ）で1件ずつ切り替えると、
// 対応する地図上の線が連動してハイライトされる。スクロール中はフルre-renderせず
// mapState経由でLeafletの見た目だけ直接更新する（じゃないと毎スクロールで地図が作り直されてしまう）
function renderMyRouteBanner(root, date, min) {
  const { message, segments } = computeMyRouteSegments(date, min);
  if (message) {
    const banner = el("div", { class: "route-banner" });
    banner.appendChild(
      el("div", { class: "route-banner-head" }, [
        el("div", { class: "route-banner-title" }, "🎟️ マイルート"),
        el(
          "button",
          { class: "modal-close", style: "position:static", onclick: () => { ui.mapMode = "normal"; render(); } },
          "✕"
        ),
      ])
    );
    banner.appendChild(el("div", { class: "sub-note", style: "margin:0" }, message));
    root.appendChild(banner);
    return;
  }

  myRouteIndex = Math.max(0, Math.min(myRouteIndex, segments.length - 1));
  const details = myRouteSegmentDetails(segments);
  const counter = el("span", { class: "myroute-counter" }, `${myRouteIndex + 1} / ${segments.length}`);

  const cards = details.map((d) => {
    const gUrl = d.coords
      ? `https://www.google.com/maps/dir/?api=1&origin=${d.coords[0][0]},${d.coords[0][1]}&destination=${d.to.lat},${d.to.lng}&travelmode=walking`
      : null;
    return el("div", { class: "myroute-card" }, [
      el("div", { class: "myroute-main" }, [
        el("div", { class: "myroute-route" }, `${d.fromLabel} → ${d.to.stageNo}. ${d.to.name}`),
        el("div", { class: "myroute-sub" }, `${d.legText}　次: ${d.seg.toPerf.start}〜${d.seg.lastPerf.end} ${d.seg.toPerf.name}${d.seg.count > 1 ? ` ほか${d.seg.count - 1}件` : ""}`),
      ]),
      gUrl ? el("a", { class: "myroute-g", href: gUrl, target: "_blank", rel: "noopener", title: "Googleで開く" }, "↗") : null,
    ]);
  });
  const carousel = el("div", { class: "myroute-carousel" }, cards);

  const goTo = (idx) => {
    const clamped = Math.max(0, Math.min(segments.length - 1, idx));
    carousel.scrollTo({ top: clamped * MYROUTE_CARD_H, behavior: "smooth" });
  };

  let settleTimer = null;
  carousel.addEventListener("scroll", () => {
    const idx = Math.max(0, Math.min(segments.length - 1, Math.round(carousel.scrollTop / MYROUTE_CARD_H)));
    if (idx !== myRouteIndex) {
      myRouteIndex = idx;
      mapState.myRouteApplyHighlight?.(idx);
      counter.textContent = `${idx + 1} / ${segments.length}`;
    }
    // 地図の視点合わせはスクロールが落ち着いてから（スワイプ中に何度も動くと酔うため）
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      // 画面が作り直されていたら、古いカードのタイマーで新しい画面の地図を動かさない
      if (!carousel.isConnected) return;
      mapState.myRouteFocusMap?.(myRouteIndex);
    }, 150);
  });

  const banner = el("div", { class: "route-banner myroute-banner" }, [
    el("button", { class: "myroute-nav", onclick: () => goTo(myRouteIndex - 1) }, "▲"),
    el("div", { class: "myroute-carousel-wrap" }, carousel),
    el("button", { class: "myroute-nav", onclick: () => goTo(myRouteIndex + 1) }, "▼"),
    el("div", { class: "route-banner-btns" }, [
      counter,
      el(
        "button",
        { class: "modal-close", style: "position:static", onclick: () => { ui.mapMode = "normal"; render(); } },
        "✕"
      ),
    ]),
  ]);
  root.appendChild(banner);

  requestAnimationFrame(() => { carousel.scrollTop = myRouteIndex * MYROUTE_CARD_H; });
}

// ---------- Tab: マイタイムテーブル ----------
function renderMyTT(root, date, min, over) {
  root.appendChild(el("h1", { class: "screen-title" }, "★ マイタイムテーブル"));

  const favs = [...store.state.favorites]
    .map((key) => store.state.performances.find((p) => perfKey(p) === key))
    .filter(Boolean);

  if (!favs.length) {
    root.appendChild(
      el("div", { class: "empty-state" }, [
        el("span", { class: "emoji" }, "☆"),
        el("div", {}, "出演者タブの☆から気になるステージをお気に入り登録しよう"),
      ])
    );
    return;
  }

  const availableDays = over ? DAYS : DAYS;
  const curDay = availableDays.includes(date) ? date : availableDays[0];

  const dayTabs = el("div", { class: "day-tabs" });
  availableDays.forEach((d) => {
    dayTabs.appendChild(
      el(
        "button",
        {
          class: `day-tab${d === (ui.myttDay || curDay) ? " active" : ""}`,
          onclick: () => {
            ui.myttDay = d;
            render();
          },
        },
        DAY_LABELS[d]
      )
    );
  });
  root.appendChild(dayTabs);
  const activeDay = ui.myttDay || curDay;

  const dayFavs0 = favs.filter((p) => p.date === activeDay);
  // 表示モードは明示的にタップされるまで固定せず、その日のお気に入りが散らばる会場数で自動選択する
  const venueCount = new Set(dayFavs0.map((p) => p.venueId)).size;
  const effMode = ui.myttMode ?? (venueCount <= MYTT_LIST_MAX_VENUES ? "list" : "schedule");

  if (!over) {
    const modeRow = el("div", { class: "map-toolbar" });
    modeRow.appendChild(
      el(
        "button",
        { class: `toggle-btn${effMode === "list" ? " active" : ""}`, onclick: () => { ui.myttMode = "list"; render(); } },
        "リスト"
      )
    );
    modeRow.appendChild(
      el(
        "button",
        { class: `toggle-btn${effMode === "schedule" ? " active" : ""}`, onclick: () => { ui.myttMode = "schedule"; render(); } },
        "スケジュール表"
      )
    );
    root.appendChild(modeRow);
  }

  const dayFavs = favs.filter((p) => p.date === activeDay).sort((a, b) => a.startMin - b.startMin);
  if (!dayFavs.length) {
    root.appendChild(el("div", { class: "empty-state" }, [el("span", { class: "emoji" }, "📅"), el("div", {}, "この日のお気に入りはありません")]));
    return;
  }

  if (!over && activeDay === date) {
    root.appendChild(
      el(
        "button",
        {
          class: "btn block",
          style: "margin-bottom:12px",
          onclick: () => {
            activeTab = "map";
            ui.mapMode = "myroute";
            render();
          },
        },
        "🗺️ マップでステージ間のルート・徒歩時間を見る"
      )
    );
  }

  // 警告は常時並べず折りたたみに隠し、閉じている間は件数だけ見せる（0件なら折りたたみ自体を出さない）
  const warnings = computeWarnings(dayFavs);
  if (warnings.length) {
    const wrap = el("div", {});
    warnings.forEach((w) => {
      wrap.appendChild(
        el(
          "div",
          {
            class: "warn-banner",
            onclick: () => {
              activeTab = "map";
              ui.mapMode = "myroute";
              render();
            },
          },
          `⚠️ ${w}`
        )
      );
    });
    root.appendChild(finishedDetails({ screen: "warn", id: activeDay }, `⚠️ 時間・移動の警告（${warnings.length}件）`, wrap));
  }

  if (effMode === "schedule" && !over) {
    root.appendChild(renderScheduleGrid(dayFavs, date, min));
  } else {
    const finished = dayFavs.filter((p) => isPerfFinished(p, date, min));
    const active = dayFavs.filter((p) => !finished.includes(p));
    appendRunBoxes(root, active, date, min);
    if (finished.length) {
      const wrap = el("div", {});
      appendRunBoxes(wrap, finished, date, min);
      root.appendChild(finishedDetails({ screen: "mytt", id: activeDay }, `🏁 終了したステージ（${finished.length}）`, wrap));
    }
  }

  if (over) {
    root.appendChild(
      el(
        "button",
        { class: "btn block primary", style: "margin-top:16px", onclick: exportFavoritesFile },
        "💾 ファイルに書き出す"
      )
    );
  }
}

// 「移動が不要な連続区間」（時系列でvenueIdが連続する範囲）ごとに、会場名の見出し付きの箱にまとめる。
// 1件だけの区間も同じ箱・見出しで描画し、別会場へ移る箇所にだけ徒歩時間の区切りを置く
function appendRunBoxes(container, list, date, min) {
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1].venueId === list[i].venueId) j++;
    const v = store.venueById(list[i].venueId);
    const box = el("div", { class: "run-box" }, [
      el("div", { class: "run-head" }, [el("span", { class: "stageno" }, `#${v ? v.stageNo : ""}`), v ? v.name : ""]),
    ]);
    for (let k = i; k <= j; k++) box.appendChild(perfCard(list[k], { date, min, showVenue: false }));
    container.appendChild(box);
    if (j < list.length - 1) {
      const connector = travelConnector(list[j], list[j + 1]);
      if (connector) container.appendChild(connector);
    }
    i = j + 1;
  }
}

function travelConnector(a, b) {
  const venueA = store.venueById(a.venueId);
  const venueB = store.venueById(b.venueId);
  if (!venueA || !venueB) return null;
  const walk = store.walkMinutes(a.venueId, b.venueId);
  const mins = walk != null ? walk : estimateWalkMin(venueA.lat, venueA.lng, venueB.lat, venueB.lng);
  const gap = b.startMin - a.endMin;
  const tight = gap < mins;
  return el("div", { class: `mytt-connector${tight ? " tight" : ""}` }, `🚶 徒歩${mins}分`);
}

function computeWarnings(dayFavs) {
  const warnings = [];
  for (let i = 0; i < dayFavs.length - 1; i++) {
    const a = dayFavs[i];
    const b = dayFavs[i + 1];
    if (a.endMin > b.startMin) {
      warnings.push(`「${a.name}」と「${b.name}」の時間が重複しています`);
      continue;
    }
    if (a.venueId !== b.venueId) {
      const walk = store.walkMinutes(a.venueId, b.venueId);
      const venueA = store.venueById(a.venueId);
      const venueB = store.venueById(b.venueId);
      const est = walk != null ? walk : venueA && venueB ? estimateWalkMin(venueA.lat, venueA.lng, venueB.lat, venueB.lng) : 0;
      const gap = b.startMin - a.endMin;
      if (est > gap) {
        warnings.push(`「${a.name}」→「${b.name}」の移動時間が足りない可能性があります（必要 約${est}分 / 余裕 ${gap}分）`);
      }
    }
  }
  return warnings;
}

function renderScheduleGrid(dayFavs, date, min) {
  const wrap = el("div", { class: "schedule-wrap" });
  const startHour = Math.min(...dayFavs.map((p) => Math.floor(p.startMin / 60))) ;
  const endHour = Math.max(...dayFavs.map((p) => Math.ceil(p.endMin / 60)));
  const pxPerMin = 1.6;
  const totalMin = (endHour - startHour) * 60;

  // greedy列割り当て
  const sorted = [...dayFavs].sort((a, b) => a.startMin - b.startMin);
  const colEndTimes = [];
  const placed = sorted.map((p) => {
    let col = colEndTimes.findIndex((t) => t <= p.startMin);
    if (col === -1) {
      col = colEndTimes.length;
      colEndTimes.push(p.endMin);
    } else {
      colEndTimes[col] = p.endMin;
    }
    return { p, col };
  });
  const maxCol = Math.max(1, colEndTimes.length);
  if (maxCol > 3) wrap.classList.add("scrollable");

  const axis = el("div", { class: "sched-axis", style: `height:${totalMin * pxPerMin}px` });
  for (let h = startHour; h <= endHour; h++) {
    const top = (h - startHour) * 60 * pxPerMin;
    axis.appendChild(el("div", { class: "sched-hour-label", style: `top:${top}px` }, `${h}:00`));
    axis.appendChild(el("div", { class: "sched-hour-line", style: `top:${top}px` }));
  }

  const grid = el("div", { class: "schedule-grid", style: `height:${totalMin * pxPerMin}px; margin-left:8px; min-width:${maxCol * 130}px` });
  placed.forEach(({ p, col }) => {
    const top = (p.startMin - startHour * 60) * pxPerMin;
    const height = Math.max(20, (p.endMin - p.startMin) * pxPerMin);
    const playing = isNowPlaying(p, date, min);
    const box = el(
      "div",
      {
        class: "sched-col",
        style: `top:${top}px;left:${col * 128}px;width:120px;height:${height}px;${playing ? "outline:2px solid var(--ok)" : ""}`,
        onclick: () => openDetailModal(p),
      },
      [el("div", { class: "t" }, fmtRange(p.start, p.end)), el("div", { class: "n" }, p.name)]
    );
    grid.appendChild(box);
  });
  axis.appendChild(grid);
  wrap.appendChild(axis);
  return wrap;
}

function exportFavoritesFile() {
  const data = {
    exportedAt: new Date().toISOString(),
    favorites: [...store.state.favorites],
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sancha-daidougei-mytt-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- 更新履歴 ----------
document.getElementById("btn-changelog").addEventListener("click", openChangelogModal);
function updateChangelogBadge() {
  const btn = document.getElementById("btn-changelog");
  const latest = store.state.changes?.history?.[0]?.checkedAt;
  const unread = latest && (!store.state.seenChangeAt || latest > store.state.seenChangeAt);
  btn.classList.toggle("has-badge", !!unread);
  btn.classList.toggle("muted", !unread);
}
const OFFICIAL_SITE_URL = "https://arttown.jp/";
// 公式タイムテーブル公開後はそのページのURLに差し替える（現状は出演パフォーマー一覧）
const OFFICIAL_TIMETABLE_URL = "https://arttown.jp/performer";

function openChangelogModal() {
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const sheet = el("div", { class: "modal-sheet" });
  sheet.appendChild(el("button", { class: "modal-close", onclick: () => backdrop.remove() }, "✕"));
  sheet.appendChild(el("div", { class: "modal-title" }, "更新履歴"));

  const history = store.state.changes?.history || [];
  if (history.length) {
    sheet.appendChild(el("h4", { style: "color:var(--muted);font-size:.78rem;text-transform:uppercase;margin:10px 0 6px" }, "出演者情報の変更"));
    history.forEach((h) => {
      sheet.appendChild(
        el("div", { class: "changelog-date-row" }, [
          el("span", { class: "changelog-date" }, h.checkedAt),
          el(
            "a",
            { class: "changelog-official-link", href: OFFICIAL_TIMETABLE_URL, target: "_blank", rel: "noopener" },
            "公式サイトで確認 ↗"
          ),
        ])
      );
      (h.items || []).forEach((item) => {
        const tagLabel = { added: "追加", removed: "削除", swap: "交代", modified: "変更" }[item.kind] || item.kind;
        sheet.appendChild(
          el("div", { class: "changelog-item" }, [el("span", { class: `tag ${item.kind}` }, tagLabel), el("span", {}, item.text || JSON.stringify(item))])
        );
      });
    });
  } else {
    sheet.appendChild(el("p", { style: "color:var(--muted)" }, "出演者情報の変更履歴はまだありません。"));
  }

  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);

  store.state.seenChangeAt = history[0]?.checkedAt || store.state.seenChangeAt;
  store.persistSeenChanges();
  updateChangelogBadge();
}

// ---------- 設定 ----------
// ---------- ☰メニュー（設定／使い方） ----------
const $menuBtn = document.getElementById("btn-menu");
const $menuPop = document.getElementById("menu-pop");
function setMenuOpen(open) {
  $menuPop.hidden = !open;
  $menuBtn.setAttribute("aria-expanded", String(open));
}
$menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenuOpen($menuPop.hidden);
});
document.addEventListener("click", (e) => {
  if (!$menuPop.hidden && !$menuPop.contains(e.target)) setMenuOpen(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$menuPop.hidden) setMenuOpen(false);
});
document.getElementById("menu-settings").addEventListener("click", () => {
  setMenuOpen(false);
  openSettingsModal();
});
document.getElementById("menu-help").addEventListener("click", () => setMenuOpen(false));

// ---------- 初回起動時の使い方案内 ----------
function isHelpSeen() {
  try {
    return localStorage.getItem(LS_HELP_SEEN) === "true";
  } catch {
    return false;
  }
}
// 書き込み→読み戻しで、保存できた時だけtrue（保存できない環境では毎回「初回」になってしまうため出さない）
function markHelpSeen() {
  try {
    localStorage.setItem(LS_HELP_SEEN, "true");
    return localStorage.getItem(LS_HELP_SEEN) === "true";
  } catch {
    return false;
  }
}
function showHelpWelcome() {
  if (isHelpSeen()) return;
  // 共有リンク(?fav=)経由は取り込み確認を優先し、案内は次の通常起動に回す（フラグも立てない）
  if (new URLSearchParams(location.search).has("fav") || fromFavLink) return;
  if (!markHelpSeen()) return;
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const sheet = el("div", { class: "modal-sheet" }, [
    el("div", { class: "modal-title" }, "はじめての方へ"),
    el("p", {}, "出演者のお気に入り登録、マップ、マイタイムテーブルなど、アプリの使い方を説明したページがあります。"),
    el("p", { class: "sub-note", style: "margin:0 0 12px" }, "あとから見たいときは、右上の ☰ →「使い方」から開けます。"),
    el("div", { class: "btn-row" }, [
      // 自動でwindow.openするとポップアップとしてブロックされるので、ダイアログ経由のリンクで新しいタブに開く
      el("a", { class: "btn primary", href: HELP_URL, target: "_blank", rel: "noopener", onclick: () => backdrop.remove() }, "使い方を見る"),
      el("button", { class: "btn", onclick: () => backdrop.remove() }, "あとで"),
    ]),
  ]);
  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);
}

function openSettingsModal() {
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const sheet = el("div", { class: "modal-sheet" });
  sheet.appendChild(el("button", { class: "modal-close", onclick: () => backdrop.remove() }, "✕"));
  sheet.appendChild(el("div", { class: "modal-title" }, "設定"));

  // 文字サイズ
  const fontRow = el("div", { class: "settings-row" });
  fontRow.appendChild(el("div", {}, [el("div", { class: "label" }, "文字サイズ")]));
  const seg = el("div", { class: "seg-control" });
  ["normal", "large"].forEach((v) => {
    seg.appendChild(
      el(
        "button",
        {
          class: store.state.settings.fontSize === v ? "active" : "",
          onclick: () => {
            store.state.settings.fontSize = v;
            store.persistSettings();
            document.documentElement.classList.toggle("font-large", v === "large");
            backdrop.remove();
            openSettingsModal();
          },
        },
        v === "normal" ? "標準" : "大"
      )
    );
  });
  fontRow.appendChild(seg);
  sheet.appendChild(fontRow);

  // 時刻シミュレーション
  const simRow = el("div", { class: "settings-row" });
  simRow.appendChild(el("div", {}, [el("div", { class: "label" }, "時刻シミュレーション"), el("div", { class: "desc" }, "開催日前でも当日の見え方を確認できます")]));
  const simInput = el("input", {
    type: "datetime-local",
    value: store.state.settings.simTime || "",
    onchange: (e) => {
      store.state.settings.simTime = e.target.value || null;
      store.persistSettings();
      render();
    },
  });
  simRow.appendChild(simInput);
  sheet.appendChild(simRow);

  // 現在地シミュレーション
  const geoSimRow = el("div", { class: "settings-row" });
  geoSimRow.appendChild(el("div", {}, [el("div", { class: "label" }, "現在地シミュレーション"), el("div", { class: "desc" }, "GPSが使えない環境での動作確認用")]));
  const useSimGeo = !!store.state.settings.simGeo;
  const geoSwitch = mkSwitch(useSimGeo, (checked) => {
    if (checked) {
      const v = store.state.venues[0];
      store.state.settings.simGeo = v ? { lat: v.lat, lng: v.lng } : { lat: 35.6437, lng: 139.671 };
    } else {
      store.state.settings.simGeo = null;
    }
    store.persistSettings();
    render();
    backdrop.remove();
    openSettingsModal();
  });
  geoSimRow.appendChild(geoSwitch);
  sheet.appendChild(geoSimRow);

  // 現在地の自動更新
  const autoRow = el("div", { class: "settings-row" });
  autoRow.appendChild(el("div", {}, [el("div", { class: "label" }, "現在地の自動更新"), el("div", { class: "desc" }, "フォアグラウンド復帰時・マップ表示時に測位")]));
  autoRow.appendChild(
    mkSwitch(store.state.settings.autoLocate, (checked) => {
      store.state.settings.autoLocate = checked;
      store.persistSettings();
      if (checked) locateOnce();
    })
  );
  sheet.appendChild(autoRow);

  // 共有・書き出し
  const shareSection = el("div", { class: "modal-section" });
  shareSection.appendChild(el("h4", {}, "お気に入りの共有・バックアップ"));
  const btnRow = el("div", { class: "btn-row" });
  btnRow.appendChild(
    el(
      "button",
      { class: "btn", onclick: shareFavoritesLink },
      navigator.share ? "🔗 共有する" : "🔗 共有リンクをコピー"
    )
  );
  btnRow.appendChild(el("button", { class: "btn", onclick: exportFavoritesFile }, "💾 ファイルに書き出す"));
  const importInput = el("input", { type: "file", accept: "application/json", style: "display:none", onchange: handleImportFile });
  btnRow.appendChild(el("button", { class: "btn", onclick: () => importInput.click() }, "📂 ファイルから読み込む"));
  shareSection.append(btnRow, importInput);
  sheet.appendChild(shareSection);

  // このアプリについて & 免責事項
  const aboutSection = el("div", { class: "modal-section about-section" });
  aboutSection.appendChild(el("h4", {}, "このアプリについて・免責事項"));
  aboutSection.appendChild(
    el("div", { class: "disclaimer-box" }, [
      el("p", {}, "本アプリは有志による非公式ファンアプリです。三茶de大道芸 実行委員会（三軒茶屋 太子堂 アートタウン）および関係団体とは一切関係ありません。"),
      el("p", {}, [
        "最新・正確な情報については必ず ",
        el("a", { href: OFFICIAL_SITE_URL, target: "_blank", rel: "noopener" }, "公式サイト（arttown.jp）"),
        " をご確認ください。本アプリに関するお問い合わせを公式運営事務局へ行うことはご遠慮ください。"
      ])
    ])
  );
  aboutSection.appendChild(el("p", { class: "sub-note", style: "margin:10px 0 0" }, "本アプリ: MIT License © 2026 ishinttr-eng"));
  const appLog = store.state.appChangelog?.entries || [];
  if (appLog.length) {
    const det = el("details", { class: "app-changelog" });
    det.appendChild(el("summary", {}, "アプリの更新履歴"));
    let lastDate = null;
    appLog.forEach((e) => {
      if (e.date !== lastDate) {
        det.appendChild(el("div", { class: "changelog-date" }, e.date));
        lastDate = e.date;
      }
      det.appendChild(el("div", { class: "changelog-item" }, [el("span", { class: "tag" }, e.version), el("span", {}, e.text)]));
    });
    aboutSection.appendChild(det);
  }
  sheet.appendChild(aboutSection);

  // オープンソース & データクレジット
  const creditSection = el("div", { class: "modal-section credit-section" });
  creditSection.appendChild(el("h4", {}, "クレジット・ライセンス"));
  const creditList = el("ul", { class: "credits-list" }, [
    el("li", {}, [
      el("span", { class: "credit-label" }, "地図データ: "),
      el("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener" }, "OpenStreetMap contributors"),
      el("span", { class: "credit-lic" }, " (ODbL)")
    ]),
    el("li", {}, [
      el("span", { class: "credit-label" }, "マップエンジン: "),
      el("a", { href: "https://leafletjs.com/", target: "_blank", rel: "noopener" }, "Leaflet"),
      el("span", { class: "credit-lic" }, " (BSD 2-Clause)")
    ]),
    el("li", {}, [
      el("span", { class: "credit-label" }, "天気データ: "),
      el("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noopener" }, "Weather data by Open-Meteo.com"),
      el("span", { class: "credit-lic" }, " (CC BY 4.0)")
    ]),
    el("li", {}, [
      el("span", { class: "credit-label" }, "徒歩ルート: "),
      el("a", { href: "http://project-osrm.org/", target: "_blank", rel: "noopener" }, "OSRM"),
      " via ",
      el("a", { href: "https://routing.openstreetmap.de/", target: "_blank", rel: "noopener" }, "FOSSGIS e.V.")
    ])
  ]);
  creditSection.appendChild(creditList);
  sheet.appendChild(creditSection);

  backdrop.appendChild(sheet);
  $modalRoot.appendChild(backdrop);
}

function mkSwitch(checked, onChange) {
  const label = el("label", { class: "switch" });
  const input = el("input", { type: "checkbox", checked: checked || undefined, onchange: (e) => onChange(e.target.checked) });
  label.append(input, el("span", { class: "track" }));
  return label;
}

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      confirmImport(data.favorites || []);
    } catch {
      alert("読み込みに失敗しました");
    }
  };
  reader.readAsText(file);
}

function confirmImport(keys) {
  const merge = confirm(`${keys.length}件のお気に入りを取り込みます。\nOK: 既存に追加（マージ） / キャンセル: 中止`);
  if (!merge) return;
  keys.forEach((k) => store.state.favorites.add(k));
  store.persistFavorites();
  render();
  alert("取り込みました");
}

function buildShareUrl(keys) {
  return `${location.origin}${location.pathname}?fav=${encodeURIComponent(keys.join(","))}`;
}

// お気に入りをnavigator.share（端末の共有シート）で送る。非対応環境ではクリップボードにコピーする
async function shareFavoritesLink() {
  const keys = [...store.state.favorites];
  if (!keys.length) {
    alert("お気に入りがまだ登録されていません");
    return;
  }
  const url = buildShareUrl(keys);
  if (navigator.share) {
    try {
      await navigator.share({ title: "三茶大道芸ナビ マイタイムテーブル", url });
    } catch {
      // 共有シートのキャンセル等は何もしない
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    alert("共有リンクをコピーしました");
  } catch {
    prompt("このリンクをコピーしてください", url);
  }
}

let fromFavLink = false;
function checkUrlImport() {
  const params = new URLSearchParams(location.search);
  const fav = params.get("fav");
  if (fav) {
    fromFavLink = true;
    const keys = fav.split(",").filter(Boolean);
    confirmImport(keys);
    history.replaceState({}, "", location.pathname);
  }
}

// ---------- 現在地取得 ----------
function locateOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geolocation unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        store.state.currentGeo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        render();
        resolve(store.state.currentGeo);
      },
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && store.state.settings.autoLocate && !store.state.settings.simGeo) locateOnce();
});

// ---------- ヘッダー: バージョン・公式データ確認日時 ----------
// sw.js側のCACHE_NAME(=VERSION)と二重管理にならないよう、値そのものはここでは持たない
async function currentSwVersion() {
  if (!("caches" in window)) return null;
  try {
    // 新旧のキャッシュが一時的に共存することがある（新SWのinstall直後〜旧SWのactivate削除まで）ため、
    // 見つかった中で一番新しい（数値が大きい）ものを採用する
    const keys = (await caches.keys()).filter((k) => k.startsWith("scd-"));
    if (!keys.length) return null;
    keys.sort((a, b) => (parseInt(b.slice(5), 10) || 0) - (parseInt(a.slice(5), 10) || 0));
    return keys[0].slice("scd-".length);
  } catch {
    return null;
  }
}

async function updateHeaderInfo() {
  const el2 = document.getElementById("header-updated");
  if (!el2) return;
  const checkedAt = store.state.checked?.checkedAt || store.state.performancesUpdatedAt;
  const ver = await currentSwVersion();
  if (!checkedAt) {
    el2.textContent = ver || "";
    return;
  }
  const d = new Date(checkedAt);
  const text =
    `確認: ${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}時点` +
    (ver ? ` / ${ver}` : "");
  el2.textContent = text;
}

// 新しいService Workerが有効化されてページの制御を引き継いだら、ヘッダーのバージョン表示を追従させる
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => updateHeaderInfo());
}

// ---------- init ----------
async function init() {
  await store.loadAll();
  updateChangelogBadge();
  checkUrlImport();
  updateHeaderInfo();
  if (store.state.settings.autoLocate && !store.state.settings.simGeo) locateOnce();
  render();
  showHelpWelcome();
  store.fetchWeather().then((w) => {
    weatherData = w;
    render();
  });
}

init();
