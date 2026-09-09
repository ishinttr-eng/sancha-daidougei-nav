// 汎用ユーティリティ: 時刻変換・検索正規化・距離計算・DOM生成ヘルパー

export const DAYS = ["2026-10-03", "2026-10-04"]; // TODO: 実際の開催日程に差し替え
export const DAY_LABELS = { "2026-10-03": "1日目（土）", "2026-10-04": "2日目（日）" };

export function hmToMin(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

export function minToHm(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function nowMin(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

export function todayStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// NFKC正規化 → 小文字化 → 全角カタカナをひらがな相当にシフト、で表記ゆれを吸収する
export function normalize(s) {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/\s+/g, "");
}

// お気に入りの複合キー: 同じ出演者IDが複数日・複数枠に再登場するケースに対応
export function perfKey(p) {
  return `${p.id}__${p.date}__${p.start}`;
}

// Haversine距離（km）
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// 実測ルートが無い場合の徒歩時間概算: 直線距離 × 道のり補正1.3 ÷ 徒歩速度80m/分
export function estimateWalkMin(lat1, lng1, lat2, lng2) {
  const km = haversineKm(lat1, lng1, lat2, lng2);
  const m = km * 1000 * 1.3;
  return Math.max(1, Math.round(m / 80));
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function fmtDate(dateStr) {
  return DAY_LABELS[dateStr] || dateStr;
}
