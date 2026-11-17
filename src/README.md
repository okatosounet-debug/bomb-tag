# ばくおに！ — ソース

3〜6人で爆弾を押しつけあう、おにごっこゲーム。© 2026 スタジオ・ペン

## ファイル

| ファイル | 中身 |
|---|---|
| `src/game.html` | ゲーム本体（これ1つで全部。claude.ai のアーティファクト版はこのファイルそのもの） |
| `src/net-adapter.js` | 公開サイト用のオンライン対戦（Supabase Realtime ＋ WebRTC、ボイスチャットも） |
| `src/build.py` | 公開サイト用の `index.html`（リポジトリのいちばん上）を作る道具 |
| `index.html` | 公開サイト（bomb-tag.vercel.app）に出ているファイル。**直接は直さない**（build.py で作り直す） |

## 直して公開する流れ

1. `src/game.html`（オンラインの通信まわりなら `src/net-adapter.js`）を直す
2. `python3 src/build.py` を実行 → いちばん上の `index.html` が作り直される
   - esbuild があれば小さく圧縮される（`npx` が使えれば自動）。なくても動く
3. `index.html` と `src/` をコミットして main に push → Vercel が自動で公開
4. claude.ai 版も直すなら、`src/game.html` をアーティファクトに反映する

## 中身のメモ

- three.js r128（CDN）＋ WebAudio で音楽・効果音をその場で合成
- オンラインはホストが正しさを決める方式（packState / applyState）
- 日本語の文字列がそのまま英語辞書のキー（`const EN = {...}`）。新しい文字を足したら EN にも足す
- 全体の速さ：`PLAY_SPEED`（今は 0.8）
- ランキングは Supabase の `bt_scores` テーブル（publishable キーのみ使用）。書き込みはサーバーの関数 `bt_submit()` 経由
  （`supabase/bt_scores_secure.sql` を Supabase の SQL Editor で一度実行する。未実行の間は前の書き込み方で動く）
- オンラインのメッセージは署名つき（net-adapter.js）。プレイヤーIDは各タブの公開鍵から作られ、なりすましできない

## 注意

Supabase の **secret / service_role キーは絶対にここに入れない**。使っているのは公開してよい publishable キーだけ。
