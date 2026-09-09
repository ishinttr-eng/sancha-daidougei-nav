#!/usr/bin/env python3
"""
全会場ペアの徒歩ルートをFOSSGIS OSRMから一括取得し、data/routes.json / data/walktimes.json を更新する。
一度きりのセットアップ用。中断しても再実行時は取得済みペアをスキップして再開できる。
サーバー負荷対策で1リクエストごとに0.3秒のインターバルを挟む。
"""
import json
import time
import urllib.request
import itertools

OSRM_BASE = "https://routing.openstreetmap.de/routed-foot/route/v1/foot"
DATA_DIR = "data"
REQUEST_INTERVAL_SEC = 0.3


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def fetch_route(lng1, lat1, lng2, lat2):
    url = f"{OSRM_BASE}/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=polyline"
    with urllib.request.urlopen(url, timeout=10) as res:
        data = json.loads(res.read())
    route = data["routes"][0]
    return {
        "distM": round(route["distance"]),
        "durMin": round(route["duration"] / 60),
        "poly": route["geometry"],
    }


def main():
    venues = load_json(f"{DATA_DIR}/venues.json")["venues"]
    try:
        routes_data = load_json(f"{DATA_DIR}/routes.json")
    except FileNotFoundError:
        routes_data = {"routes": {}}

    pairs = list(itertools.combinations(sorted(v["id"] for v in venues), 2))
    by_id = {v["id"]: v for v in venues}

    for a, b in pairs:
        key = f"{a}|{b}"
        if key in routes_data["routes"]:
            continue
        va, vb = by_id[a], by_id[b]
        try:
            routes_data["routes"][key] = fetch_route(va["lng"], va["lat"], vb["lng"], vb["lat"])
            print(f"取得完了: {key}")
        except Exception as e:
            print(f"取得失敗: {key} ({e})")
        time.sleep(REQUEST_INTERVAL_SEC)
        save_json(f"{DATA_DIR}/routes.json", routes_data)

    # walktimes.json も実測値で上書き
    ids = sorted(by_id.keys())
    minutes = [[0] * len(ids) for _ in ids]
    for i, a in enumerate(ids):
        for j, b in enumerate(ids):
            if i == j:
                continue
            key = "|".join(sorted([a, b]))
            r = routes_data["routes"].get(key)
            if r:
                minutes[i][j] = r["durMin"]
    save_json(f"{DATA_DIR}/walktimes.json", {"ids": ids, "minutes": minutes, "source": "OSRM"})
    print("walktimes.json を実測値で更新しました。")


if __name__ == "__main__":
    main()
