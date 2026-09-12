---
layout: default
title: Claude ile Sıfırdan Ajan Geliştirme
permalink: /building-agents/tr/
---

*[English](../)*

Claude ile sıfırdan ve herhangi bir framework kullanmadan ajan (agent) geliştirme: agentic loop, evals, tool kullanımı, context yönetimi, hafıza (memory), koruma mekanizmaları (guardrails) konularına değinirken sadece Claude API ve TypeScript kullanacağız.

Bu kursun sonunda; dosya okuyup/yazabilen ve grep yapabilen, bir onay mekanizması (approval gate) arkasında shell komutları çalıştırabilen, web'de arama yapabilen, kod çalıştırabilen ve tarayıcı gerektiren görevleri devredebilen genel amaçlı, **Wrangler** agent'ını geliştirmiş olacağız. Her modülde, aynı ajana farklı bir yetenek ekleyerek ilerleyeğiz.

Tüm kodları modüllere ayrılmış şekilde repodaki `src/` dosyasında bulabilirsiniz.

## Gereksinimler

- Node.js 20+ (örnekler Node v24 kullanılarak yazıldı)
- Anthropic API Key;  `.env` dosyasını düzenleyebilirsiniz. — Lütfen API Key'inizi commit etmeyin eğer mümkünse kısa süreli api key oluşturun. `.env.example` kopyalayıp kendi API Key'inizi girin:

  ```bash
  cd src
  cp .env.example .env
  # then edit src/.env and set ANTHROPIC_API_KEY=sk-ant-...
  ```

  `.gitignore` dosyasında .env mevcut. Yine de kontrol etmeyi unutmayın.

## Modül 0 — Kurulum ve temel yapı taşları

Ne kadar gelişmiş olursa olsun, her ajan beş temel yapı taşından oluşur:

- **Model** — akıl yürüten ve karar veren bileşen. Claude'a API üzerinden erişeceğiz.
- **Tool'lar (Araçlar)** — modelin kullanmak isteyebileceği, adı ve şeması (schema) tanımlanmış araçlar. Model hiçbir şeyi kendisi çalıştırmaz; sadece bir istek üretir, o isteği **sizin kodunuz çalıştırır**.
- **History (Geçmiş)** — her istekte yeniden gönderilen mesajlar listesi (kullanıcı, asistan, tool çağrıları, tool sonuçları). API stateless'tir. *konuşmalar*, sunucunun sizin yerinize hatırladığı bir şey değil, sizin sahip olduğunuz ve API ile Claude a iletmeniz gereken verilerdir.
- **Memory (Hafıza)** — tek bir konuşmanın ötesinde kalıcı olan bilgiler. Buraya Modül 8'de değineceğiz.
- **Orchestration (Orkestrasyon)** — döngünün kendisi: mesajları gönder, cevabı incele, istenen tool'ları çalıştır, sonuçları geri besle, devam edip etmeyeceğine karar ver. Bu döngü asıl "ajan"ın kendisidir — geri kalan her şey bu döngünün iyi şekilde çalışmasını sağlayacak yapılardır.

Bu kursta 0' dan bu yapılara değineceğiz. Böylece bir framework'ün yaptığı fakat bizim farkında olmadığımız ve ya detaylı şekilde görmediğimiz işlevsellikleri göreceğiz.

### Proje kurulumu

Repo dosyasında aşağıdaki komutları çalıştırarak paketleri yüklemeniz yeterli olacaktır:

```bash
cd src
npm i
```

Sıfırdan yeni bir proje kurmak isterseniz:

```bash
# at the root of your new project folder
npm init -y
npm install @anthropic-ai/sdk dotenv
npm install -D typescript tsx @types/node
```

- `@anthropic-ai/sdk` — resmi Anthropic TypeScript SDK'sı. Messages API'ye doğrudan bunun üzerinden erişiyoruz; ayrı bir framework kullanmıyoruz.
- `dotenv` — `ANTHROPIC_API_KEY`'i (ve ileride diğer ayarları) bir `.env` dosyasından yöneteceğiz. Böylece API Key'i terminale yazmanız ya da kaynak koda statik olarak gömmeniz gerekmez.
- `typescript` + `@types/node` — type kontrolü (type checking).
- `tsx` — `.ts` - Ayrı bir build adımına gerek kalmadan dosyaları doğrudan çalıştır. Her modül tek tek çalıştırılabilir. Kurs için bu kadarı yeterli.

ESM kullanabilmeniz için `src/package.json` içine `"type": "module"` eklemeniz yeterli.

Typescript için de ufak bir `tsconfig.json` dosyası oluşturun:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`strict` ve `noUncheckedIndexedAccess` burada önemli. Tool girdileri modelden `unknown` tipinde JSON olarak gelir, JSON'un şeklini hiç kontrol etmeden kodlamaya devam ederseniz rahatlıkla hatalar alabilirsiniz.
