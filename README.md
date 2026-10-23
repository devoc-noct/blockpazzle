# ブロックパズル（GitHub + Vercel 公開版）

ブラウザのゲーム本体に、部屋番号で参加する2人対戦機能を追加したプロジェクトです。
Vercel Functions の WebSocket と Redis Pub/Sub を使い、別々のFunctionインスタンスに接続したプレイヤー間でもイベントを中継します。

## 公開に必要なもの

- GitHubアカウント
- Vercelアカウント
- Upstash Redisデータベース（VercelのMarketplace連携から作成してもOK）

## GitHub → Vercel

1. ZIPを展開し、中のファイルとフォルダーをGitHubリポジトリのルートにアップロードします。
2. Vercelで **Add New → Project** を選び、対象のGitHubリポジトリをImportします。
3. Framework PresetがNext.jsとして認識されていることを確認します。
4. UpstashでRedisデータベースを作成し、TLS付きのネイティブRedis接続URL（`rediss://...`）をコピーします。REST API URLではなく、Redis接続URLを使います。
5. Vercelの **Project → Settings → Environment Variables** で `REDIS_URL` を追加し、値に接続URLを設定します。値は公開したりGitHubへコミットしたりしないでください。
6. **Redeploy** して環境変数を反映します。
7. 公開URLを2台の端末で開き、片方で「部屋を作る」、もう片方で4桁の番号を入力して「部屋に参加」を押します。

## ローカルでの準備

Node.js 20以降を用意し、Redisの接続URLを `.env.local` に設定します。

```text
REDIS_URL=rediss://ユーザー名:パスワード@ホスト:ポート
```

その後、プロジェクトのルートで実行します。

```bash
npm install
npm run dev
```

ローカルでWebSocketアップグレードを確認する場合は、Vercel CLIの最新版で `vercel dev` を使ってください。Vercel専用のWebSocketアップグレードAPIは通常の `next dev` では動かない場合があります。

## 注意点

- このプロジェクトは試作版です。実際の本番公開前に、2台の端末で部屋作成・参加・切断・再参加・攻撃の動作確認をしてください。
- WebSocket接続はVercel Functionの最大実行時間に達すると切断される場合があります。長時間対戦を安定させるには、再接続と試合状態の復元を追加する必要があります。
- `REDIS_URL` がないと通信は動きません。Redisの接続情報は秘密として扱ってください。
- サーバー側は部屋番号・部屋人数・送信データを最低限検証していますが、不正アクセス対策や対戦の完全な公平性を保証するものではありません。
