# Remote browser E2E timeout

## Failure

`portal_browser_proxy_e2e`と`portal_canonical_actor_e2e`が、公開PORTALを取得した後、
`/viewer/send`へ到達せずtimeoutした。

## Problem

remote verifierのactive configがSSH認証名から`C:\Users\nyukimi`を推定していたが、
実際のWindows profileは`C:\Users\moca2`だった。artifactを正しいprofileへ配備した後も、
headless browserのChat既定recipientがShiroであるため、検証開始後のMio切替でShiroとMioの
PuruPuru assetを直列取得し、座標clickと切替完了待ちが送信前の高遅延境界になった。
さらにremote Edgeでは送信dispatchがnetwork observerへ現れるまで30秒を超える場合があり、
PORTALとCOREがjobを正常受理しても固定30秒のcapture窓が先に閉じた。
OS入力注入の`SendKeys`はremote Edgeで長時間blockした後にEnterを再dispatchし、同一browser clientから
複数jobを作る場合があった。
fixture本文の`PORTAL E2E`はCORE routerに`OPS`と分類され、検証対象外のShiro worker availabilityへ
依存していた。
CDPのnetwork callbackはremote Edgeのこのsend responseを安定して観測できず、COREが受理しても
verifierがresponse bodyとjob IDを取得できなかった。

## Cause

WindowsのSSH user名とprofile directoryを同一視したruntime config drift、および固定fixtureの
recipientをChat document load後に切り替える検証順序が原因だった。

## Lesson

remote pathは実hostのprofileから確定し、存在確認後にartifactを配備する。固定browser fixtureの
local preferenceは公開origin上でChat load前に設定し、検証対象外のavatar二重loadを発生させない。

## Invariant

- remote verifier、manifest、Evidence directoryはactive configの実profile配下に存在する。
- browser fixtureは公開Tailscale origin、PORTAL allowlisted route、CORE job、DOM resultを迂回しない。
- 固定recipientはChat load前に決定し、送信前に選択状態とinput readinessを確認する。
- send response captureは全体5分上限内の90秒に固定し、remote dispatch遅延を許容する。
- Enterはtextareaのowner `keydown` handlerへ単発DOM eventとして渡し、OS入力再送を許さない。
- fixture本文は通常のMio挨拶に限定し、exact job IDで相関して運用keywordを本文へ混ぜない。
- send receiptはpageが実際に使う`fetch`のresponse cloneから取得し、同一origin・allowlist path・POSTだけを受理する。
- page内のverifier submitは一度だけとし、CDP actionの遅延中も同一pageから再dispatchしない。

## Enforcement

`internal/verify/browser_live.go`が公開origin上のlocal preferenceをMioへ固定してからChatをloadし、
Mio選択とinput readinessをpollし、page-owned `fetch`の限定観測を設置してから送信する。
remote configはowner-only modeで検査する。

## Tests

- `TestBrowserPrimesMioBeforeLoadingChat`
- `TestBrowserWaitsForMioReadyBeforeSending`
- `TestBrowserSendCaptureWindowCoversRemoteDispatch`
- `TestBrowserSubmitsThroughOnePageKeydownEvent`
- `TestBrowserFixtureRequestsChatWithoutOperationalKeywords`
- `TestBrowserCapturesPageOwnedSendReceipt`
- moca-PC Edgeによる`portal_browser_proxy_e2e`
