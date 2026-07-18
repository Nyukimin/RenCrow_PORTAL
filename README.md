# RenCrow_PORTAL

RenCrow_PORTALは、MioやShiroが部屋の中で会話するAI VTuber形式の画面を、外部利用者が閲覧・操作するための独立Webポータルです。デバッグViewer、状態の正本、演算処理は持たず、`RenCrow_CORE`のPublic APIへ許可した要求だけを中継します。

`RenCrow_ASSISTANT`との連携後は、個人・家族の予定、Routine、通知履歴、端末設定を表示・操作するWeb clientにもなります。生活Routine、PUSH、delivery状態の正本はASSISTANTであり、PORTALへ複製しません。現在の実装はCORE proxyのみで、ASSISTANT API連携はplannedです。

## モード

- `view`: AI VTuberの部屋を閲覧する読み取り専用画面
- `live`: 配信用の読み取り専用画面。会話とトピックを大きく表示し、部屋や操作UIは表示しない
- `lab`: AI VTuber画面に加えて、会話送信、会話相手の選択、IdleChat開始・停止、TTS再生、STTマイク入力

`live`と`lab`は別の表示です。`live`は配信、`lab`は部屋での操作・実験に使います。

Debug、Ops、Repair、設定変更などの管理APIは中継しません。

ASSISTANT連携でも、読み取り画面からwrite actionを許可せず、他利用者のprivate data、secret、device credentialを中継しません。

## COREとの操作契約

PORTALは状態の正本を持たず、Lab操作をCOREのPublic APIへ通知します。

- 会話相手の切替は`POST /viewer/recipient-selection`で観測eventを発行し、実際の送信先は`POST /viewer/send`の`to`で確定する
- TTSは`POST /viewer/active-control`で再生権を取得し、`GET /viewer/tts/audio`で音声を取得して、再生完了を`POST /viewer/tts/playback-ack`へ返す
- STTは同じactive-controlのinput権を取得し、`GET /stt`のWebSocketへ16 kHz PCM16を送る
- `view`と`live`はこれらの操作を許可しない

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

```text
http://127.0.0.1:18791/?mode=live
http://127.0.0.1:18791/?mode=lab
http://127.0.0.1:18791/?mode=view
```

## 検証

```bash
go test ./...
go vet ./...
make build
```
