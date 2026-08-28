# Owner Evidence self-collection

## Failure

The common full-system executor reached PORTAL browser checks without owner-specific browser Evidence or authentication flags.

## Problem

The previous error combined missing Evidence ingress, browser runner, and authentication into one ambiguous boundary.

## Cause

The active PORTAL config publishes the loopback proxy route but contains no canonical browser credential reference. A real authenticated browser run therefore cannot be started safely from common arguments alone.

## Lesson

PORTAL owns browser Evidence acquisition. Browser automation may start only after the owner resolves a canonical credential reference; HTTP-only probing is not browser E2E and a local proxy response is not an authenticated actor receipt.

## Invariant

- Tools passes only the four common arguments.
- PORTAL never emits credential bytes into Evidence.
- Missing canonical authentication is `authentication_unavailable`.
- The actor check cannot pass without a real browser actor and CORE trace.

## Enforcement

Common-arguments-only browser checks fail closed at the authentication boundary. Explicit Evidence input remains bounded, fresh, allowlisted, and validated against the published PORTAL origin and CORE proxy path.

## Tests

Unit tests distinguish the common-arguments authentication boundary from malformed explicit Evidence and enforce real actor/trace requirements.
