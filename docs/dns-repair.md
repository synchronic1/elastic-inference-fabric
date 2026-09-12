# Cloudflare DNS repair packet

**Observed:** 2026-09-12T19:59:27Z (UTC)

## Affected hostname

- Hostname: `elasticinferencefabric.airanger.dev`
- Worker: `ganglion-fabric` (production)
- Stable Worker URL: `https://ganglion-fabric.medinas-sd.workers.dev`
- Cloudflare account: `5bdd4f746ccac889f54e026435565e70`
- Zone: `airanger.dev` (`1bbd2698395c8a193db39b25f5ac3be0`)
- Workers custom-domain binding: `96f9436ddb6cded1a8793201df579bbcc73d1ed4`
- Certificate ID: `fd4b8f2d-b847-4c91-8931-792519674e28`

The Worker deployment is healthy. At the observation time, both of these
returned HTTP 200 with successful certificate verification:

```sh
curl -sS --resolve elasticinferencefabric.airanger.dev:443:104.21.75.134 \
  -o /dev/null -w '%{http_code} tls=%{ssl_verify_result}\n' \
  https://elasticinferencefabric.airanger.dev/healthz
curl -sS -o /dev/null -w '%{http_code} tls=%{ssl_verify_result}\n' \
  https://ganglion-fabric.medinas-sd.workers.dev/healthz
```

## Important safety constraint

Cloudflare rejected an attempted manual proxied `AAAA 100::` record for this
exact hostname with: **"A DNS record managed by Workers already exists on that
host."** Do **not** delete, recreate, or override that managed record, custom
domain binding, or certificate.

## DNS evidence

The Workers control plane reports the existing custom-domain record as enabled
and attached to `ganglion-fabric`. Yet direct DNS requests to every published
address for both authoritative nameservers returned an authoritative NODATA
answer (NOERROR, AA flag, zone SOA; no A answer), over both UDP and TCP.

```sh
# Authoritative addresses queried: all six nola/peyton anycast addresses.
for ip in 108.162.192.212 172.64.32.212 173.245.58.212 \
          108.162.193.221 172.64.33.221 173.245.59.221; do
  dig +norecurse +tcp @"$ip" elasticinferencefabric.airanger.dev A
  dig +norecurse      @"$ip" elasticinferencefabric.airanger.dev A
done
```

In contrast, encrypted public resolver paths answered with the normal
Cloudflare anycast A records `104.21.75.134` and `172.67.177.74`:

```sh
curl -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=elasticinferencefabric.airanger.dev&type=A'
curl 'https://dns.google/resolve?name=elasticinferencefabric.airanger.dev&type=A'
```

An authenticated TLS connection to Cloudflare DoT (`1.1.1.1:853`, certificate
for `cloudflare-dns.com`) also returned `rcode=0` with two answers. Regular
direct `dig` checks against `1.1.1.1`, `8.8.8.8`, and `9.9.9.9` returned the
same NODATA/SOA as the authoritative checks.

## Requested Cloudflare action

This establishes a path-dependent DNS discrepancy, **not a definitive
Cloudflare authoritative DNS defect**. A Workers-managed publication or
regional anycast inconsistency is plausible, but all port-53 checks originated
on one network. A shared intermediary could intercept UDP and TCP regardless
of destination; AA flags and SOA contents do not authenticate the responding
server. Six destination addresses are not six independent vantage points.
Encrypted recursive resolvers could also be returning cached positive answers;
TLS authenticates the resolver, not the freshness of its answer.

Please investigate the **existing Workers-managed record** for
`elasticinferencefabric.airanger.dev`, including its contents, publication state,
and regional serving consistency, and repair/re-publish it if needed. Do not require a
delete/recreate of the custom-domain binding or its certificate. The current
OAuth credential can read the Worker-domain binding but is not authorized to
read or write zone DNS records, so there is no safe self-service repair path.

## Next evidence that would discriminate causes

1. Direct authoritative probes from unrelated networks/ASNs, retaining full
   responses, timestamps, SOA/TTLs, destination, and vantage location.
2. Independent cache-aware observations after the positive and negative TTLs,
   comparing encrypted recursive answers with authoritative responses. Resolver
   serve-stale behavior remains a caveat.
3. Read-only inspection by a zone-authorized administrator or Cloudflare support
   of the existing managed record and any pending publication/error state.

This evidence framing was independently reviewed through Oxen's `gpt-6-astra`
on 2026-09-12. The reviewer analyzed the supplied packet; it did not run network
queries. Escalation remains justified without claiming a proven root cause.
