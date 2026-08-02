# PORTAL 表示倍率仕様

## 目的

会話入力中にPORTAL全体の表示倍率や表示位置が変化しない、安定した操作画面を提供する。

## 規則

- Chat画面の表示プロファイルと初期倍率は、ページ初期表示時に一度だけ決定する。
- ユーザー入力、入力欄フォーカス、ソフトウェアキーボード表示、AI応答、メッセージ追加、入力欄の高さ変化を理由に、画面全体を再フィットしない。
- `visualViewport.resize`および`visualViewport.scroll`を、自動拡大・縮小の入力に使わない。
- 通常の`window.resize`や`pageshow`でも、初期化済みの画面倍率を自動変更しない。
- 表示倍率はブラウザのズーム操作など、利用者が明示的に変更した場合だけ変わる。
- Chat入力欄はmobileを含めて16px以上とし、入力フォーカス時のブラウザ自動ズームを防ぐ。
- 画面向きやウィンドウ寸法を変更して別の表示プロファイルを使う場合は、ページを再読み込みする。

## 実装契約

- `portal-viewport-lock.js`は`portal.js`の実行中だけ、PORTALの自動再フィットに使われる`window.resize`、`pageshow`、`visualViewport.resize`、`visualViewport.scroll`の登録を抑止する。
- `portal-viewport-unlock.js`は`portal.js`実行後に通常のイベント登録機能を復元する。
- `body.dataset.chatCanvasFitPolicy`は`initial-only`とする。
- `portal-viewport-lock.css`は`#roomInput`の実効フォントサイズを16px以上に固定する。
- 利用者によるブラウザ標準のズーム操作は妨げない。

## 受け入れ条件

1. Chat入力欄を繰り返し選択・入力しても、PORTAL全体の倍率が変化しない。
2. mobileのソフトウェアキーボードを開閉しても、Chat canvasの倍率が再計算されない。
3. AI応答やSSEメッセージが追加されても、画面全体の倍率と位置が維持される。
4. 利用者によるブラウザズームは利用できる。
