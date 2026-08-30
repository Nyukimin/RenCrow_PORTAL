# Remote browser E2E timeout

## Failure

`portal_browser_proxy_e2e`と`portal_canonical_actor_e2e`が、公開PORTALを取得した後、
`/viewer/send`へ到達せずtimeoutした。

## Problem

remote verifierのactive configがSSH認証名から`C:\Users\nyukimi`を推定していたが、
実際のWindows profileは`C:\Users\moca2`だった。artifactを正しいprofileへ配備した後も、
headless browserのChat既定recipientがShiroであるため、検証開始後のMio切替でShiroとMioの
PuruPuru assetを直列取得し、座標clickと切替完了待ちが送信前の高遅延境界になった。

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

## Enforcement

`internal/verify/browser_live.go`が公開origin上のlocal preferenceをMioへ固定してからChatをloadし、
Mio選択とinput readinessをpollしてから送信する。remote configはowner-only modeで検査する。

## Tests

- `TestBrowserPrimesMioBeforeLoadingChat`
- `TestBrowserWaitsForMioReadyBeforeSending`
- moca-PC Edgeによる`portal_browser_proxy_e2e`
