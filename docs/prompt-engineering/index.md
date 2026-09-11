---
layout: default
title: Prompt Engineering ve Teknikleri
permalink: /prompt-engineering/
---

# Prompt Engineering ve Teknikleri

**Prompt engineering**, bir yapay zeka modeline istediğimiz sonucu doğru, tutarlı ve kullanılabilir şekilde ürettirebilmek amacıyla yazdığımız etkili direktif süreci. 

Yapay zeka modelleri *non-deterministic* olduğu için aynı soruyu iki farklı şekilde sormak, birbirinden çok farklı kalitede iki cevap üretebilir.Bu bölümde iyi ve tutarlı sonuç alabilmek amacıyla bazı tekniklere değineceğiz.

## İçindekiler

1. [Standard Prompt](#standard-prompt)
2. [Zero-Shot Prompting](#zero-shot)
3. [One-Shot Prompting](#one-shot)
4. [Few-Shot Prompting](#few-shot)
5. [Structured Output](#structured-output)
6. [Chain of Thought](#chain-of-thought)
7. [Delimiters / XML Etiketleri](#delimiters-xml)
8. [Persona](#persona)
9. [Özet Karşılaştırma Tablosu](#ozet-tablo)

---

## 1. Standard Prompt (Plain Prompt) {#standard-prompt}

Hepimizin LLM'ler ile konuşurken kullandığı teknik. Standard promptlar genelde AI asistanlara verdiğimiz kısa, düz direktifler.

Diğer tüm teknikler aslında standard prompt'un eksiklerini (belirsizlik, format kararsızlığı, tutarsız kalite) gidermek için kullandığımız araçlar.

**Örnek — Product Owner:**

E-ticaret sitesindeki "sepete ürün ekleme" özelliğini ele alalım.

```
ACME e ticaret sitemiz'e sepete ürün ekleme özeliği için bir user story yaz.
```

**Format**

- Hangi kullanıcı tipi (müşteri mi, misafir kullanıcı mı)?
- Hangi formatta ("As a... I want... So that..." mı, yoksa madde madde mi)?
- Acceptance criteria isteniyor mu?
- İşletmeye muhtemel katacağı değerden bahsetmek gerekir mi?

Standart prompt hızlı bir taslak için yeterli olabilir, ama kullanılabilir, tekrarlanabilir bir sonuç için genelde yetersizdir. 

---

## 2. Zero-Shot Prompting {#zero-shot}

Zero-shot prompting aslında bizim temelimiz. Her zero-shot prompt birer standard prompt olarak söyleyebiliriz fakat her standard prompt bir zero-shot prompt değildir.

Görevin basit ve modelin zaten iyi bildiği bir konu olduğunda, modelin bir örneğe ihtiyacı olmadığında zero-shot genelde yeterlidir.

**Örnek — Business Analyst:**

```
Bir e-ticaret platformunda "iade süreci" için iş gereksinimleri (business requirements) dokümanı hazırla. Aşağıdaki bilgilere göre bir gereksinim listesi yaz:

- Müşteri, satın aldığı üründen 14 gün içinde iade talep edebilmeli.
- Ürün, orijinal ambalajında ve kullanılmamış olmalı.
- İade onaylandığında ödeme 5 iş günü içinde müşteriye geri yapılmalı.
```

---

## 3. One-Shot Prompting {#one-shot}

Modele amacı tarif ettikten sonra, tam olarak istediğimiz formatı/üslubu gösteren **tek bir örnek** vermektir. Model bu örneği referans alarak yeni bir çıktı üretir.

Format veya üslup önemli olduğunda ama tek bir örneğin yeterli olacağı, görevin çok karmaşık olmadığı durumlarda kullanılır.

**Örnek — QA Engineer/Tester:**

```
Aşağıdaki formatta bir test senaryosu yaz. Örneği inceleyip
aynı formatta, "kupon kodu ile ödeme" özelliği için yeni bir test senaryosu yaz.

Örnek:
Test ID: TC-101
Başlık: Geçersiz kredi kartı numarası ile ödeme
Ön Koşul: Kullanıcı sepete bir ürün eklemiş ve ödeme ekranındadır.
Adımlar:
  1. Geçersiz bir kredi kartı numarası gir.
  2. "Ödemeyi Tamamla" butonuna tıkla.
Beklenen Sonuç: Sistem "Geçersiz kart numarası" hata mesajı gösterir ve
ödeme işlemini gerçekleştirmez.

Yeni senaryo konusu: Süresi dolmuş bir kupon kodu ile ödeme yapılmaya çalışılması.
```
---

## 4. Few-Shot Prompting {#few-shot}

One-shot'un bir adım ötesi: modele **birden fazla (genelde 2-5) örnek** vererek hem formatı hem de örnekler arasındaki **kalıbı/mantığı** öğretmektir. Örnek sayısı arttıkça model, istenen kalıbı daha güvenilir şekilde yakalar; özellikle örnekler arasında ince farklar (ör. farklı senaryolar, edge-case) varsa few-shot, one-shot'tan daha tutarlı sonuç verir.

Amaç tek bir örnekle tam olarak tarif edilemeyecek kadar çeşitlilik içeriyorsa (farklı durumlar, farklı ton/üslup varyasyonları) few-shot tercih edilir.

**Örnek — Developer:**

Bir geliştirici, code review yorumlarını ekibin standart üslubuna uygun olarak yazdırmak istiyor:

```
Aşağıda kod review yorumu örnekleri var. Bu örneklerdeki üsluba (kibar, gerekçeli, somut öneri içeren) uygun şekilde yeni bir review yorumu yaz.

Örnek 1:
Kod: for(let i=0; i<items.length; i++) { total += items[i].price }
Yorum: Burada bir `reduce` kullanmak, kodu daha okunaklı hale getirir:
`const total = items.reduce((sum, item) => sum + item.price, 0);`
Performans farkı önemsiz, ama okunabilirlik açısından öneririm.

Örnek 2:
Kod: if(user.role == ROLE.ADMIN) { ... }
Yorum: `==` yerine `===` kullanmanı öneririm; bu, JavaScript'te tip dönüşümünden kaynaklanan beklenmedik hataları önler.

Yeni inceleme:
Kod: function getDiscount(price) { return price - (price * 0.1) }
```

İki örnek, modele hem yorumun **tonunu** hem de **yapısını** (sorunu belirt → somut kod önerisi ver → kısa gerekçe ekle) gösteriyor.

---

## 5. Structured Output {#structured-output}

Modelden serbest metin yerine **belirli bir formatta** (JSON, tablo, YAML, Markdown listesi vb.) çıktı istemektir. Bu, çıktının bir sonraki adımda otomatik olarak işlenmesi (bir sisteme aktarılması, bir dashboard'a beslenmesi) gerektiğinde kritik önem taşır.

**Örnek — Delivery Manager:**

```
Aşağıdaki sprint durum bilgilerini, bir dashboard'a aktarılacak şekilde
geçerli JSON formatında döndür.

Bilgiler:
- Sprint 14, e-ticaret "Checkout" ekibi
- Planlanan 32 story point, tamamlanan 27 story point
- 3 açık bug, 1'i kritik öncelikli (kritik bug: ödeme sayfası mobilde çöküyor)
- Sprint sonu: 2026-09-19

İstenen JSON şeması:
{
  "sprint": number,
  "team": string,
  "plannedPoints": number,
  "completedPoints": number,
  "openBugs": number,
  "criticalBugs": [string],
  "sprintEndDate": string
}
```

---

## 6. Chain of Thought {#chain-of-thought}

Modelden, doğrudan son cevabı vermek yerine **adım adım düşünerek** (lets think step by step) sonuca ulaşmasını istemektir. "Adım adım düşün", "önce seçenekleri listele, sonra karşılaştır, sonra karar ver" gibi talimatlar bu tekniğin parçasıdır.

**Örnek — Solution Architect:**

```
E-ticaret platformumuzda "stok kontrolü" servisini yeniden tasarlıyoruz.
İki seçenek arasında karar vermemiz gerekiyor:

Seçenek A: Mevcut monolitik uygulama içinde stok modülünü iyileştirmek.
Seçenek B: Stok kontrolünü ayrı bir mikroservis olarak çıkarmak.

Bağlam:
- Günlük ortalama 50.000 sipariş işleniyor, kampanya dönemlerinde bu 300.000'e çıkıyor.
- Ekip 6 kişilik, mikroservis operasyon deneyimi sınırlı.
- Stok verisi, sipariş ve ödeme servisleriyle sık sık senkronize olmak zorunda.

Adım adım düşün:
1. Önce her seçeneğin ölçeklenebilirlik açısından artı/eksilerini listele.
2. Sonra ekip yetkinliği ve operasyonel risk açısından değerlendir.
3. Sonra veri tutarlılığı (consistency) açısından değerlendir.
4. En son, bu üç değerlendirmeyi birleştirerek gerekçeli bir öneri sun.
```

Modelden doğrudan "A mı B mi?" diye sorulsaydı, yüzeysel ve tek boyutlu bir cevap almak yerine adım adım düşünmesini istemek, modelin her bir kriteri ayrı ayrı değerlendirmesini ve daha dengeli, gerekçeli bir sonuca ulaşmasını sağlar. Ayrıca çıktıdaki düşünme adımları, kararı gözden geçirmemizi kolaylaştırabilir.

---

## 7. Delimiters / XML Etiketleri {#delimiters-xml}

Uzun veya çok parçalı bir prompt'ta, farklı bölümleri (bağlam, talimat, veri, örnek) birbirinden ayırmak için `"""`, `---` gibi ayraçlar ya da `<context>...</context>`, `<data>...</data>` gibi XML benzeri etiketler kullanmaktır. Bu, modelin "bu kısım bir talimat mı, yoksa işlenecek veri mi?" karışıklığını yaşamasını engeller.

Prompt içinde birden fazla bilgi bloğu varsa (örneğin hem talimat hem de üzerinde çalışılacak ham metin) delimiter/XML kullanmak, özellikle uzun promptlarda karışıklığı büyük ölçüde azaltır. Claude, XML etiketlerini özellikle iyi ayırt eder ve bu yüzden bu teknik Claude ile çalışırken sık önerilir.

**Örnek — Product Owner:**

```
Aşağıda <feedback> etiketi içinde ham bir müşteri geri bildirimi,
<constraints> etiketi içinde ise ürün kısıtlarımız var.

<feedback>
"Sepetime ürün ekledikten sonra sayfayı yenilediğimde sepetim boşalıyor.
Özellikle mobilde alışveriş yaparken bu çok can sıkıcı, tekrar tekrar
ürün eklemek zorunda kalıyorum."
</feedback>

<constraints>
- Sepet verisi şu an sadece tarayıcı hafızasında (local storage) tutuluyor.
- Giriş yapmamış (misafir) kullanıcılar için de sepet kalıcı olmalı.
- Çözüm 1 sprint içinde tamamlanabilir olmalı.
</constraints>

Yukarıdaki <feedback> ve <constraints> bilgilerini kullanarak, geliştirme
ekibi için "As a... I want... So that..." formatında bir user story ve
3 maddelik bir acceptance criteria listesi yaz.
```

`<feedback>` ve `<constraints>` etiketleri, modelin hangi metnin "işlenecek ham veri", hangisinin "uyulması gereken kısıt" olduğunu net şekilde ayırt etmesini sağlar.

---

## 8. Persona {#persona}

Modele, cevabı üretirken **belirli bir uzmanlık kimliğine bürünmesini** söylemektir ("Sen kıdemli bir güvenlik mühendisisin..."). Bu, modelin cevaplarındaki **bakış açısını, önceliklendirmesini ve kullandığı terminolojiyi** o rolün uzmanlık alanına yönlendirir.

Persona atamak modele gerçek dışı bir yetenek kazandırmaz; model zaten sahip olduğu bilgiyi, istenen rolün bakış açısıyla süzerek sunar. Yani persona, modelin "neye odaklanacağını" ve "hangi tonla konuşacağını" belirler — sihirli bir uzmanlık kaynağı değildir.

Belirli bir uzmanlık perspektifinden değerlendirme, risk analizi veya geri bildirim istendiğinde; ya da çıktının belirli bir hedef kitleye (örneğin yöneticilere) uygun tonda olması gerektiğinde kullanılır.

**Örnek**

```
Sen, e-ticaret ödeme sistemlerinde uzmanlaşmış, kıdemli bir güvenlik test
mühendisisin. Güvenlik açıklarını (özellikle OWASP Top 10) tespit etme
konusunda derin deneyimin var.

Aşağıda açıklanan "kupon kodu doğrulama" akışını bu uzmanlık gözüyle incele ve olası güvenlik risklerini, her biri için kısa bir açıklama ve önerilen önlemle birlikte listele:

"Kullanıcı ödeme ekranında bir kupon kodu giriyor. Sistem, kodu doğrudan
veritabanında arıyor ve kod bulunursa indirim uygulanıyor. Aynı kullanıcı
istediği kadar deneme yapabiliyor, herhangi bir deneme limiti yok."
```

---

## 9. Özet Karşılaştırma Tablosu {#ozet-tablo}

| Teknik | Ne zaman kullanılır? | Ana fayda |
|---|---|---|
| Standart Prompt | Hızlı, tek seferlik, taslak nitelikli işler | Hız |
| Zero-Shot | Görev basit, model konuyu zaten biliyor | Az efor, net talimatla yeterli |
| One-Shot | Belirli bir format/üslup taklit edilecek | Format tutarlılığı |
| Few-Shot | Format + karmaşık kalıp/çeşitlilik öğretilecek | Yüksek tutarlılık |
| Structured Output | Çıktı bir sistem/kod tarafından işlenecek | Otomatik işlenebilirlik |
| Chain of Thought | Çok adımlı karar veya karmaşık problem çözme | Daha isabetli, gerekçeli sonuç |
| Delimiters / XML | Prompt içinde birden fazla bilgi bloğu var | Karışıklığı önler, netlik |
| Persona | Belirli bir uzmanlık bakış açısı gerekiyor | Odaklı, hedef kitleye uygun ton |

> **Not:** Bu teknikler birbirinin alternatifi değil, çoğu zaman **birlikte** kullanılır. Örneğin gerçek dünyada sık görülen bir prompt; bir **persona** atar, **XML etiketleriyle** bağlamı ayırır, **few-shot** örnekler verir, modelden **chain of thought** ile düşünmesini ister ve sonunda **structured output** formatında bir cevap talep eder.
