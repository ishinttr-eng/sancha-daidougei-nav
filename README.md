# 三茶大道芸ナビ 2026（sancha-daidougei-nav）

「第30回 三茶de大道芸2026」（2026年10月17日(土)・18日(日)、世田谷区三軒茶屋駅周辺）の非公式ナビゲーターPWA。
「フェスナビ設計図」（JSF Navi 2026 / すみだジャズナビの構成をまとめた仕様書）に沿い、すみだジャズナビの実装をベースに移植した。
ビルド不要のvanilla JS。地図はOpenStreetMap＋Leaflet、天気はOpen-Meteo、徒歩ルートはOSRM（FOSSGIS）を使用し、APIキー・自前サーバーは不要。

## 画面構成

- 🎪 上演中 — いま上演中/30分以内に開始の演目、現在地取得ボタン、徒歩時間と「間に合う/間に合わない」判定、終了したステージの折りたたみ
- 📅 出演者 — 日付タブ＋検索（かな/カナ同一視）＋会場/ジャンル絞り込み、詳細モーダル、お気に入り
- 🗺️ マップ — 会場ピン（タップで会場詳細）、選択中ピンのハイライト、検索候補一覧、マイルートモード（区間ごと色分け＋カルーセル）
- ★ マイタイムテーブル — リスト/スケジュール表、演目間の徒歩時間、移動時間不足・重複の警告
- 共通 — 設定（文字サイズ・時刻/現在地シミュレーション・共有・書き出し）、更新履歴（出演者情報の変更＋アプリ更新）

## データの状況（2026-09-24時点）

| ファイル | 状態 |
|---|---|
| `data/venues.json` | 公式の参加商店街7会場。**座標はOSM(Nominatim)で調べた推定値**（`approx: true`）。公式会場マップで要確認 |
| `data/performances.json` | **サンプルデータ**（`"sample": true`）。公式タイムテーブルが未公開のため |
| `data/routes.json` / `walktimes.json` | OSRMの実測徒歩ルート（21区間）。会場座標を直したら `tools/build_routes.py` を再実行 |
| `data/tieup.json` | 空（協賛ステージ等は未確認） |

公式サイトの出演パフォーマー一覧（https://arttown.jp/performer ）は名前・ジャンル・国・紹介文のみで、出演日時・場所はまだ無い。

### 公式タイムテーブル公開後にやること

1. 公式ページの実際のHTML構造を確認してから `tools/build_data.py` の `OFFICIAL_TIMETABLE_URL` / `parse_timetable()` / `VENUE_MAP` を実装する（推測で書かない）
2. GitHub Actions の `update-data` を手動実行し、期待件数が抽出されることを確認する
3. 会場の正確な座標が分かったら `data/venues.json` を直し、`build-routes` ワークフロー（またはローカルで `python3.13 tools/build_routes.py`）を実行
4. `js/app.js` の `OFFICIAL_TIMETABLE_URL` をタイムテーブルページに差し替え
5. UIを変えたら `sw.js` の `VERSION` を上げ、`data/app_changelog.json` に追記

### 実装しなかった任意機能

設計図の「要確認」項目のうち、公式サイトで実施が確認できなかったため未実装: スタンプラリー、アワード投票、感想・評価。

## ローカルで動かす

```bash
python3 -m http.server 8765
```

http://localhost:8765/ を開く。Service Workerを使うため `file://` では動かない。

macOS標準のPythonはTLSが古く、`build_routes.py` がOSRMとのハンドシェイクに失敗する。Homebrewの `python3.13` を使うこと。

## デプロイ

- `deploy-pages.yml` — mainへのpushでGitHub Pagesへ公開（`tools/`・`.github/`は除外）
- `update-data.yml` — 3時間ごとに `build_data.py` を実行。差分があればコミットし、`deploy-pages.yml` を明示起動（GITHUB_TOKENのpushは他ワークフローを起動しないため）
- `build-routes.yml` — 徒歩ルートの一括取得（手動実行）

## 免責事項

本アプリは有志による**非公式ファンアプリ**です。三茶de大道芸 実行委員会（三軒茶屋 太子堂 アートタウン）および関係団体とは一切関係ありません。最新・正確な情報は必ず [公式サイト](https://arttown.jp/) をご確認ください。

お気に入り等はすべて端末のlocalStorageにのみ保存され、外部には送信されません。

## クレジット

- 地図: [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL)
- マップライブラリ: [Leaflet](https://leafletjs.com/) (BSD 2-Clause)
- 天気: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0)
- 徒歩ルート: [OSRM](http://project-osrm.org/) via [FOSSGIS e.V.](https://routing.openstreetmap.de/)
