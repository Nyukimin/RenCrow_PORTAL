# PORTAL Chat／IdleChat排他ライフサイクル仕様

## 1. 目的

RenCrow_PORTALのChatとIdleChatを、同じ会話欄へ混在するmodeではなく、排他的な2つの
利用者surfaceとして扱います。

- IdleChat画面を表示したらIdleChatを開始する。
- Chat画面を表示している間はIdleChatを停止する。
- Chat画面へIdleChatのmessageと音声を表示・再生しない。
- 複数tab、画面再読込、browser異常終了でも誤った再開や孤立実行を残さない。

cross-moduleの正本はRenCrow_COREの次の文書です。

- `docs/02_機能仕様.md`の「PORTAL、Debug Viewerと観測性」
- `docs/04_アーキテクチャ概要.md`の「PORTAL Chat／IdleChat排他ライフサイクル」
- `docs/06_Public_API仕様.md`の「PORTAL surface在席API」

本書はPORTALでの画面挙動と受入条件を詳細化し、COREの契約を上書きしません。

## 2. 「画面を表示」の定義

対象はtop-level documentの現在modeと`document.visibilityState`です。

| 状態 | 在席 |
| --- | --- |
| `mode=Chat`かつ`visibilityState=visible` | `surface=chat`をclaimする |
| `mode=IdleChat`かつ`visibilityState=visible` | `surface=idlechat`をclaimする |
| `visibilityState=hidden`、`pagehide`、別modeへ遷移 | 現在surfaceをreleaseする |
| browser crash、network断などrelease不能 | CORE側の30秒lease失効でreleaseと同等に扱う |

`viewer_client_id`はtab単位の不透明IDです。同じtabの再読込で維持してもよいですが、別tabと
共有しません。可視中は10秒ごとにheartbeatし、同じclaim、heartbeat、releaseの再送を
安全に行えるものとします。

## 3. 有効modeの決定

開始／停止の正本はCOREです。PORTALは`POST /viewer/surface-presence`で在席を通知し、
`/viewer/idlechat/start`または`/viewer/idlechat/stop`を呼びません。

| 有効な在席 | COREの結果 | PORTALの表示 |
| --- | --- | --- |
| Chatが1件以上 | IdleChat停止、`effective_mode=chat` | Chatをreadyにできる |
| Chatなし、IdleChatが1件以上 | IdleChat開始、`effective_mode=idlechat` | IdleChatを実行中と表示できる |
| ChatとIdleChatの両方 | Chat優先、IdleChat停止 | Chatはready、IdleChatは待機中 |
| どちらもなし | PORTAL起因では開始しない、`effective_mode=none` | 実行中を表示しない |

Chatが複数tabで開かれている場合、最後のChat在席がreleaseまたは失効するまでIdleChatを
開始しません。最後のChatが閉じた時に可視IdleChatが残っていればCOREが開始し、残って
いなければ自動再開しません。

## 4. 起動とready条件

### Chat

1. 初期状態では入力欄、送信、recipient切替、STTをdisabledにする。
2. `surface=chat, action=claim`を送る。
3. 応答が`effective_mode=chat`かつ`idlechat_active=false`であることを確認する。
4. 確認後にだけChat操作をreadyにする。

停止確認前に利用者入力を受け付けません。claim失敗、timeout、期待状態との不一致では
「IdleChat停止を確認できません。再接続中です」と表示し、Chat操作をdisabledのままにします。

### IdleChat

1. 初期状態を「開始確認中」とし、COREの応答を待たずにMioとShiroを表示する。
2. `surface=idlechat, action=claim`を送る。
3. 応答が`effective_mode=idlechat`かつ`idlechat_active=true`なら「実行中」と表示する。
4. `effective_mode=chat`なら「別のChat画面を表示中のため待機中」と表示する。

claim失敗またはtimeoutでは「IdleChatを開始できません」と表示します。PORTALだけで成功状態を
推測したり、local timerだけで実行中へ変えたりしません。MioとShiroの描画は実行状態の
成功表示ではないため、開始確認中、待機中、errorでも維持します。

### IdleChatのキャラクター配置

- キャラクター切替buttonを表示しない。
- 画面へ遷移した直後からMioとShiroの2体を表示し、開始claimの完了を描画条件にしない。
- 横画面はChatの`landscape`と同じ`1920 x 1080`論理キャンバスを使い、layout viewportへ
  等比fitして中央配置する。余剰領域は左右または上下の余白とし、cropや非等方scaleを行わない。
- 縦画面には固定キャンバスを適用せず、既存のresponsive配置を維持する。
- 横画面、縦画面のどちらも、各キャラクターの描画枠を同じ向きのChat画面と同じサイズにする。
- 画面幅を縦に4等分し、PuruPuru描画枠の透明余白を除いたMioの可視キャラクター中心を左1/4の`x=25%`、Shiroの可視キャラクター中心を右1/4の`x=75%`へ置く。
- Shiroは横画面、縦画面のどちらも同じ向きの基準位置からY軸方向へ`20pt`上に配置する。MioのY位置は変更しない。
- 下部の会話欄は、横画面、縦画面のどちらも上端をPuruPuru描画枠の透明余白を除いたShiroの可視キャラクター下端へ一致させる。
- KuroとMidoriはIdleChatへ表示しない。

## 5. eventと音声の分離

SSE eventは受信時点の現在modeでfilterします。mode変更前に受信したeventや再接続時の再送も
同じ規則を適用します。

| surface | 会話欄へ表示する | 表示しない |
| --- | --- | --- |
| Chat | `message.received`、利用者向け`agent.response`、既存契約で公開対象の`agent.progress`／`agent.acknowledge` | `idlechat.message`、thinking、routing、非公開worker event |
| IdleChat | `idlechat.message` | `message.received`、`agent.response`、thinking、routing、worker event |

- ChatではIdleChat由来のTTS audioを取得、再生、ACKしません。
- IdleChatでは通常Chat由来のTTS audioを取得、再生、ACKしません。
- mode切替時は旧modeの再生待ちqueueと再生中audioを停止し、旧modeのmessageを新しい会話欄へ移しません。
- 重複eventは`message_id`で除外しますが、重複除外より先にmode filterを適用しても、後に適用しても表示結果が同じでなければなりません。

## 6. 権限境界

`mode=IdleChat`は利用者操作として読み取り専用です。state-changingな例外は
`POST /viewer/surface-presence`の`surface=idlechat`だけです。

- IdleChat画面へ開始／停止buttonを置かない。
- Chat画面にもIdleChatの開始／停止buttonを置かない。
- `portal-idlechat`から`surface=chat`を送れない。
- `portal-chat`から`surface=idlechat`を送れない。
- 両profileから`POST /viewer/idlechat/start|stop`を中継しない。
- Debug、Ops、Repair、設定変更APIを追加公開しない。

PORTAL serverはbrowserが送ったclient/profile headerを信頼せず、page modeに応じた
`X-RenCrow-Client: RenCrow_PORTAL`とInteraction profileへ上書きします。

## 7. 受入条件

1. IdleChatだけを可視表示すると30秒以内ではなくclaim応答の完了時点でIdleChatが開始され、IdleChat messageだけが表示される。
2. IdleChat実行中にChatを可視表示するとIdleChatと未送信TTS queueが停止し、停止確認後にChat入力が有効になる。
3. Chat表示中に届いた`idlechat.message`は、live eventでもSSE再送でもChat会話欄へ表示されない。
4. ChatとIdleChatを別tabで可視表示するとChatが優先され、IdleChat側は待機中を表示する。
5. 最後のChat tabを閉じた時、可視IdleChat tabが残っていればIdleChatが開始される。
6. 最後のIdleChat tabを閉じ、ChatもなければPORTAL起因のIdleChat実行は残らない。
7. tabを強制終了してreleaseできなくても30秒以内にleaseが失効し、集約状態が修復される。
8. profileとsurfaceの不一致、未知action、空の`viewer_client_id`は拒否され、状態を変更しない。
9. heartbeat、release、同一requestの再送でIdleChat sessionを二重起動しない。
10. CORE unavailable時はChat操作をreadyにせず、IdleChatを実行中と表示しない。
11. IdleChatの初期描画には切替buttonがなく、CORE応答前からChatと同寸のMioとShiroが`x=25%`／`x=75%`を中心に表示される。
12. 横画面と縦画面の双方でKuroとMidoriがIdleChatへ表示されない。

## 8. 実装と検証境界

CORE endpoint、lease集約、PORTAL allowlist、browser lifecycle、event／TTS filterを実装します。
変更時はCOREを先に検証し、CORE contract test、PORTAL proxy policy test、browser lifecycle test、
複数tab testの順に確認します。単一tabの表示成功だけで排他制御の完了とは扱いません。
