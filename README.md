# RenCrow_PORTAL

RenCrow_PORTALは、RenCrowを外部利用者が閲覧・操作するための独立Webポータルです。デバッグViewer、状態の正本、演算処理は持たず、`RenCrow_CORE`のPublic APIへ許可した要求だけを中継します。

## モード

- `view`: 会話イベントと状態の閲覧専用
- `lab`: 会話送信、会話相手の選択、IdleChat開始・停止
- `live`: `view`への互換エイリアス

Debug、Ops、Repair、設定変更などの管理APIは中継しません。

## 起動

```bash
make build
./build/rencrow-portal
```

既定値:

```text
PORTAL  http://127.0.0.1:18791
CORE    http://127.0.0.1:18790
```

設定ファイルを使う場合:

```bash
cp portal.example.json portal.json
./build/rencrow-portal -config portal.json
```

環境変数でも上書きできます。

```text
RENCROW_PORTAL_LISTEN
RENCROW_CORE_URL
RENCROW_PORTAL_DEFAULT_MODE
RENCROW_PORTAL_CONFIG
```

外部公開時はPORTALの前段に認証済みリバースプロキシまたはTailscale Serveを置いてください。既定では安全側としてloopbackだけで待ち受けます。

CORE側で`RENCROW_PORTAL_URL=http://127.0.0.1:18791`を設定すると、従来の`/viewer?mode=lab|live|view`はPORTALへ移動します。通常のデバッグViewerはCOREに残ります。

## 検証

```bash
go test ./...
go vet ./...
make build
```
