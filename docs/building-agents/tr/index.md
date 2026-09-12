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

## Modül 2 — Loop, v0

Bu, en önemli modül. Buradan sonraki her şey, dosya sistemi erişimi, web'de arama, guardrails, evals, bu bölümde yazacağımız loop'a entegre edeceğiz. Loop'un genel hatları belli olup sadece erişebileceği araçlar çeşitlenecek.

### Tool Yapısı

Tool isim, açıklama ve girdisinin belirtildiği bir JSON Schema'dan oluşur. Claude hiçbir şeyi kendisi çalıştırmaz. Sadece bir tool'u çağırmak için `tool_use` content bloğu şeklinde bir *istek* üretir. Bu isteği onaylayıp onaylamayacağınıza, onaylarsanız nasıl çalıştıracağınıza kodunuz karar verir.

```typescript
const tools: Anthropic.Tool[] = [
  {
    name: "calculate",
    description:
      "Evaluate a single arithmetic operation between two numbers. Call this for any arithmetic you need an exact answer for — never compute it yourself.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide"],
          description: "The operation to perform.",
        },
        a: { type: "number", description: "The first operand." },
        b: { type: "number", description: "The second operand." },
      },
      required: ["operation", "a", "b"],
    },
  },
];
```

`description` alanı önemli. Claude, bir tool'u *çağırıp çağırmayacağına* neredeyse tamamen bu metne bakarak karar verir. Bu yüzden sadece ne yaptığını değil, *ne zaman* çağrılması gerektiğini de ("never compute it yourself") açıkça yazmakta fayda var. Belirsiz açıklamalar, modelin kullanması gereken tool'u atlamasının en yaygın sebebidir.

### Durma sinyali: `stop_reason`

Her response bir `stop_reason` taşır. Sürekli karşımıza çıkacak iki tanesi:

| `stop_reason` | Anlamı | Ne yapmalısınız |
| --- | --- | --- |
| `tool_use` | Claude en az bir `tool_use` bloğu üretir ve devam etmeden önce sonucunu ister | Tool'(lar)ı çalıştırıp, sonuçlar ile modeli geri besleyip, loop'u tekrarlamamız gerekir |
| `end_turn` | Claude işini bitirdiği sinyal. Bekleyen bir tool çağrısı yok | Son metni yazdırırız |

(`max_tokens`, `pause_turn`, `refusal` gibi başka alanalarda var. Daha uzun çalışmalara ve sunucu taraflı tool'lara geçtiğimizde önem kazanacaklar. Sırası geldikçe onlara da değineceğiz.)

### Loop

```typescript
const messages: Anthropic.MessageParam[] = [
  {
    role: "user",
    content:
      "A workshop has 14 tables. Eleven of them seat 6 people each, and the remaining 3 seat only 4 people each. How many people can the workshop seat in total?",
  },
];

while (true) {
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    tools,
    messages,
  });

  // Log the raw response so that we can see the actual shape the API returns
  // id, model, stop_reason, usage, and the content block array — not just
  // the parts we bother to summarize.
  console.log("\n=== response ===");
  console.dir(response, { depth: null });

  // Always append the FULL response.content, not just the text — the
  // tool_use blocks inside it are what let the next tool_result line up.
  messages.push({ role: "assistant", content: response.content });

  if (response.stop_reason !== "tool_use") {
    break;
  }

  const toolUseBlocks = response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );

  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of toolUseBlocks) {
    const result = await executeTool(block.name, block.input);
    toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: result,
    });
  }

  // And the other half of the round trip: exactly what we send back.
  console.log("\n=== tool_result(s) sent back ===");
  console.dir(toolResults, { depth: null });

  // All tool_result blocks go back in a single user message.
  messages.push({ role: "user", content: toolResults });
}
```

`executeTool`, dispatcher görevi görür — tool ismine göre bir `switch` yapıp ilgili fonksiyonu çağırır ve bir string döner:

```typescript
function calculate(input: { operation: string; a: number; b: number }): string {
  const { operation, a, b } = input;
  switch (operation) {
    case "add":
      return String(a + b);
    case "subtract":
      return String(a - b);
    case "multiply":
      return String(a * b);
    case "divide":
      return b === 0 ? "Error: division by zero" : String(a / b);
    default:
      return `Error: unknown operation "${operation}"`;
  }
}

async function executeTool(name: string, input: unknown): Promise<string> {
  switch (name) {
    case "calculate":
      return calculate(input as { operation: string; a: number; b: number });
    default:
      return `Error: no such tool "${name}"`;
  }
}
```

`input: unknown` kısmına dikkat etmemiz gerekir — TypeScript açısından modelin `tool_use.input`'u rastgele bir JSON'dur. Burada kısalık olsun diye direkt cast ediyoruz; Modül 3'ten itibaren, tool girdileri *hangi dosyaya dokunulacağını* seçmeye başladığında, direkt cast etmek yerine önce tipi doğrulayacağız.

Bu kodun tamamı `src/02-loop-v0/main.ts` içinde. Çalıştırmak için:

```bash
cd src
npx tsx 02-loop-v0/main.ts
```

Bilinçli olarak derli toplu bir özet yerine bütün `response` objesini (`console.dir(response, { depth: null })`) yazdırıyoruz — bu aşamada, API'nin size gerçekte ne döndürdüğünü görmek, düzgün bir log satırından çok daha değerli. İlk iterasyon, hiç düzenlenmemiş haliyle (response farklılık gösterebilir):

```
=== response ===
{
  model: 'claude-haiku-4-5-20251001',
  id: 'msg_011CexM83ma3axXbhUwASpGJ',
  type: 'message',
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: 'I need to calculate the total seating capacity of the workshop.'
    },
    {
      type: 'tool_use',
      id: 'toolu_01HvkhVJapntMq7n7bVXTiaT',
      name: 'calculate',
      input: { operation: 'multiply', a: 11, b: 6 },
      caller: { type: 'direct' }
    },
    {
      type: 'tool_use',
      id: 'toolu_017HMgBzNxFmV21Cf1pXitpU',
      name: 'calculate',
      input: { operation: 'multiply', a: 3, b: 4 },
      caller: { type: 'direct' }
    }
  ],
  container: null,
  stop_reason: 'tool_use',
  stop_sequence: null,
  stop_details: null,
  usage: {
    input_tokens: 690,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 167,
    service_tier: 'standard'
  }
}

=== tool_result(s) sent back ===
[
  { type: 'tool_result', tool_use_id: 'toolu_01HvkhVJapntMq7n7bVXTiaT', content: '66' },
  { type: 'tool_result', tool_use_id: 'toolu_017HMgBzNxFmV21Cf1pXitpU', content: '12' }
]
```

...ardından `add` işlemi için ikinci bir `response`/`tool_result` çifti, en sonda da hiç `tool_use` bloğu içermeyen, sadece kapanış metnini taşıyan, `stop_reason: 'end_turn'` olan bir `response` gelecek. Üçünü de tam haliyle görmek için çalıştırın. Buradaki metinden çok, gerçek çıktıyı bir kez baştan sona incelemenizde daha fazla yarar var.

Artık bu yapıdan doğrudan okuyabileceğimiz, bir varsayım olarak kabul etmek yerine gözlemleyebileceğimiz beş şey var:

- **`content` bir array'dir ve bir `tool_use` bloğu, bir `text` bloğunu ile birlikte.** Claude hem kendini açıkladı ("I need to calculate...") hem de aynı turda tool'u çağırdı. Text ve tool çağrıları aynı array içinde birbirinin alternatifi değiller.
- **Claude, tool'u tek bir turda iki kez çağırdı.** Her iki çarpma işlemi de tek bir response içinde iki ayrı `tool_use` bloğu olarak geldi. Bu, varsayılan olarak açık olan paralel tool kullanımıdır. İki sonuç da iki ayrı mesaj olarak değil, iki `tool_result` bloğu içeren tek bir `user` mesajı olarak geri gönderildi. Bunları ayrı mesajlara bölmek, modeli sessizce çağrıları toplu yapmayı bırakmaya "eğiten" yaygın bir hatadır.
- **Her `tool_use` bloğu kendi `id`'sini taşır ve eşleşen `tool_result`, bunu `tool_use_id` olarak geri yansıtır.** Bir sonucu, onu tetikleyen çağrıya bağlayan tek şey budur — sırada ya da konumda bağlayıcı hiçbir şey yok, bağlayan şey `id`'dir.
- **`usage`, kümülatif değil, istek başınadır** ve her turda büyür (690 → 918 → 1026 input token) çünkü *tüm* geçmiş — az önce gördüğünüz tool çağrıları ve sonuçları da dahil — her seferinde yeniden gönderilir. Bu, Modül 7'nin (context yönetimi) neden var olduğuna dair ilk somut ipucu: sınırsız bir loop, sınırsızca büyüyen bir input maliyeti demektir.
- **Loop, tek değil üç round trip çalıştı**: çarpma × 2 → toplama → son cevap. `if` değil de `while (true)` kullanmamızın sebebi de bu. Tool kullanan bir tur, konuşmanın sonu değildir; Claude'un konuşmayı bitirebilmek için bilgi istemesidir. `messages` sonunda altı öğe uzunluğuna ulaşır — sorunuz, üç asistan turu ve iki `tool_result` cevabı — ve her öğe, loop yaşadığı sürece array içinde kalıp her seferinde tam olarak yeniden gönderilir.

Bu kursun geri kalanı da aynı şekle sahip: bir `while` loop'u, bir `tools` array'i, bir dispatcher. Modül 3 de, hesap makinesinin yerine gerçek dosyalara dokunan dosya sistemi tool'larını göreceğiz ve "modelin girdisine güven" yaklaşımının artık yetmemeye başladığı yer de tam olarak burası.
