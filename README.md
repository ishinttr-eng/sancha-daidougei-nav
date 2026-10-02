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

## データの状況（2026-10-02時点）

公式サイト（https://arttown.jp/archives/9908 ）が会場案内図・タイムテーブルを**画像(JPG)とパンフレットPDF**として公開した。
HTML/JSONでの構造化データは提供されていないため、JSF Navi由来の「HTMLを自動フェッチしてパース」という仕組みは使えず、
**PDF内のタイムテーブル画像を目視で転記**して実データ化した（詳細は `tools/build_data.py` の冒頭コメント）。

| ファイル | 状態 |
|---|---|
| `data/venues.json` | 公式タイムテーブルのA〜L表記＋ヘブンアーティストIN三茶の4地点、計16会場。座標はOSM(Nominatim)で実在施設名と照合（9会場）/ 会場案内図からの推定（7会場、`approx: true`）。推定分は要現地確認 |
| `data/performances.json` | **実データ**（120件、2026-10-17/18）。ジャンル・国(region)・紹介文(intro)も `arttown.jp/performer` の個別ページ45件を確認して反映済み。「神出鬼没ウォーキングアクト」「公募ウォーキングアクト」「終日の三茶ストリート出店(あめ細工/ボディペイント/占い)」は固定の会場・時刻を持たないため未収録 |
| `data/routes.json` / `walktimes.json` | OSRMの実測徒歩ルート（新16会場・120ペア全て取得済み） |
| `data/tieup.json` | 空（協賛ステージ等は未確認） |

### 今後やること

1. 「approx: true」の7会場（B/C/E/G/H/HA1-4）の座標を現地確認し、正確な値に差し替える（差し替えたら `python3.13 tools/build_routes.py` を再実行）
2. 神出鬼没ウォーキングアクト・公募ウォーキングアクト・終日の三茶ストリート出店をどう見せるか決めて実装する（現状データにも UI にも無い）
3. 公式が新しい画像/PDFを出した場合、差分を目視確認して `performances.json` を手で更新する（自動スクレイピングは成立しないため）

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

## ライセンス

このリポジトリ自体のコードは [MIT License](LICENSE) です。上記クレジット欄の各データ・ライブラリは、それぞれ元のライセンス（ODbL・BSD・CC BY 4.0等）に従います。
