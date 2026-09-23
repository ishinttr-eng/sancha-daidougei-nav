#!/usr/bin/env python3
"""
三茶de大道芸 公式サイトから data/performances.json を生成し、前回との差分を data/changes.json に積む。

2026-09-24時点、公式サイト（https://arttown.jp/）は出演パフォーマー一覧（名前・ジャンル・国・紹介文）
のみ公開で、タイムテーブル（出演日時・出演場所）は未公開。そのため OFFICIAL_TIMETABLE_URL は未設定のままとし、
その間はデータを一切書き換えずに終了する（checked.json も更新しない＝「確認した」と偽らない）。

タイムテーブル公開後にやること:
  1. 公式の該当ページをブラウザで開き、実際のHTML構造（クラス名・入れ子・時刻表記）を確認する
  2. OFFICIAL_TIMETABLE_URL を設定し、parse_timetable() を実マークアップに合わせて実装する
  3. VENUE_MAP（公式の会場表記 → venues.json の id）を実表記に合わせて更新する
  4. GitHub Actions の update-data を手動実行し、期待した件数が抽出できることを確認する

実行:
    python3 tools/build_data.py
"""
import json
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "tools" / "raw" / "timetable.html"
DATA = ROOT / "data"
JST = timezone(timedelta(hours=9))

OFFICIAL_TIMETABLE_URL = None  # 例: "https://arttown.jp/timetable"（公開後に設定）
USER_AGENT = "SanchaDaidougeiNaviBot/1.0 (+https://github.com/ishinttr-eng/sancha-daidougei-nav)"

# 公式の会場表記（正規化後）→ venues.json の id。タイムテーブル公開後に実表記に合わせる。
VENUE_MAP = {
    "烏山川緑道": "S-01",
    "あい・あい・ロード": "S-02",
    "ふれあい広場": "S-03",
    "nttひろば": "S-04",
    "エコー仲見世": "S-05",
    "サンタワーズ広場": "S-06",
    "栄通り": "S-07",
}


def pad_time(t: str) -> str:
    """9:50 → 09:50（文字列ソートに使う箇所があるため必ずゼロ埋めする）"""
    h, m = t.split(":")
    return f"{int(h):02d}:{int(m):02d}"


def fetch_raw():
    if not OFFICIAL_TIMETABLE_URL:
        return None
    req = urllib.request.Request(OFFICIAL_TIMETABLE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as res:
        html = res.read().decode("utf-8")
    RAW.parent.mkdir(parents=True, exist_ok=True)
    RAW.write_text(html, encoding="utf-8")
    return html


def parse_timetable(html: str):
    """公式タイムテーブルHTML → performances のリスト。
    推測で書かない。公開後に実マークアップを確認してから実装すること。"""
    raise NotImplementedError("公式タイムテーブル公開後、実際のHTML構造を確認してから実装してください")


QUOTE_TRANSLATION = str.maketrans({
    "‘": "'", "’": "'", "ʼ": "'", "`": "'",
    "“": '"', "”": '"',
})


def normalize_for_diff(name: str) -> str:
    """表記ゆれ（全角/半角、スペースの数・全角スペース混在、引用符の字形違い等）を
    差分として誤検出しないための比較用正規化。表示用のテキストには使わない。"""
    s = unicodedata.normalize("NFKC", name or "")
    s = s.translate(QUOTE_TRANSLATION)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def diff_performances(old_list, new_list):
    def nkey(p):
        return (p["venueId"], p["date"], p["start"], normalize_for_diff(p["name"]))

    old_by_key = {nkey(p): p for p in old_list}
    new_by_key = {nkey(p): p for p in new_list}
    added = [p for k, p in new_by_key.items() if k not in old_by_key]
    removed = [p for k, p in old_by_key.items() if k not in new_by_key]
    items = []
    # 同一枠(venueId+date+start)で名前（表記ゆれ除く）が変わっていれば「交代」扱い
    old_slots = {(p["venueId"], p["date"], p["start"]): p for p in old_list}
    new_slots = {(p["venueId"], p["date"], p["start"]): p for p in new_list}
    handled_names = set()
    for slot, np in new_slots.items():
        op = old_slots.get(slot)
        if op and normalize_for_diff(op["name"]) != normalize_for_diff(np["name"]):
            items.append({"kind": "swap", "text": f"{op['name']} → {np['name']}（{slot[2]}〜）"})
            handled_names.add(np["name"])
            handled_names.add(op["name"])
    for p in added:
        if p["name"] not in handled_names:
            items.append({"kind": "added", "text": f"{p['name']} が追加されました"})
    for p in removed:
        if p["name"] not in handled_names:
            items.append({"kind": "removed", "text": f"{p['name']} が削除されました"})

    # フィールド単位の変更検出（同一枠・同一名のまま、終了時刻やジャンル等だけが変わったケース）
    MODIFIED_FIELDS = [
        ("end", "終了時刻"),
        ("genre", "ジャンル"),
        ("region", "国・地域"),
    ]
    for key, np in new_by_key.items():
        op = old_by_key.get(key)
        if not op:
            continue
        changes = []
        for field, label in MODIFIED_FIELDS:
            ov, nv = op.get(field, ""), np.get(field, "")
            if ov != nv:
                changes.append(f"{label}: {ov or '（空欄）'} → {nv or '（空欄）'}")
        if changes:
            items.append({
                "kind": "modified",
                "text": f"{np['name']}（{np['start']}〜）が変更されました: " + " / ".join(changes),
            })
    return items


def main():
    html = fetch_raw()
    if html is None:
        print("[build_data] OFFICIAL_TIMETABLE_URL が未設定のため何もしません（公式タイムテーブル未公開）。")
        return 0

    performances = parse_timetable(html)
    if not performances:
        print("[build_data] 出演情報を1件も抽出できませんでした。parse_timetable() を見直してください。", file=sys.stderr)
        return 1

    perf_path = DATA / "performances.json"
    old_list = []
    if perf_path.exists():
        try:
            old_list = json.loads(perf_path.read_text(encoding="utf-8")).get("performances", [])
        except Exception:
            old_list = []

    now = datetime.now(JST).isoformat()
    perf_path.write_text(json.dumps({"updatedAt": now, "performances": performances}, ensure_ascii=False, indent=2), encoding="utf-8")
    (DATA / "checked.json").write_text(json.dumps({"checkedAt": now}, ensure_ascii=False, indent=2), encoding="utf-8")

    items = diff_performances(old_list, performances)
    if items:
        changes_path = DATA / "changes.json"
        changes = {"history": []}
        if changes_path.exists():
            try:
                changes = json.loads(changes_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        changes.setdefault("history", []).insert(0, {"checkedAt": now, "items": items})
        changes["history"] = changes["history"][:20]
        changes_path.write_text(json.dumps(changes, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[build_data] 差分 {len(items)} 件を検出しました")
    else:
        print("[build_data] 差分なし")
    print(f"[build_data] {len(performances)} 件の出演情報を書き出しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
