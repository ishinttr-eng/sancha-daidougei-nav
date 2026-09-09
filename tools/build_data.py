#!/usr/bin/env python3
"""
公式データ → data/venues.json, data/performances.json への変換 + 差分検出。

TODO: 三茶大道芸2026の公式データ提供元が確定したら、以下を実装する。
- OFFICIAL_PERFORMERS_URL: 出演者情報の取得元URL
- OFFICIAL_VENUES_URL: 会場情報の取得元URL（無ければ手動でMANUAL_COORDSに座標を用意する）
- parse_raw(): 生データ(tools/raw/配下)をperformances/venuesの形に変換する処理
現状はダミーのサンプルデータをそのまま維持するだけのスタブになっている。
"""
import json
import sys
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))
DATA_DIR = "data"

# 会場公式ページに座標が無い/取得できない場合の手動補完テーブル。
# key: venueId, value: (lat, lng)
MANUAL_COORDS = {
    # "S-06": (35.6440, 139.6720),
}

OFFICIAL_PERFORMERS_URL = None  # TODO: 公式フィードURLを設定
OFFICIAL_VENUES_URL = None  # TODO: 公式フィードURLを設定（無い場合はNoneのままMANUAL_COORDSを使う）


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def fetch_raw():
    """公式データを取得する。URLが未設定ならNoneを返し、既存データをそのまま維持する。"""
    if not OFFICIAL_PERFORMERS_URL:
        print("OFFICIAL_PERFORMERS_URL が未設定のため、既存の data/performances.json をそのまま維持します。")
        return None
    import urllib.request

    with urllib.request.urlopen(OFFICIAL_PERFORMERS_URL) as res:
        return res.read()


def parse_raw(raw_bytes):
    """生データをperformances/venuesの形式に変換する。フェスごとに実装が異なる。"""
    raise NotImplementedError("公式データの形式が確定したら実装してください")


def detect_diff(old_perfs, new_perfs):
    """id+dateキーで比較し、name/venueId/start/end/genreの変化を検出する。
    同一枠での追加＋削除は「交代(swap)」として1件にまとめる。"""
    old_by_key = {(p["id"], p["date"]): p for p in old_perfs}
    new_by_key = {(p["id"], p["date"]): p for p in new_perfs}

    items = []
    for key, np_ in new_by_key.items():
        if key not in old_by_key:
            items.append({"kind": "added", "summary": f"{np_['name']} が追加されました"})
    for key, op in old_by_key.items():
        if key not in new_by_key:
            items.append({"kind": "removed", "summary": f"{op['name']} が削除されました"})
    for key in set(old_by_key) & set(new_by_key):
        op, np_ = old_by_key[key], new_by_key[key]
        changed_fields = [f for f in ("name", "venueId", "start", "end", "genre") if op.get(f) != np_.get(f)]
        if changed_fields:
            items.append({
                "kind": "modified",
                "summary": f"{op['name']} の {', '.join(changed_fields)} が変更されました",
            })
    return items


def main():
    perf_path = f"{DATA_DIR}/performances.json"
    checked_path = f"{DATA_DIR}/checked.json"
    changes_path = f"{DATA_DIR}/changes.json"

    old = load_json(perf_path) or {"performances": []}

    raw = fetch_raw()
    if raw is None:
        # データ取得元未設定: 差分検出はスキップし、checkedAtだけ更新する
        save_json(checked_path, {"checkedAt": datetime.now(JST).isoformat()})
        print("checked.json のみ更新しました（データソース未設定）。")
        return

    new_perfs, new_venues = parse_raw(raw)
    diff_items = detect_diff(old["performances"], new_perfs)

    save_json(perf_path, {"updatedAt": datetime.now(JST).isoformat(), "performances": new_perfs})
    save_json(f"{DATA_DIR}/venues.json", {"updatedAt": datetime.now(JST).isoformat(), "venues": new_venues})
    save_json(checked_path, {"checkedAt": datetime.now(JST).isoformat()})

    if diff_items:
        changes = load_json(changes_path) or {"history": []}
        changes["history"].insert(0, {
            "checkedAt": datetime.now(JST).isoformat(),
            "sourceUpdatedAt": datetime.now(JST).isoformat(),
            "items": diff_items,
        })
        changes["history"] = changes["history"][:20]
        save_json(changes_path, changes)
        print(f"{len(diff_items)}件の変更を検出しました。")
    else:
        print("変更はありませんでした。")


if __name__ == "__main__":
    sys.exit(main())
