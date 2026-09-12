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

## Modül 1 — Claude'a ilk isteğiniz

Herhangi bir loop ya da tool'dan önce tek bir istek atıp cevabı okuyalım. Kod `src/01-first-call/main.ts` dosyasında:

```typescript
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY, loaded from .env by dotenv/config

const response = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  system: "You are a terse assistant. Answer in one sentence.",
  messages: [{ role: "user", content: "What is an AI agent, in plain terms?" }],
});

for (const block of response.content) {
  if (block.type === "text") {
    console.log(block.text);
  }
}
```

Çalıştırmak için:

```bash
cd src
npx tsx 01-first-call/main.ts
```

**Neden Haiku 4.5, daha gelişmiş bir model değil?** Bu kursun her modülünde, siz denemeler yaparken birden fazla istek atacaksınız. Claude Haiku 4.5 hızlı ve ucuz, bu yüzden örnekleri maliyeti çok düşünmeden istediğiniz kadar tekrar çalıştırabilirsiniz. Muhtemelen toplamda dolar değil, birkaç kuruş harcayacaksınız. Kurduğumuz her şey model-agnostic: Wrangler bittiğinde, daha belirsiz görevlerde daha güçlü reasoning (tool seçimi, daha uzun agentic çalışmalar) istediğiniz her yerde, token başına daha yüksek maliyet karşılığında `model: "claude-haiku-4-5"` yazan yerleri `model: "claude-opus-5"` ve ya sonnet ile değiştirebilirsiniz.

Devam etmeden önce aşağıdakilere bir göz atmakta/değinmekte fayda var:

- **`response.content`, bir string değil, bloklardan oluşan bir array'dir.** Tek bir cevap; text, tool çağrıları ve thinking bloklarını bir arada barındırabilir. Bir alanı okumadan önce her zaman `block.type`'a göre fonksiyonu şekillendirmemiz gerek. Claude ister sadece mesaj iletsin, ister bir tool kullanmak istiyor olsun, aynı response şeklinin işlemesini bu parametre ile kontrol edebiliriz.
- **`messages`, bir session handle'ı değil, sizin oluşturduğunuz bir array'dir.** Ortada bir `client.startConversation()` yok. "Konuşma" dediğimiz şey sadece bu array'dir ve ikinci bir tur istiyorsanız, *siz* bu array'e ekleme yapıp her şeyi tekrar gönderirsiniz. Bu kursun geri kalanı aslında tam olarak bu detay üzerine kurulu.
- **`system`, `messages`'dan ayrıdır.** Modele verdiğiniz sabit talimattır.

Kullanıcı mesajını değiştirip tekrar çalıştırmayı deneyin — çalıştırmalar arasında hiçbir state'in taşınmadığını fark edeceksiniz. Bir sonraki modülde bu geçmişi turlar arasında kalıcı hale getirip ilk tool'u ekleyeceğiz; bu da bu tek seferlik çağrıyı bir agent loop'unun başlangıcına dönüştürecek.
