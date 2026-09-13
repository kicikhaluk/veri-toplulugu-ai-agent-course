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

## Modül 3 — Dosya sistemi tool'ları ve bir sandbox koruması

Modül 2'deki loop burada hiç değişmiyor. Değişen şey `tools` array'inin ve `executeTool` dispatcher'ının içeriği. İlk kez, path belirten tool girdisi, basitçe varsayılıp güvenilecek bir şey değil, önlem almamız gereken bir şey haline geliyor.

`calculate` en kötü ihtimalle yanlış bir sayı döndürürdü. Bir `read_file`/`write_file` tool'undan ise — kötü niyetli bir prompt tarafından, ya da sadece kötü bir relative path yazan bir kullanıcı tarafından — agent'ın çalışmasını amaçladığınız alanın dışındaki bir dosyaya dokunması istenebilir. Bu yüzden Modül 3, bu kurstaki her dosya sistemi tool'unun kullandığı deseni içeriyor: **her yolu bir workspace ile sınırlayın ve modelin verdiği her yolu, `fs`'e ulaşmadan önce tek bir guard fonksiyonundan geçirerek çözümleyin.**

### Sandbox kökü ve guard

```typescript
import * as path from "node:path";

// Everything the model touches is limited to this directory. No tool below
// ever uses a path the model gives us without resolving it through
// resolveSafePath() first.
const workspaceRoot = path.resolve(import.meta.dirname, "workspace");

function resolveSafePath(relativePath: string): string {
  const target = path.resolve(workspaceRoot, relativePath);
  if (target !== workspaceRoot && !target.startsWith(workspaceRoot + path.sep)) {
    throw new Error(`"${relativePath}" resolves outside the workspace root — refusing.`);
  }
  return target;
}
```

`import.meta.dirname`, `"type": "module"` bir projede sahip olmadığınız `__dirname`'in ESM karşılığıdır. Herhangi bir `fileURLToPath` boilerplate'ine gerek kalmadan mevcut dosyanın bulunduğu dizini verir.

Modelin verdiği yolu `path.resolve` ile kök dizine *göre* çözümleyip, sonra sonucun hâlâ bu dizinle başlayıp başlamadığını kontrol edeceğiz. `path.resolve("workspace", "../secrets.txt")`, `workspace`'in içinde kalmaz — `startsWith` kontrolünün yakaladığı durum tam olarak bu. Aşağıdaki dört tool'un her biri, diske dokunmadan önce `resolveSafePath`'i çağırır. Hiçbiri kendi başına path oluşturmaz.

### Tip doğrulaması

Modül 2 de, `tool_use.input`'u doğrudan beklediği şekle cast edip ileriye ertelenmiş bir problem olarak bırakmıştık. Hatalı bir kullanım yanlış bir dosyaya yazmak anlamına gelebileceğinden, o cast'in yerini gerçek bir runtime kontrolüne bırakıyoruz.

```typescript
function expectString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected "${field}" to be a string, got ${typeof value}`);
  }
  return value;
}
```

Her tool fonksiyonu, kendi alanlarını destructure edip umut etmek yerine `expectString` üzerinden (ya da başka tipler için yazacağımız benzer bir fonksiyon üzerinden) okur. Küçük bir fonksiyon ama "model hatalı bir `tool_use.input` gönderdi" hatasını hızlı şekilde fırlatıp aksiyon almamızı sağlıyor.

### Dört tool, tek dispatcher, hatalar throw edilmez — raporlanır

```typescript
const tools: Anthropic.Tool[] = [
  {
    name: "list_dir",
    description: "List the files and directories at a path inside the workspace. Use \".\" for the workspace root.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list, relative to the workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the full text contents of a file inside the workspace.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to read, relative to the workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a file inside the workspace, or overwrite it if it already exists. Creates parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to write, relative to the workspace root." },
        content: { type: "string", description: "The full contents to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace one exact occurrence of old_str with new_str in an existing file. old_str must match exactly, including whitespace, and must be unique in the file — include enough surrounding context to make it so.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to edit, relative to the workspace root." },
        old_str: { type: "string", description: "Exact text to find. Must occur exactly once in the file." },
        new_str: { type: "string", description: "Text to replace it with." },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
];
```

`edit`, bilinçli olarak Claude Code'un kendisinin kullandığı find-and-replace tool'u model alınarak tasarlandı: `old_str` tam olarak bir kez eşleşmeli. Bu şart modelin hangi eşleşmenin kastedildiğini teyit etmek için dosyanın tamamını yeniden okumasına gerek kalmadan bir edit'i güvenle uygulanabilir kılar.

Tool implementasyonları (`list_dir`, `read_file`, `write_file`, `edit`), her biri yolunu `resolveSafePath`'ten geçirir, tek bir `node:fs/promises` çağrısı yapar ve bir string döner. Gerçek bir mantığa sahip olan tek tool `edit`: `original.split(oldStr).length - 1` ile `old_str`'nin kaç kez geçtiğini sayar ve bu sayı tam olarak 1 değilse devam etmeyi reddeder.

Yeni olan şey dispatcher. Dosya sistemi çağrıları sıradan sebeplerle başarısız olur — eksik bir dosya, bir guard reddi, benzersiz olmayan bir `old_str` ve bu muhtemel hatalar loop'u çökertecek bir sebep değil, modelin üzerine aksiyon alabileceği bilgilerdir.

```typescript
async function executeTool(name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  try {
    switch (name) {
      case "list_dir":
        return { content: await listDir(input), isError: false };
      case "read_file":
        return { content: await readFileTool(input), isError: false };
      case "write_file":
        return { content: await writeFileTool(input), isError: false };
      case "edit":
        return { content: await editFile(input), isError: false };
      default:
        return { content: `Error: no such tool "${name}"`, isError: true };
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
```

Ve loop'un kendisindeki tek değişiklik — `tool_result` blokları API'de `is_error` alanı taşıyor ve bu bizim kodumuz kontrolünde olan bir değer.

```typescript
const toolResults: Anthropic.ToolResultBlockParam[] = [];
for (const block of toolUseBlocks) {
  const { content, isError } = await executeTool(block.name, block.input);
  toolResults.push({
    type: "tool_result",
    tool_use_id: block.id,
    content,
    is_error: isError,
  });
}
```

`is_error: true`, loop'u durdurmaz ya da sizin tarafınızda bir hata fırlatmaz — bu, *Claude'a* verilen bir sinyaldir: bu sonuç bir hataya sebep oldu, bu yüzden mesajı okuyup bir hata string'ini normal bir sonuç sanmak yerine ne yapacağına (başka bir yol denemek, size sormak, zarifçe pes etmek) modelin kendisi karar verebilir.

Bu kodun tamamı `src/03-filesystem/main.ts` içinde, `src/03-filesystem/workspace/` altındaki küçük bir sandbox'a karşı çalışıyor (demo için oraya bir `notes.txt` ve bir `todo.md` yerleştirilmiş durumda). Çalıştırmak için:

```bash
cd src
npx tsx 03-filesystem/main.ts
```

### Guard'ın gerçekten devreye girdiğini görmek

Demo prompt'u agent'tan workspace'i listelemesini, `notes.txt`'yi okumasını, `todo.md`'yi düzenlemesini ve ardından — "sadece ne olacağını görmek için" — workspace in bir *üstündeki* dosyada var olan `../secrets.txt`'yi okumasını ister. (var olduğu için burada bir engelleme, eksik dosya hatası değil, kanıtlanabilir şekilde guard'ın işidir).

```
=== response ===   (first turn: list_dir + read_file, run in parallel)
content: [
  { type: 'text', text: "I'll help you with that. Let me start by listing the workspace contents and reading notes.txt." },
  { type: 'tool_use', name: 'list_dir', input: { path: '.' }, ... },
  { type: 'tool_use', name: 'read_file', input: { path: 'notes.txt' }, ... }
]
stop_reason: 'tool_use'
```

...ikinci bir round doğru ekleme noktasını bulmak için `todo.md`'yi okuyor, sonra üçüncü round, tam olarak okumaya değer olan:

```
=== response ===
content: [
  { type: 'text', text: 'Perfect! Now I'll add the new line after "- Write filesystem tools" and then try to read ../secrets.txt.' },
  {
    type: 'tool_use',
    name: 'edit',
    input: {
      path: 'todo.md',
      old_str: '- Set up the loop\n- Write filesystem tools',
      new_str: '- Set up the loop\n- Write filesystem tools\n- Ship module 3'
    }
  },
  { type: 'tool_use', name: 'read_file', input: { path: '../secrets.txt' } }
]
stop_reason: 'tool_use'

=== tool_result(s) sent back ===
[
  { type: 'tool_result', tool_use_id: '...', content: 'Replaced 1 occurrence in todo.md', is_error: false },
  {
    type: 'tool_result',
    tool_use_id: '...',
    content: '"../secrets.txt" resolves outside the workspace root — refusing.',
    is_error: true
  }
]
```

Claude, edit'i ve sınır dışına çıkan okumayı tek seferde toplu olarak gönderdi. Hangisinin başarısız ve ya başarılı olacağını bilmesinin baska bir yolu yok. Guard tam olarak işini yaptı: `read_file`, o path için `fs`'e hiç dokunmadı bile, `resolveSafePath` daha önce hata fırlattı ve hata, `is_error: true` ile normal bir `tool_result` olarak geri döndü. Son turda (`stop_reason: 'end_turn'`) Claude, hiçbir şey sorulmadan bu reddi  düz bir dille raporladı. Context'inde duran başarısız bir tool çağrısı model tarafından bu şekilde ele alınır. Tam ID'leri ve sonuçların tamamını görmek için çalıştırabilirsiniz.

Bu modülden hatırlamamız gereken dört şey:

- **Guard tam olarak tek bir fonksiyonda yer alıyor.** Her tool `resolveSafePath` üzerinden geçiyor. Denetlenecek bir çok yer değil, tek bir yer var. Modül 4, gerçek komut çalıştıran bir `bash` tool'u eklediğinde, baştan yazacağımız değil, tekrar kullanacağımız desen bu olacak.
- **Reddedilen bir sonuç, loop'u çökertmenize izin verdiğiniz bir exception değildir.** Başarılı bir sonuçla aynı şekle sahip, `is_error: true` olan bir `tool_result`'tır ve modelin konuşma içinde tepki verebilmesi için geri gönderilir.
- **Runtime girdi doğrulaması artık zorunlu.** `expectString` çok basit bir fonksiyon, ama "modelden gelen rastgele JSON"un "`path.resolve`'a güvenle verebileceğiniz bir string"e dönüştüğü sınır tam olarak burası.
- **Modele `../secrets.txt`'yi denememesi söylenmesine gerek yoktu — yine de denedi, çünkü biz ona söyledik ("sadece ne olacağını görmek için").** Gerçek bir agent'ta bu merak kendini bir test olarak duyurmaz; sınırların dışına çıkan, sıradan görünen bir yol olarak karşınıza çıkar. Guard, modelin niyeti kötü ve ya iyi olsun, aynı şekilde tutmak zorundadır.

Modül 4 de, aynı guard'ı ve aynı `is_error` yapısını kullanarak ve bir agent'ı gerçek bir projede gerçekten kullanışlı hissettiren tool'ları ele alacak. Bir arama/grep tool'u ve bir allowlist arkasına gizlenmiş bir `bash` tool'u — ki paralel tool kullanımının bir merak konusu olmaktan çıkıp aktif olarak düşünmemiz gereken bir şey haline geldiği yer de tam olarak burası.
