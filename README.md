# sancha-daidougei-nav

三茶大道芸2026 ナビゲーションアプリ

## 概要

三茶大道芸2026向けのナビゲーションアプリ（PWA）。JSF Navi 2026（定禅寺ストリートジャズフェスティバル向けナビ）の設計をベースに移植。
ビルド不要のvanilla JS、APIキー・自前サーバー不要（地図: Leaflet+OSM、天気: Open-Meteo、徒歩ルート: OSRM）、GitHub Pagesでの静的ホスティングを想定。

## 画面構成

- 🎪 演奏中 — いま演奏中/まもなく開始の出演者、現在地からの徒歩時間と「間に合う/間に合わない」判定
- 🗓 出演者・タイムテーブル — 日付タブ＋検索＋会場/ジャンル絞り込み
- 🗺 マップ — 全会場ピン、マイルートモード（次のお気に入り会場への経路）
- ★ マイタイムテーブル — お気に入りから組む自分のスケジュール、移動時間の警告、共有/エクスポート

## ステータス

**サンプルデータで動作する骨組みが完成。** `data/*.json` は全てダミーデータ（会場名・出演者名・日程はすべて仮）。

実データが来たら差し替えが必要な箇所:

- `data/venues.json` / `data/performances.json` — 実際の会場・出演者情報に差し替え
- `js/util.js` の `DAYS` / `DAY_LABELS` — 実際の開催日程に変更
- `js/store.js` の `WEATHER_LAT` / `WEATHER_LNG` — 天気取得地点（現状は三軒茶屋駅付近の仮座標）
- `tools/build_data.py` の `OFFICIAL_PERFORMERS_URL` / `OFFICIAL_VENUES_URL` / `parse_raw()` — 公式データの取得元とパース処理（現状はスタブ）
- `data/routes.json` / `data/walktimes.json` — `tools/build_routes.py` を実行して実測の徒歩ルートに更新（現状は直線距離ベースの概算のみ）

## ローカルでの動作確認

ビルド不要。プロジェクトルートで任意の静的サーバーを立てるだけ。

```sh
python3 -m http.server 8765
# http://localhost:8765/index.html を開く
```

## デプロイ

`main`にpushすると`.github/workflows/deploy-pages.yml`がGitHub Pagesへ自動デプロイ（`tools/`は除外）。
`.github/workflows/update-data.yml`が3時間ごとに公式データを再取得（`OFFICIAL_PERFORMERS_URL`設定後に有効化される）。
