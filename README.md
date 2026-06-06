# Stalk GitHub Users

Configured GitHub kullanıcılarının **public** aktivitelerini izler ve yeni olayları Discord webhook'a ayrıntılı bildirir. Şu olaylar desteklenir:

- `PushEvent`: yeni commit/push değişiklikleri
- `CreateEvent`: yeni public repo, branch veya tag oluşturma
- `IssuesEvent`: yeni issue açma
- `PullRequestEvent`: yeni PR açma

Bildirimler kullanıcı, aksiyon tipi, repo, başlık/özet, GitHub URL, zaman, branch, commit, issue ve PR detaylarını içerir. Event ID'leri kalıcı state dosyasında tutulduğu için aynı olay restart sonrası tekrar gönderilmez.

## Kurulum

```bash
pnpm install
cp .env.example .env
```

CLI başlangıçta `.env` dosyasını otomatik yükler. `.env` içindeki değerleri düzenleyin:

```bash
GITHUB_USERS=octocat,torvalds
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
GITHUB_TOKEN= # opsiyonel, rate limit için önerilir
POLL_INTERVAL_SECONDS=300
STATE_FILE=.github-stalker-state.json
NOTIFY_ON_STARTUP=false
```

Node.js `>=20.19.0` gerekir. Gerçek webhook URL'sini commit etmeyin. `.env` ve varsayılan state dosyası `.gitignore` içindedir.

## Çalıştırma

Tek seferlik smoke check:

```bash
DRY_RUN=true GITHUB_USERS=octocat pnpm run once
```

Gerçek webhook ile tek poll:

```bash
pnpm run once
```

Sürekli servis:

```bash
pnpm start
```

`pnpm run once` ve `pnpm start` çalışmadan önce TypeScript build otomatik yapılır.

JSON config ile çalıştırma:

```bash
pnpm start -- --config config.example.json
```

Environment değişkenleri JSON config değerlerini override eder.

## İlk çalıştırma davranışı

`NOTIFY_ON_STARTUP=false` varsayılandır. Bu modda ilk poll, GitHub'ın döndürdüğü mevcut aktiviteleri state'e yazar ama Discord'a göndermez; böylece eski aktiviteler spam olmaz. Sonraki poll'larda sadece yeni event ID'leri bildirilir.

`NOTIFY_ON_STARTUP=true` yaparsanız ilk poll'da GitHub public events API'nin o anda döndürdüğü desteklenen olaylar da Discord'a gönderilir.

## Rate limit ve hata davranışı

- Sadece GitHub public events API okunur.
- `GITHUB_TOKEN` opsiyoneldir ama rate limit'i artırmak için önerilir.
- GitHub rate limit hatalarında reset zamanı loglanır; olaylar seen olarak işaretlenmez.
- Discord `429` ve `5xx` cevaplarında retry yapılır.
- `DRY_RUN=true` mevcut desteklenen event'ler için payload'ları yazdırır, `NOTIFY_ON_STARTUP=true` gibi davranır ve kalıcı state dosyasına event ID kaydetmez.
- Webhook başarılı olmadan event ID state'e yazılmaz; böylece başarısız gönderimler sonraki poll'da tekrar denenir.

## Doğrulama

```bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run check
```

Testler şunları kapsar:

- GitHub event formatlama: push, repo creation, issue opened, PR opened
- Discord webhook payload formatı ve mention kapatma
- Discord 429 retry davranışı
- Duplicate notification önleme ve restart-safe state persistence
- İlk poll bootstrap davranışı
- Config parsing ve GitHub rate limit hata yüzeyi

## Sınırlamalar

GitHub public events API yalnızca public aktiviteleri ve son aktivitelerin sınırlı bir penceresini döndürür. Çok aktif kullanıcılar için `POLL_INTERVAL_SECONDS` değerini düşürün ve `MAX_EVENTS_PER_USER` değerini 100'e yaklaştırın.
