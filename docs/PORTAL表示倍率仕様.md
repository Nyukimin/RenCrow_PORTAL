# PORTAL Chat 表示倍率・レイアウト比率仕様

## 目的

Chat画面を、縦向けと横向けの2種類の完成レイアウトとして扱う。
端末やwindowの縦横比が基準レイアウトと一致しない場合も、画面内の要素配置、寸法比、
重なり順を変形せず、キャンバス全体を等比率で収める。

あわせて、会話入力中にPORTAL全体の表示倍率や表示位置が変化しない、安定した操作画面を
提供する。

## 対象

- 本仕様は`mode=Chat`の画面全体に適用する。
- 対象には背景、アバター、Topic、日時、会話相手の選択、会話欄、入力欄、操作button、
  状態表示を含む。
- `IdleChat`と`Games`へ同じレイアウト比率を暗黙に適用しない。それぞれの仕様で明示する。

## 正規表示プロファイル

Chat画面が使用できるレイアウトは次の2種類だけとする。

| profile | 原版の物理解像度 | browser上の論理キャンバス | 基準比率 | 初期選択条件 |
| --- | ---: | ---: | ---: | --- |
| `landscape` | 1920 x 1080 | 1920 x 1080 | 16:9 | 初期layout viewportで`width >= height` |
| `portrait` | 1179 x 2556 | 393 x 852 | 393:852 | 初期layout viewportで`width < height` |

- 物理解像度は基準表示のpixel寸法、論理キャンバスはbrowser内の配置座標系とする。
- Device Pixel Ratioはprofile選択条件に使わない。
- 上記2種類の中間profile、端末固有profile、要素単位の可変profileを生成しない。
- profileはページ初期表示時に一度だけ決定し、同じページの表示中は切り替えない。

## 等比フィットと余白

利用可能なlayout viewportを`Vw x Vh`、選択した論理キャンバスを`Cw x Ch`とすると、
表示倍率と配置は次で確定する。

```text
scale = min(Vw / Cw, Vh / Ch)
renderedWidth  = Cw * scale
renderedHeight = Ch * scale
offsetX = (Vw - renderedWidth) / 2
offsetY = (Vh - renderedHeight) / 2
```

- `scale`はX軸とY軸へ同じ値を適用し、キャンバス全体を拡大・縮小する。
- 描画済みキャンバスは利用可能領域の中央へ置く。
- 横方向が余る場合は左右を余白（pillarbox）、縦方向が余る場合は上下を余白
  （letterbox）として背景色または背景画像で埋める。
- 余白はレイアウトを拡張する領域ではない。アバター、会話欄、入力欄、操作buttonなどを
  余白へ移動・追加しない。
- 余白をなくすための非等方scale、キャンバスのcrop、縦横profile間の補間を行わない。

例えば`456 x 646`のviewportでは`portrait`を選択し、`393 x 852`のキャンバスを
約`298 x 646`へ等比縮小して中央配置する。残る左右約`79px`ずつは余白とする。
`456 x 646`へキャンバス自体を引き伸ばしたり、個々の要素を`vw`と`vh`で別々に
再配置したりしない。

## キャンバス内部の配置不変条件

- 各profile内の要素は、そのprofileの論理キャンバス座標で配置する。
- 外側のviewport寸法へ個々の要素を直接追従させない。外側へのfitはキャンバスrootの
  単一scaleとoffsetだけで行う。
- `vw`、`vh`、`dvw`、`dvh`を使って、アバター、会話欄、入力欄などをviewportごとに
  独立伸縮させない。
- Chatでは選択中のMio、Shiro、Kuro、Midoriのうち1体だけを、profileで定義した同じ
  中央slotへ表示する。character切替でslotの位置と寸法比を変えない。
- 会話messageの増加は会話欄内部のscrollで処理し、キャンバスや他要素を押し広げない。
- 文字サイズの小・中・大は読みやすさの設定であり、キャンバス比率、全体scale、profile、
  基準slotを変更しない。

## 規則

- Chat画面の表示プロファイルと初期倍率は、ページ初期表示時に一度だけ決定する。
- ユーザー入力、入力欄フォーカス、ソフトウェアキーボード表示、AI応答、メッセージ追加、入力欄の高さ変化を理由に、画面全体を再フィットしない。
- `visualViewport.resize`および`visualViewport.scroll`を、自動拡大・縮小の入力に使わない。
- 通常の`window.resize`や`pageshow`でも、初期化済みの画面倍率を自動変更しない。
- 表示倍率はブラウザのズーム操作など、利用者が明示的に変更した場合だけ変わる。
- Chat入力欄はmobileを含めて16px以上とし、入力フォーカス時のブラウザ自動ズームを防ぐ。
- 画面向きやウィンドウ寸法を変更して別の表示プロファイルを使う場合は、ページを再読み込みする。

## 実装契約

- profile判定にはページ初期表示時のlayout viewportを使う。ソフトウェアキーボードなどで
  一時的に変化する`visualViewport`をprofile判定やfitの入力にしない。
- `landscape`と`portrait`の両方を、同じ等比フィット式で初期配置する。
- DOM上のChat surfaceは選択した論理キャンバス寸法を維持し、キャンバスrootへ単一の
  `scale`と中央offsetを適用する。
- JavaScriptのprofile metadataとCSSのorientation条件は、同じprofileを示さなければ
  ならない。一方が`landscape`、他方が`portrait`となる状態を許可しない。
- `portal-viewport-lock.js`は`portal.js`の実行中だけ、PORTALの自動再フィットに使われる`window.resize`、`pageshow`、`visualViewport.resize`、`visualViewport.scroll`の登録を抑止する。
- `portal-viewport-unlock.js`は`portal.js`実行後に通常のイベント登録機能を復元する。
- `body.dataset.chatCanvasFitPolicy`は`initial-only`とする。
- `portal-viewport-lock.css`は`#roomInput`の実効フォントサイズを16px以上に固定する。
- 利用者によるブラウザ標準のズーム操作は妨げない。

## 受け入れ条件

1. 初期viewportが横長なら`landscape`、縦長なら`portrait`だけが選択される。
2. 任意のviewport比率で、描画キャンバスの縦横比が選択profileの基準比率と一致する。
3. 基準比率と一致しないviewportでは、余剰領域が左右または上下の余白となり、
   キャンバスの変形・crop・要素の再配置が発生しない。
4. JavaScriptのprofile metadata、CSSの適用profile、実際のキャンバス寸法が一致する。
5. Chat入力欄を繰り返し選択・入力しても、PORTAL全体の倍率が変化しない。
6. mobileのソフトウェアキーボードを開閉しても、Chat canvasの倍率が再計算されない。
7. AI応答やSSEメッセージが追加されても、画面全体の倍率と位置が維持される。
8. Mio、Shiro、Kuro、Midoriを切り替えても、選択中の1体が同じ中央slotと寸法比で
   表示される。
9. 利用者によるブラウザズームは利用できる。
