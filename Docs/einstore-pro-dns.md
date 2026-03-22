# einstore.pro DNS Records

Migrated from GoDaddy (`ns01.domaincontrol.com` / `ns02.domaincontrol.com`) to Cloudflare.

## Cloudflare

- **Zone ID:** `a183cf01a63bc3288064dbb962d60624`
- **Nameservers:** `magali.ns.cloudflare.com`, `woz.ns.cloudflare.com`

## Original Records (pre-migration)

| Type | Name | Value | Notes |
|---|---|---|---|
| A | einstore.pro | 162.159.140.98 | Proxied |
| A | einstore.pro | 172.66.0.96 | Proxied |
| CNAME | www | einstore.pro | Proxied |
| CNAME | api | einstore-5ybqs.ondigitalocean.app | DO App Platform |
| CNAME | admin | einstore-5ybqs.ondigitalocean.app | DO App Platform |
| TXT | _dmarc | v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net; | Original DMARC |

## SES Records (added)

### eu-west-1 (production)

| Type | Name | Value |
|---|---|---|
| TXT | _amazonses | qnAgKA3geXBqsULl3lYuePlCkKj0qIXDXfAhbOgrJ5w= |
| CNAME | asstr6u3zs7ugtuedyqrkh7afystance._domainkey | asstr6u3zs7ugtuedyqrkh7afystance.dkim.amazonses.com |
| CNAME | dvdrkx3xfbwdu7n26efk7arntsmuapef._domainkey | dvdrkx3xfbwdu7n26efk7arntsmuapef.dkim.amazonses.com |
| CNAME | 2uacbuktne2avx3gybsbzexgpvw4ppmc._domainkey | 2uacbuktne2avx3gybsbzexgpvw4ppmc.dkim.amazonses.com |

### us-east-1 (backup/sandbox)

| Type | Name | Value |
|---|---|---|
| TXT | _amazonses | d0LT3xNYgsuQh5IMNzraeCcHAZJq3/kH8+v2KW3uUwQ= |
| CNAME | pqfj522j2qrqlh3vsaoc5irr7cn2ewfb._domainkey | pqfj522j2qrqlh3vsaoc5irr7cn2ewfb.dkim.amazonses.com |
| CNAME | jprjddiqen43eiwkyn2pgltj7e73tusq._domainkey | jprjddiqen43eiwkyn2pgltj7e73tusq.dkim.amazonses.com |
| CNAME | lkexese5lsjkggxw2ypwo3rqa2znzwwd._domainkey | lkexese5lsjkggxw2ypwo3rqa2znzwwd.dkim.amazonses.com |

### Shared

| Type | Name | Value |
|---|---|---|
| TXT | einstore.pro | v=spf1 include:amazonses.com ~all |
| MX | bounce | feedback-smtp.us-east-1.amazonses.com (priority 10) |
| TXT | bounce | v=spf1 include:amazonses.com ~all |

## Email Routing

Cloudflare Email Routing enabled. `info@einstore.pro` forwards to `ondrej.rafaj@gmail.com`.
