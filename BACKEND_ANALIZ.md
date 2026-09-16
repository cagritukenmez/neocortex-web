# Backend Analiz Raporu — Local Knowledge Assistant

**Analiz tarihi:** 2026-09-11
**Kapsam:** `backend/` dizini (6 Python dosyası, 1030 satır) + frontend'in API tüketim sözleşmesi
**Commit:** `fc20ceb` (master)
**Yöntem:** Statik kod okuması. Uygulama çalıştırılmadı, runtime davranışı test edilmedi.

---

## 1. Yönetici Özeti (10 satır)

1. Backend, FastAPI üzerinde çalışan **tek modüllü (single-module) bir RAG servisi**; klasik katmanlı mimari yok, `main.py` hem router hem orchestrator hem prompt deposu görevi görüyor (359 satır).
2. Toplam **12 endpoint** var; hiçbirinde **kimlik doğrulama, yetkilendirme veya rate limiting yok** — `chat_id` istemciden geliyor ve doğrulanmıyor, bu da tam bir IDOR (yetkisiz veri erişimi) durumu yaratıyor.
3. LLM sağlayıcı soyutlaması **yarım**: `openai_service` ve `ollama_service` aynı fonksiyon imzasını paylaşıyor ama ortak bir arayüz/registry yok, seçim `main.py:262`'de `if/else` ile yapılıyor.
4. **Sizin hedefiniz açısından en kritik nokta:** embedding üretimi sağlayıcıdan bağımsız olarak **her zaman Ollama'ya sabitlenmiş** (`main.py:30`), yani yeni bir API entegre etseniz bile Ollama zorunluluğu devam eder.
5. `openai_service.py:19-20` **import anında** `RuntimeError` fırlatıyor; `LLM_PROVIDER=ollama` olsa bile `OPENAI_API_KEY` yoksa uygulama hiç açılmıyor.
6. Veri katmanı ham `sqlite3` + her fonksiyonda yeni connection; **ORM, migration sistemi, transaction yönetimi ve index yok**. Foreign key'ler tanımlı ama SQLite'ta `PRAGMA foreign_keys` açılmadığı için **uygulanmıyor**.
7. Belge yükleme akışı **N+1 HTTP çağrısı** üretiyor: her chunk için ayrı embedding isteği (`main.py:337-342`) ve ayrı ChromaDB `add` çağrısı (`rag.py:75-87`).
8. Dosya boyutu kontrolü **dosya tamamen belleğe okunduktan sonra** yapılıyor (`main.py:307-309`) ve diske yazılan dosyanın yolu hiçbir yerde saklanmadığı için `uploads/` klasörü **hiç temizlenmiyor**.
9. **Hiç log yok, hiç test yok** (grep ile doğrulandı); hata yönetimi servis katmanında iyi, ama `main.py` ve `database.py` katmanında tamamen yok — DB hataları 500 + stack trace olarak sızıyor.
10. `requirements.txt`'te **tek bir sürüm sabitlemesi (pin) yok**; `openai_service.py:49`'daki model adı `gpt-5.6-luna` sabit kodlanmış ve **doğrulanmalı**.

---

## 2. KEŞİF — Dizin Yapısı, Mimari ve Açılış Akışı

### 2.1 Dizin yapısı

```text
backend/
├── main.py             (359 satır)  — FastAPI app, tüm route'lar, RAG prompt'u
├── database.py         (220 satır)  — Ham sqlite3 erişim fonksiyonları
├── rag.py              (103 satır)  — ChromaDB istemcisi, chunking, retrieval
├── file_service.py      (98 satır)  — Dosya doğrulama + metin çıkarma
├── ollama_service.py   (145 satır)  — Ollama embedding + generation
├── openai_service.py    (96 satır)  — OpenAI generation
├── requirements.txt      (8 satır)
└── .env.example          (1 satır)
```

Runtime'da üretilen (gitignore'lu): `chatbot.db`, `chroma_db/`, `uploads/`, `venv/`.

### 2.2 Katmanlar

| Katman | Var mı? | Nerede |
|---|---|---|
| Router / Controller | Kısmen | `main.py:78-360` — ayrı router dosyası yok, `APIRouter` kullanılmamış |
| Service | Kısmen | `file_service.py`, `ollama_service.py`, `openai_service.py` |
| Repository / DAO | Evet (fonksiyonel) | `database.py` — sınıf yok, 9 serbest fonksiyon |
| Domain / Model | **Yok** | Sadece 4 adet request DTO'su (`main.py:57-72`); response modeli yok |
| Middleware | Sadece CORS | `main.py:48-54` |
| Config | **Yok** | `load_dotenv()` iki ayrı dosyada tekrar çağrılıyor (`main.py:42`, `openai_service.py:15`); merkezi ayar modülü yok |
| Background job / queue | **Yok** | Embedding üretimi request thread'inde senkron çalışıyor |
| Dependency Injection | **Yok** | FastAPI `Depends` hiç kullanılmamış |

### 2.3 Mimari kalıp

**Basitleştirilmiş, gevşek katmanlı (loosely layered) prosedürel bir yapı.** Hexagonal/MVC değil. Bağımlılık yönü doğru (main → service → dış dünya) ve döngüsel import yok, bu olumlu. Ancak:

- `main.py` çok fazla sorumluluk taşıyor: HTTP yönlendirme, iş akışı orkestrasyonu, **prompt mühendisliği** (`main.py:216-255`, 40 satırlık prompt string), sağlayıcı seçimi ve kaynak filtreleme.
- Servisler FastAPI'ye sızmış durumda: `file_service.py`, `ollama_service.py` ve `openai_service.py` doğrudan `HTTPException` fırlatıyor. Bu, servis katmanını HTTP'ye bağımlı kılıyor ve HTTP dışı bir bağlamda (CLI, worker, test) yeniden kullanılamaz hale getiriyor.

### 2.4 Giriş noktası ve açılış akışı

Giriş noktası: `uvicorn main:app` → [backend/main.py](backend/main.py)

Import sırasına göre modül seviyesinde çalışan yan etkiler (**tamamı uygulama açılmadan, import anında**):

```text
1. main.py:20-27  → file_service import edilir (yan etki yok)
2. main.py:28-31  → ollama_service import edilir (yan etki yok)
3. main.py:32     → openai_service import edilir
                    └─ openai_service.py:15  load_dotenv()
                    └─ openai_service.py:17  OPENAI_API_KEY okunur
                    └─ openai_service.py:19  ❗ KEY YOKSA RuntimeError → UYGULAMA AÇILMAZ
                    └─ openai_service.py:22  OpenAI client oluşturulur
4. main.py:33-39  → rag import edilir
                    └─ rag.py:10  ❗ ChromaDB PersistentClient oluşturulur (disk I/O)
                    └─ rag.py:14  ❗ "documents" collection açılır/oluşturulur
5. main.py:42     → load_dotenv() (ikinci kez)
6. main.py:44     → LLM_PROVIDER global'i okunur (varsayılan "openai")
7. main.py:46     → FastAPI() örneği
8. main.py:48-54  → CORS middleware eklenir
9. main.py:75     → ❗ init_database() çağrılır — DDL çalışır, tablolar oluşturulur
10.main.py:78+    → Route'lar kaydedilir
```

**Kritik gözlem:** `@app.on_event("startup")` veya `lifespan` kullanılmamış. Tüm başlatma işi import-time yan etkisi olarak yapılıyor. Bu, testte modülü import etmeyi imkânsıza yakın hale getiriyor ve 3. adımdaki `RuntimeError` yüzünden Ollama-only kurulumu bozuyor.

---

## 3. BAĞIMLILIKLAR VE YAPILANDIRMA

### 3.1 `requirements.txt`

```text
fastapi
uvicorn
python-multipart
python-dotenv
requests
chromadb
PyMuPDF
python-docx
openai
```

| Bulgu | Detay |
|---|---|
| **Sürüm sabitlemesi (pin) yok** | 9 paketin hiçbirinde `==` veya `>=` yok. `chromadb` ve `openai` SDK'ları geçmişte kırıcı (breaking) değişiklikler yapmış kütüphanelerdir; bugün çalışan kurulum yarın `pip install` ile bozulabilir. **Reprodüksiyon garantisi sıfır.** |
| **Lock dosyası yok** | `requirements.lock`, `poetry.lock`, `Pipfile.lock` yok. Frontend'de `package-lock.json` var — backend'de eşdeğeri eksik. |
| **Dosya sonunda newline yok** | `openai` satırı newline ile bitmiyor (kozmetik). |
| **Eksik bağımlılık yok** | Kodda import edilen tüm 3. parti paketler (`fastapi`, `dotenv`, `openai`, `requests`, `chromadb`, `fitz`/PyMuPDF, `docx`/python-docx, `pydantic`) listede karşılığını buluyor. `pydantic` FastAPI ile transitif geliyor ama açıkça listelenmesi daha doğru olur. |
| **Bakımsız paket** | Tespit edilmedi; tüm paketler aktif bakımda olan popüler kütüphaneler. Ancak sürüm sabitlenmediği için **hangi sürümün kurulu olduğu doğrulanmalı** (`pip freeze` ile). |

### 3.2 Ortam değişkenleri

`.env.example` içeriği (2 satır, CRLF satır sonlu):
```env
OPENAI_API_KEY=your_openai_api_key_here
LLM_PROVIDER=openai
```

Kodda gerçekten okunan değişkenler:

| Değişken | Okunduğu yer | `.env.example`'da var mı |
|---|---|---|
| `OPENAI_API_KEY` | `openai_service.py:17` | ✅ Evet |
| `LLM_PROVIDER` | `main.py:44` | ✅ Evet |

**Sonuç: `.env.example` kodda okunan değişkenlerle birebir uyuşuyor.** Eksik veya fazla girdi yok. Bu olumlu bir nokta.

### 3.3 Ortam değişkeni OLMASI gerekirken sabit kodlanmış değerler

Asıl sorun `.env.example`'ın eksikliği değil, **yapılandırılabilir olması gereken pek çok değerin koda gömülü olması**:

| Değer | Konum | Neden sorun |
|---|---|---|
| `http://localhost:11434` | [ollama_service.py:15](backend/ollama_service.py#L15), [ollama_service.py:85](backend/ollama_service.py#L85) | Ollama başka makinede/portta çalışamaz; iki yerde tekrarlanmış |
| `nomic-embed-text` | [ollama_service.py:17](backend/ollama_service.py#L17) | Embedding modeli değiştirilemez |
| `qwen3:4b` | [ollama_service.py:87](backend/ollama_service.py#L87) | Yerel model değiştirilemez |
| `gpt-5.6-luna` | [openai_service.py:49](backend/openai_service.py#L49) | Model değiştirilemez; **bu model adının geçerliliği doğrulanmalı** |
| `http://localhost:5173` | [main.py:50](backend/main.py#L50) | CORS origin; deploy edilemez |
| `chunk_size=500, overlap=100` | [rag.py:21-22](backend/rag.py#L21-L22) | RAG kalitesini doğrudan etkileyen parametreler koda gömülü |
| `n_results=5` | [rag.py:39](backend/rag.py#L39) | Retrieval genişliği ayarlanamaz |
| `timeout=30` / `timeout=60` | [ollama_service.py:20](backend/ollama_service.py#L20), [ollama_service.py:95](backend/ollama_service.py#L95) | Yavaş modellerde timeout ayarlanamaz |
| `MAX_FILE_SIZE = 10MB` | [file_service.py:10](backend/file_service.py#L10) | Sabit |
| `temperature: 0` | [ollama_service.py:92](backend/ollama_service.py#L92) | Sadece Ollama'da var; OpenAI tarafında hiç temperature ayarı yok — iki sağlayıcı arasında **davranış tutarsızlığı** |

> **Yeni API entegrasyonu için not:** Bu liste sizin yol haritanız. Yeni bir sağlayıcı eklerken bu değerlerin tamamının bir `config.py` modülüne taşınması, entegrasyonu tek dosyada toplamanızı sağlar.

---

## 4. API YÜZEYİ

### 4.1 Endpoint tablosu

| # | Method | Path | Auth | Handler | Girdi | Döndürdüğü |
|---|---|---|---|---|---|---|
| 1 | GET | `/` | ❌ Yok | [main.py:79](backend/main.py#L79) `home` | — | `{message}` |
| 2 | POST | `/chats` | ❌ Yok | [main.py:84](backend/main.py#L84) `create_chat` | `{chat_id, title}` | `{message, chat_id, title}` |
| 3 | GET | `/chats` | ❌ Yok | [main.py:95](backend/main.py#L95) `get_chats` | — | `{chats: [[id, title], ...]}` ⚠️ **tuple dizisi** |
| 4 | PUT | `/chats/{chat_id}` | ❌ Yok | [main.py:102](backend/main.py#L102) `update_chat_title` | `{title}` | `{message, chat_id, title}` |
| 5 | DELETE | `/chats/{chat_id}` | ❌ Yok | [main.py:113](backend/main.py#L113) `delete_chat` | — | `{message, chat_id}` |
| 6 | GET | `/chats/{chat_id}/messages` | ❌ Yok | [main.py:124](backend/main.py#L124) `get_messages` | — | `{messages: [{sender, text, sources}]}` ✅ obje |
| 7 | GET | `/chats/{chat_id}/documents` | ❌ Yok | [main.py:131](backend/main.py#L131) `get_chat_documents` | — | `{documents: [[id, filename], ...]}` ⚠️ **tuple dizisi** |
| 8 | DELETE | `/chats/{chat_id}/documents/{filename}` | ❌ Yok | [main.py:140](backend/main.py#L140) `delete_document` | — | `{message, filename}` / 404 |
| 9 | GET | `/settings/provider` | ❌ Yok | [main.py:164](backend/main.py#L164) `get_provider` | — | `{provider}` |
| 10 | PUT | `/settings/provider` | ❌ Yok | [main.py:171](backend/main.py#L171) `update_provider` | `{provider}` | `{provider}` / 400 |
| 11 | POST | `/chat` | ❌ Yok | [main.py:190](backend/main.py#L190) `chat` | `{message, chat_id}` | `{answer, sources}` |
| 12 | POST | `/upload` | ❌ Yok | [main.py:288](backend/main.py#L288) `upload_file` | multipart: `file`, `chat_id` | `{message, filename, text, chunks, chunk_count, embedding_count}` |

**12 endpoint, 0 tanesi korumalı.**

### 4.2 Tespit edilen API sorunları

**A. Versiyonlama tamamen yok.** Hiçbir path'te `/v1` yok, `APIRouter(prefix=...)` kullanılmamış. Yeni bir LLM sağlayıcısı entegre ederken response şemasını değiştirmeniz gerekirse frontend'i kırmadan geçiş yapmanın bir yolu yok.

**B. Response şeması tutarsız — tuple vs obje.** `/chats` (`main.py:98`) ve `/chats/{id}/documents` (`main.py:134`) SQLite satırlarını **ham tuple** olarak döndürüyor; `/chats/{id}/messages` ise (`database.py:161-167`) düzgün obje döndürüyor. Frontend bu tutarsızlığı pozisyonel indeksle karşılıyor:

```ts
// frontend/src/App.tsx:165  →  chat[0], chat[1]
// frontend/src/App.tsx:436  →  document[0], document[1]
```

Bu, **API sözleşmesini sütun sırasına bağlıyor.** `database.py:76`'daki `SELECT id, filename` ifadesine bir sütun eklenirse frontend sessizce bozulur. Aynı kırılganlık backend'in kendi içinde de var: `main.py:144` ve `main.py:296`'da `document[1]` sabit indeksi kullanılıyor.

**C. `response_model` hiç kullanılmamış.** Hiçbir route'ta `response_model=` yok. Bu nedenle: (1) `/docs` Swagger sayfası response şemalarını gösteremiyor, (2) çıktı doğrulaması yapılmıyor, (3) hassas alanların sızmasına karşı otomatik filtre yok.

**D. HTTP status kodları belirtilmemiş.** `POST /chats` kaynak oluşturmasına rağmen `201` değil `200` döndürüyor (`status_code=` parametresi hiçbir yerde yok).

**E. Mükerrer endpoint tespit edilmedi.** Bu konuda sorun yok — her endpoint tekil bir işi yapıyor.

**F. İsimlendirme büyük ölçüde tutarlı, iki istisna:**
- `/chat` (tekil, aksiyon) ve `/chats` (çoğul, kaynak) yan yana duruyor — REST açısından kafa karıştırıcı. `/chats/{chat_id}/messages` altında POST olması daha tutarlı olurdu.
- `/upload` kaynak-temelli değil aksiyon-temelli; `chat_id`'yi form-data içinde alıyor, oysa diğer tüm chat-kapsamlı işlemler path parametresi kullanıyor (`/chats/{chat_id}/documents` olması beklenirdi).

**G. Sunucu tarafı global durum (state) mutasyonu.** `PUT /settings/provider` (`main.py:172`) modül seviyesindeki `LLM_PROVIDER` global'ini değiştiriyor. Bu:
- **Kalıcı değil** — sunucu yeniden başlayınca `.env` değerine döner.
- **Kullanıcıya özel değil** — tek kullanıcının ayar değişikliği tüm kullanıcıları etkiler.
- **Çok işçili (multi-worker) kurulumda tutarsız** — `uvicorn --workers 4` ile her worker'ın kendi kopyası olur, istekler rastgele farklı sağlayıcıya gider.

---

## 5. VERİ KATMANI

### 5.1 Şema (SQLite — `backend/chatbot.db`)

```text
┌─────────────────────┐
│ chats               │
│─────────────────────│
│ id     TEXT PK      │◄──────┐
│ title  TEXT NOT NULL│       │ (FK tanımlı, UYGULANMIYOR)
└─────────────────────┘       │
                              │
┌────────────────────────────┐│      ┌────────────────────────────┐
│ messages                   ││      │ documents                  │
│────────────────────────────││      │────────────────────────────│
│ id       INTEGER PK AUTOINC││      │ id       INTEGER PK AUTOINC│
│ chat_id  TEXT NOT NULL ────┼┘      │ chat_id  TEXT NOT NULL ────┤
│ sender   TEXT NOT NULL     │       │ filename TEXT NOT NULL     │
│ text     TEXT NOT NULL     │       └────────────────────────────┘
│ sources  TEXT DEFAULT '[]' │
└────────────────────────────┘
```

İkinci veri deposu — **ChromaDB** (`backend/chroma_db/`, collection: `documents`, [rag.py:14](backend/rag.py#L14)):

```text
id       : uuid4 (rastgele, hiçbir yerde saklanmıyor)
document : chunk metni
embedding: nomic-embed-text vektörü
metadata : { filename, chunk_index, chat_id }
```

### 5.2 İki depo arasındaki ilişki ve tutarlılık

SQLite ve ChromaDB **iki ayrı, senkronize edilmeyen kaynak.** Aralarındaki tek bağ `chat_id` + `filename` metadata çiftidir. Aralarında referans bütünlüğü sağlayan bir mekanizma yok.

### 5.3 Migration durumu

**Resmi bir migration sistemi yok** (Alembic vb. kullanılmamış). Bunun yerine `init_database()` içinde el yapımı bir şema evrimi var:

```python
# database.py:35-41
cursor.execute("PRAGMA table_info(messages)")
columns = [column[1] for column in cursor.fetchall()]
if "sources" not in columns:
    cursor.execute("ALTER TABLE messages ADD COLUMN sources TEXT DEFAULT '[]'")
```

**Değerlendirme:** Bu idempotent kontrol mevcut haliyle **kodla uyumlu ve çalışır** — `CREATE TABLE IF NOT EXISTS` zaten `sources` sütununu içeriyor (`database.py:29`), `ALTER TABLE` sadece eski veritabanları için. Ancak bu desen ölçeklenmez: her yeni sütun için elle `PRAGMA` kontrolü eklemek gerekir, sürüm takibi yoktur, geri alma (rollback) yoktur ve sütun *silme*/*tip değiştirme* senaryolarını karşılamaz.

### 5.4 Index durumu — **eksik**

Tanımlı olan tek index, `chats.id` PRIMARY KEY'in örtük index'i. **Açıkça oluşturulmuş hiçbir index yok.**

Buna karşılık en sık çalışan sorguların tamamı `chat_id` üzerinden filtreliyor:

| Sorgu | Konum | Index var mı |
|---|---|---|
| `SELECT ... FROM messages WHERE chat_id = ?` | [database.py:142-149](backend/database.py#L142-L149) | ❌ Tam tablo taraması |
| `SELECT ... FROM documents WHERE chat_id = ?` | [database.py:75-78](backend/database.py#L75-L78) | ❌ Tam tablo taraması |
| `DELETE FROM messages WHERE chat_id = ?` | [database.py:189-192](backend/database.py#L189-L192) | ❌ Tam tablo taraması |
| `DELETE FROM documents WHERE chat_id = ? AND filename = ?` | [database.py:212-217](backend/database.py#L212-L217) | ❌ Tam tablo taraması |

`get_messages_from_db` her sohbet açılışında çağrılıyor. Mesaj tablosu büyüdükçe (tek tablo, tüm sohbetlerin mesajları) bu sorgular lineer yavaşlar.

### 5.5 Foreign key'ler uygulanmıyor — **doğrulanmış sorun**

`database.py:30` ve `database.py:49`'da `FOREIGN KEY (chat_id) REFERENCES chats(id)` tanımlı. Ancak SQLite'ta foreign key kısıtları **her bağlantıda `PRAGMA foreign_keys = ON` çalıştırılmadıkça varsayılan olarak kapalıdır.** Kodda bu pragma **hiçbir yerde çalıştırılmıyor** (9 connection açılışının hiçbirinde yok).

Somut sonuç: `POST /chat` (`main.py:194`) var olmayan bir `chat_id` ile çağrıldığında `save_message` sessizce **yetim (orphan) mesaj** yazar. Aynısı `POST /upload` → `save_document_metadata` (`main.py:351`) için de geçerli. Hiçbir endpoint sohbetin varlığını kontrol etmiyor.

### 5.6 Transaction kullanılmayan kritik yerler

**A. Belge yükleme — çok adımlı, atomik değil** ([main.py:333-351](backend/main.py#L333-L351)):

```text
1. save_uploaded_file()      → diske yaz         (geri alınmıyor)
2. generate_embedding() × N  → Ollama'ya N istek (geri alınmıyor)
3. store_document_chunks()   → ChromaDB'ye yaz   (geri alınmıyor)
4. save_document_metadata()  → SQLite'a yaz
```

Adım 4 başarısız olursa ChromaDB'de **SQLite'ta karşılığı olmayan vektörler** kalır. Bu vektörler artık hiçbir arayüzden silinemez (silme akışı `filename`'i SQLite'tan okuyor, `main.py:141`) ama retrieval'da **kullanılmaya devam eder** — yani kullanıcının listede görmediği bir belgeden cevap üretilebilir. Adım 3 başarısız olursa diskte yetim dosya kalır.

**B. Sohbet silme — iki depo, tek yönlü** ([main.py:114-115](backend/main.py#L114-L115)):

```python
delete_chat_from_db(chat_id)     # önce SQLite
delete_chat_vectors(chat_id)     # sonra ChromaDB
```

İlk çağrı başarılı, ikincisi hata verirse sohbet kaybolur ama **vektörleri ChromaDB'de kalır.** Aynı `chat_id` bir daha üretilmeyeceği için (`chat-${Date.now()}`) bu veri kalıcı çöp olur. `delete_document` (`main.py:154-155`) aynı deseni ters sırayla tekrarlıyor.

**C. `database.py`'de her fonksiyon kendi bağlantısını açıyor.** `delete_chat_from_db` (`database.py:185-205`) üç `DELETE` ifadesini tek `commit()` ile atomik yapıyor — bu **doğru**. Ancak bir çağrı zinciri boyunca transaction paylaşımı mümkün değil, çünkü connection dışarıya verilmiyor.

### 5.7 N+1 sorgu / çağrı riski — **doğrulanmış**

**A. Embedding üretimi** ([main.py:337-342](backend/main.py#L337-L342)):

```python
for chunk in chunks:
    embedding = generate_embedding(chunk, embedding_type="document")
    embeddings.append(embedding)
```

Her chunk için **ayrı bir senkron HTTP POST** (`ollama_service.py:14`). 10 MB'lık bir metin ~25.000 chunk üretir (chunk 500, step 400) → 25.000 ardışık HTTP isteği. Her biri 30 sn timeout'a sahip. Bu istek tek bir worker thread'ini bloke eder.

**B. ChromaDB yazımı** ([rag.py:75-87](backend/rag.py#L75-L87)):

```python
for index, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
    collection.add(ids=[...], documents=[chunk], embeddings=[embedding], ...)
```

ChromaDB `add()` liste kabul eder — tüm chunk'lar **tek çağrıda** yazılabilir. Mevcut kod N ayrı yazma işlemi yapıyor.

**C. `/upload` içinde `get_documents_from_db` gereğinden fazla veri çekiyor** — `main.py:292`'de yalnızca mükerrer kontrolü için tüm belge listesi alınıyor; tekil bir `EXISTS` sorgusu yeterdi. Minör.

### 5.8 Eşzamanlılık (concurrency)

Tüm endpoint'ler `def` (senkron) olarak tanımlı — sadece `/upload` `async def`. FastAPI senkron endpoint'leri bir thread pool'da çalıştırır, yani **birden fazla thread aynı SQLite dosyasına eşzamanlı yazabilir.** SQLite varsayılan journal modunda (`DELETE`) yazıcılar birbirini kilitler; `PRAGMA journal_mode=WAL` ayarlanmamış ve `timeout` parametresi verilmemiş. Yük altında `database is locked` (`sqlite3.OperationalError`) hatası **beklenebilir** — bu **runtime'da doğrulanmalı**.

---

## 6. GÜVENLİK

### 6.1 Kimlik doğrulama ve yetkilendirme — uçtan uca

**Kimlik doğrulama: YOK. Yetkilendirme: YOK. Kullanıcı kavramı: YOK.**

Bu, tahmin değil doğrulanmış bir tespittir:
- Şemada `users` tablosu yok (`database.py:9-55`).
- `Depends`, `OAuth2`, `HTTPBearer`, `APIKeyHeader` gibi hiçbir güvenlik bileşeni import edilmemiş.
- Hiçbir route dekoratöründe dependency yok.
- Tek "kimlik" benzeri şey `chat_id` — ve o da istemci tarafından üretiliyor.

**Uçtan uca akış (mevcut hâli):**

```text
Tarayıcı
   │  chat_id = `chat-${Date.now()}`   ← frontend/src/App.tsx:241 (istemci üretiyor)
   ▼
POST /chats  {chat_id, title}          ← backend hiçbir doğrulama yapmıyor
   ▼
SQLite: INSERT INTO chats              ← sahiplik bilgisi kaydedilmiyor
   ▼
GET /chats                             ← TÜM sohbetleri döndürür (main.py:96)
                                          filtre yok, sahiplik yok
```

**Sonuç — IDOR (Insecure Direct Object Reference):**

`chat_id` formatı `chat-<unix_millis>` olduğu için **tahmin edilebilir**. Kimlik doğrulaması olmadığı için herhangi biri şunları yapabilir:

| Saldırı | Endpoint | Sonuç |
|---|---|---|
| Tüm sohbetleri listele | `GET /chats` | Sistemdeki her sohbetin ID'si ve başlığı |
| Başkasının mesajlarını oku | `GET /chats/{id}/messages` | Tüm konuşma geçmişi + belge içeriğinden üretilmiş cevaplar |
| Başkasının belge listesini gör | `GET /chats/{id}/documents` | Yüklenen dosya adları |
| Başkasının sohbetini sil | `DELETE /chats/{id}` | Veri kaybı |
| Başkasının belgesini sil | `DELETE /chats/{id}/documents/{f}` | Veri kaybı |
| Başkasının belgesine soru sor | `POST /chat` | **Belge içeriğinin tamamı sızdırılabilir** |
| Herkesin sağlayıcısını değiştir | `PUT /settings/provider` | Global durum manipülasyonu |

Son satır özellikle ciddi: `POST /chat` ile başkasının `chat_id`'si verilerek, o sohbete yüklenmiş gizli belgelerin içeriği LLM aracılığıyla sorgulanabilir. RAG izolasyonu (`rag.py:44` `where={"chat_id": chat_id}`) **teknik olarak doğru çalışıyor** ama `chat_id`'nin kime ait olduğu hiç kontrol edilmediği için bir güvenlik sınırı oluşturmuyor.

Tek hafifletici faktör: CORS `http://localhost:5173`'e kısıtlı (`main.py:50`) ve sunucu `127.0.0.1:8000`'de çalışıyor. **Ancak CORS bir tarayıcı politikasıdır — `curl`, Postman veya herhangi bir HTTP istemcisi için hiçbir engel teşkil etmez.** Bu servis localhost dışına açılırsa (0.0.0.0 bind, port forward, tünel, Docker) tüm veri anında korumasız hale gelir.

### 6.2 Input validation

| Alan | Durum | Konum |
|---|---|---|
| `chat_id` | ❌ **Doğrulanmıyor** — uzunluk, format, karakter seti kontrolü yok; boş string kabul edilir | [main.py:63](backend/main.py#L63), [main.py:67](backend/main.py#L67) |
| `message` | ❌ **Uzunluk sınırı yok** — 10 MB'lık bir mesaj gönderilebilir, doğrudan embedding'e ve prompt'a girer | [main.py:62](backend/main.py#L62) |
| `title` | ❌ Uzunluk sınırı yok | [main.py:58](backend/main.py#L58) |
| `provider` | ✅ **Doğru yapılmış** — whitelist kontrolü var | [main.py:176-180](backend/main.py#L176-L180) |
| Dosya uzantısı | ✅ Whitelist (`.pdf/.docx/.txt`) | [file_service.py:66-75](backend/file_service.py#L66-L75) |
| Dosya boyutu | ⚠️ Kontrol var ama **çok geç** (aşağıda) | [file_service.py:78-83](backend/file_service.py#L78-L83) |
| Dosya içeriği | ❌ MIME/magic-byte doğrulaması yok — sadece uzantıya güveniliyor | [file_service.py:67](backend/file_service.py#L67) |
| `file.filename` | ❌ `None` olabilir (Starlette'te `Optional[str]`), `Path(None)` → `TypeError` → yakalanmamış 500 | [main.py:305](backend/main.py#L305) |

Pydantic modellerinde hiç `Field(min_length=..., max_length=...)` kullanılmamış. Dört DTO da (`main.py:57-72`) tip dışında hiçbir kısıt içermiyor.

### 6.3 SQL Injection — **risk YOK**

Tüm SQL ifadeleri **parametreli sorgu (`?` placeholder)** kullanıyor. Dokuz fonksiyonun tamamı kontrol edildi:

`database.py:63`, `76`, `92`, `104`, `127-131`, `143-150`, `177`, `190`, `195`, `200`, `213-218`

Hiçbir yerde f-string, `%` formatlama veya string birleştirme ile SQL kurulmuyor. **Bu konuda kod temiz.**

### 6.4 Hardcoded secret — **tespit edilmedi**

`OPENAI_API_KEY` ortam değişkeninden okunuyor (`openai_service.py:17`), kodda gömülü değil. `.env` `.gitignore`'da (`.gitignore:7`). `.env.example` yalnızca yer tutucu içeriyor.

⚠️ Bir uyarı: `.gitignore`'daki kural `.env` şeklinde — bu, git pattern'i her dizin seviyesinde eşleştiği için `backend/.env`'i de kapsar, dolayısıyla **doğru çalışır**. Ancak açık yazılması daha net olurdu. Ayrıca `.env` dosyasının geçmişte commit'lenmediği **`git log --all -- backend/.env` ile doğrulanmalı**.

### 6.5 Aşırı veri dönen response — **doğrulanmış sorun**

[main.py:353-360](backend/main.py#L353-L360) — `/upload` yanıtı:

```python
return {
    "message": "Dosya başarıyla yüklendi!",
    "filename": file.filename,
    "text": extracted_text,      # ❗ BELGENİN TÜM METNİ
    "chunks": chunks,            # ❗ TÜM CHUNK'LAR (metnin ~%25 fazlasıyla kopyası)
    "chunk_count": len(chunks),
    "embedding_count": len(embeddings),
}
```

10 MB'lık bir belge için bu yanıt **~22 MB JSON** üretir (metnin kendisi + overlap'li chunk kopyaları). Frontend bu alanları kullanmıyor — sadece `filename` gerekiyor. Bu hem bant genişliği israfı hem gereksiz veri ifşası (belge içeriği yanıt loglarına, proxy cache'lerine, tarayıcı geçmişine girer).

Ayrıca `GET /chats` (`main.py:96`) **sistemdeki tüm sohbetleri** filtresiz ve sayfalamasız döndürüyor.

### 6.6 Rate limiting — **tamamen yok**

`slowapi`, `fastapi-limiter` benzeri hiçbir bileşen yok; özel bir sayaç da yok. Korumasız kalan pahalı işlemler:

| Endpoint | Maliyet | Sonuç |
|---|---|---|
| `POST /chat` | Her istek → 1 embedding + 1 LLM çağrısı | **OpenAI faturası sınırsız artırılabilir** (`openai_service.py:48`) |
| `POST /upload` | Her istek → N embedding + N vektör yazma | CPU/disk tükenmesi |
| `PUT /settings/provider` | Global state | Sürekli sağlayıcı değiştirme |

`POST /chat` özellikle kritik: kimlik doğrulaması yok + rate limiting yok + arkasında ücretli bir API var. Bu üçlü, servisin localhost dışına çıktığı anda doğrudan **finansal zarar** anlamına gelir.

### 6.7 Bellek tüketimi / DoS

[main.py:307-309](backend/main.py#L307-L309):

```python
file_content = await file.read()   # ❗ TÜM DOSYA BELLEĞE
validate_file_size(file_content)   # ❗ boyut kontrolü SONRA
```

Boyut kontrolü, dosya tamamen okunduktan sonra yapılıyor. 2 GB'lık bir yükleme, reddedilmeden önce tümüyle işlenir. (Starlette `SpooledTemporaryFile` kullandığı için bir kısmı diske taşar — yine de disk tükenmesi vektörü kalır.) Doğru yaklaşım `Content-Length` başlığını önce kontrol etmek veya parça parça (streaming) okuyup sınırı aşınca kesmektir.

### 6.8 Prompt injection

Bu konuda **bilinçli bir savunma var** ve bu takdire değer — `main.py:219-223` belge içeriğindeki talimatların uygulanmamasını açıkça söylüyor, `main.py:226-228` içeriği sınırlayıcılarla (delimiter) çevreliyor.

Ancak bu savunma **yalnızca prompt tabanlıdır**, yapısal değildir:
- Belge metni, sistem talimatlarıyla aynı string içinde birleştiriliyor (`main.py:216-255`) — mesaj rolleri (`system`/`user`) ayrılmamış. `client.responses.create(input=source_prompt)` (`openai_service.py:48-51`) tek bir düz metin gönderiyor.
- Chunk metni hiç sanitize edilmiyor — bir belge `--- BELGE SONU ---` dizesini içerirse sınırlayıcıyı kırabilir (`rag.py:41-66` → `main.py:211-214`).
- `[KAYNAK: {filename}]` etiketine kullanıcı kontrolündeki dosya adı doğrudan gömülüyor (`main.py:212`). Dosya adı `a.txt]\n[KAYNAK: gizli.pdf` gibi bir şey olabilir — **kaynak atıfı sahteciliği** mümkün. Dosya adı hiçbir yerde sanitize edilmiyor.

Hafifletici: `main.py:270-274`'teki filtre, LLM'in uydurduğu kaynakları gerçekten getirilen chunk'ların dosya adlarıyla kesiştiriyor. **Bu iyi bir savunma** ve doğru yazılmış.

### 6.9 Path traversal — **risk yok, ama eksik temizlik var**

Yüklenen dosya `uuid4()` adıyla kaydediliyor (`file_service.py:93`), kullanıcı adı kullanılmıyor → diskte traversal riski yok. ✅

`DELETE /chats/{chat_id}/documents/{filename}` path'inde kullanıcı dosya adı geçiyor ama bu ad yalnızca SQL parametresi ve ChromaDB metadata filtresi olarak kullanılıyor, dosya sistemine dokunulmuyor (`main.py:154-155`) → traversal riski yok. ✅

Ancak: **diske yazılan dosyanın yolu hiçbir yerde saklanmıyor.** `save_uploaded_file` bir `Path` döndürüyor (`main.py:311`), metin çıkarımı için kullanılıyor, sonra atılıyor. `uploads/` klasörü temizlenmiyor, belge silindiğinde de dosya diskte kalıyor. Kalıcı ve sınırsız disk büyümesi. Dahası `.txt` dosyaları için diske yazılan kopya **hiç kullanılmıyor** — çıkarım `file_content`'ten yapılıyor (`main.py:319`).

### 6.10 Diğer güvenlik notları

- **HTTPS zorlaması yok**, güvenlik başlıkları (HSTS, CSP, X-Content-Type-Options) yok.
- **CORS:** `allow_credentials=True` + `allow_methods=["*"]` + `allow_headers=["*"]` (`main.py:51-53`). Origin sabit olduğu için kritik değil, ancak kimlik doğrulama eklendiğinde bu kombinasyon gözden geçirilmeli. Origin listesi ortam değişkeni olmalı.
- **Hata detayı sızıntısı:** `main.py` ve `database.py`'de hiç `try/except` yok. Bir `sqlite3.IntegrityError` (örn. `POST /chats` aynı `chat_id` ile) yakalanmaz → FastAPI 500 + (debug modunda) **tam stack trace** döndürür.

---

## 7. KALİTE VE DAYANIKLILIK

### 7.1 Hata yönetimi — **iki kutuplu**

**İyi taraf (servis katmanı):** `ollama_service.py:28-44`, `ollama_service.py:124-146` ve `openai_service.py:63-97` **örnek nitelikte** yazılmış. Hata tipleri ayrıştırılmış, her birine anlamlı HTTP kodu (401/429/502/503/504) ve Türkçe kullanıcı mesajı eşlenmiş. `ollama_service.py:103-114`'teki JSON kurtarma mantığı (yanıt içinden `{...}` bloğunu çıkarma) pratik ve yerinde.

**Kötü taraf (uygulama katmanı):** `main.py` (359 satır) ve `database.py` (220 satır) **toplam 0 adet `try/except` içeriyor.** Yakalanmayan somut senaryolar:

| Senaryo | Konum | Sonuç |
|---|---|---|
| Aynı `chat_id` ile ikinci `POST /chats` | [main.py:85](backend/main.py#L85) | `sqlite3.IntegrityError` → 500 |
| Eşzamanlı yazma → DB kilidi | tüm `database.py` | `OperationalError` → 500 |
| `file.filename` `None` | [main.py:305](backend/main.py#L305) | `TypeError` → 500 |
| ChromaDB yazma/silme hatası | [rag.py:76](backend/rag.py#L76), [rag.py:91](backend/rag.py#L91) | Yakalanmamış → 500 |
| Bozuk `sources` JSON | [database.py:159](backend/database.py#L159) | `JSONDecodeError` → 500 |
| Olmayan sohbetin başlığını güncelleme | [main.py:103](backend/main.py#L103) | **Sessizce 200 döner** — hiçbir satır etkilenmedi ama başarı bildirilir |
| Olmayan sohbeti silme | [main.py:114](backend/main.py#L114) | **Sessizce 200 döner** |

Son iki satır özellikle yanıltıcı: `cursor.rowcount` hiç kontrol edilmiyor, dolayısıyla var olmayan kaynaklar üzerinde yapılan işlemler başarılı görünüyor. 404 döndürülmesi gerekirdi. (Not: `delete_document` `main.py:148-152`'de bu kontrolü **doğru yapıyor** — tutarsızlık burada.)

Ayrıca `openai_service.py:93` ve `file_service.py:36`, `file_service.py:59`'daki çıplak `except Exception` blokları orijinal hatayı tamamen yutuyor (`raise ... from e` kullanılmamış, log da yok) — sorun teşhisi imkânsız hale geliyor.

### 7.2 Loglama — **hiç yok**

`grep -rn "logging|logger|print(" backend/` → **sıfır sonuç.**

Yalnızca Uvicorn'un varsayılan erişim logu var (method, path, status). Görünmeyen şeyler:
- Hangi belgenin ne zaman yüklendiği, kaç chunk üretildiği
- LLM çağrılarının süresi, token kullanımı, maliyeti
- Hangi chunk'ların retrieval'da seçildiği ve mesafe (distance) skorları
- Yutulmuş exception'ların gerçek nedeni
- Sağlayıcı değişiklikleri

**Yeni bir API entegre ederken bu en can yakıcı eksiklik olacak.** Entegrasyon hatalarını (yanlış model adı, bozuk JSON yanıtı, timeout) teşhis edecek hiçbir iz kalmıyor — hepsi `except Exception` içinde kaybolup genel bir 500 mesajına dönüşüyor.

### 7.3 Test kapsamı — **%0**

`find . -name "test_*" -o -name "*_test.py" -o -name "tests"` → **sıfır sonuç.**

`pytest`, `httpx`, `pytest-asyncio` bağımlılıkları da yok. CI yapılandırması yok (`.github/` dizini yok).

Testi zorlaştıran yapısal engeller (bunlar önce düzeltilmeli):
- `openai_service.py:19` import anında `RuntimeError` → modül API key olmadan import bile edilemez.
- `rag.py:10` import anında diske ChromaDB yazıyor.
- `main.py:75` import anında SQLite dosyası oluşturuyor.
- `database.py:6` DB yolu sabit — test için ayrı veritabanı verilemez.
- Dependency injection yok → LLM çağrıları mock'lanamaz.

### 7.4 Kod kalitesi — olumlu notlar

Dengeli olmak adına, kodun iyi yaptığı şeyler:

- **Tutarlı ve okunaklı biçimlendirme** — trailing comma'lar, mantıklı satır kırılmaları, düzenli import sıralaması. Kod okunması kolay.
- **SQL enjeksiyonuna karşı %100 parametreli sorgu kullanımı.**
- **Servis katmanında örnek nitelikte hata ayrıştırması.**
- **Kaynak doğrulama filtresi** (`main.py:270-274`) — LLM'in uydurduğu kaynakları eleyen bu kontrol, RAG sistemlerinde sık atlanan önemli bir doğruluk önlemidir.
- **Sohbet bazlı RAG izolasyonu** (`rag.py:44`) teknik olarak doğru uygulanmış.
- **Type hint'ler** fonksiyon parametrelerinde tutarlı şekilde kullanılmış.
- **Belge yükleme sırasında mükerrer kontrolü** (`main.py:299-303`) ve **silmede varlık kontrolü** (`main.py:148-152`) düşünülmüş.

### 7.5 En riskli 5 dosya

| # | Dosya | Satır | Risk | Neden |
|---|---|---|---|---|
| 1 | [backend/main.py](backend/main.py) | 359 | 🔴 **Çok yüksek** | Uygulamanın tek bilişsel yükü burada. 12 endpoint + iş akışı + 40 satırlık prompt (`216-255`) + sağlayıcı seçimi + global mutable state (`172`) + kaynak filtreleme. **Sıfır try/except.** En uzun fonksiyon `upload_file` (73 satır, 4 farklı alt sistemle konuşuyor, hiçbir rollback yok). Her değişiklik burayı etkiliyor; çakışma ve regresyon merkezi. |
| 2 | [backend/openai_service.py](backend/openai_service.py) | 96 | 🔴 **Yüksek** | **Import anında `RuntimeError` fırlatarak tüm uygulamayı rehin alıyor** (`19-20`) — Ollama-only kurulumu imkânsız. Model adı `gpt-5.6-luna` sabit (`49`) ve **doğrulanmalı**. JSON şema zorlaması yok, `temperature` ayarı yok — Ollama tarafında `format: "json"` + `temperature: 0` varken (`ollama_service.py:90-93`) burada yok, bu **iki sağlayıcı arasında ciddi davranış farkı** yaratıyor. Çıplak `except Exception` (`93`) tüm teşhis bilgisini yutuyor. **Yeni API entegrasyonunuzun şablonu bu dosya olacak — önce bu sorunlar düzeltilmeli.** |
| 3 | [backend/database.py](backend/database.py) | 220 | 🟠 **Yüksek** | 9 fonksiyonun her biri kendi bağlantısını açıp kapatıyor → transaction paylaşımı imkânsız, connection pool yok. **Sıfır hata yönetimi.** Index yok, `PRAGMA foreign_keys` yok, WAL modu yok, `timeout` yok. El yapımı migration (`35-41`) ölçeklenmiyor. Tuple döndürmesi (`84`, `109`) API sözleşmesini sütun sırasına bağlıyor. |
| 4 | [backend/ollama_service.py](backend/ollama_service.py) | 145 | 🟠 **Orta-Yüksek** | Tüm senkron ağ trafiği burada. URL/model/timeout sabit (`15`, `17`, `85`, `87`). `generate_embedding` fonksiyonu **sağlayıcıdan bağımsız zorunlu bağımlılık** — `main.py:30`'da doğrudan import ediliyor, yani OpenAI seçilse bile Ollama gerekli. Prompt'un yarısı bu dosyada (`49-82`), diğer yarısı `main.py`'de (`216-255`) — **prompt mantığı iki dosyaya bölünmüş.** |
| 5 | [backend/rag.py](backend/rag.py) | 103 | 🟡 **Orta** | Import anında disk I/O (`10-16`), global `collection` nesnesi. `retrieve_relevant_chunks` **mesafe (distance) eşiği uygulamıyor** (`36-66`) — `distance` hesaplanıp dict'e konuyor ama hiç kullanılmıyor; sonuç olarak alakasız chunk'lar bile her zaman prompt'a giriyor ve LLM'i yanıltabiliyor. `split_text_into_chunks` (`19-33`) **kelime/cümle sınırlarına saygı göstermeyen ham karakter dilimleme** yapıyor — chunk'lar kelime ortasından kesiliyor, bu retrieval kalitesini düşürür. `store_document_chunks` (`75-87`) N ayrı yazma yapıyor. |

---

## 8. BULGULAR — Önem Sırasına Göre

### 🔴 KRİTİK

---

**K-1 — Hiçbir endpoint'te kimlik doğrulama/yetkilendirme yok (IDOR)**
📍 [backend/main.py:78-360](backend/main.py#L78-L360) (12 endpoint'in tamamı)

Kullanıcı kavramı yok, `chat_id` istemciden geliyor ve `chat-<unix_millis>` formatıyla tahmin edilebilir. `GET /chats` (`main.py:96`) tüm sohbetleri filtresiz döndürüyor. Herhangi bir HTTP istemcisi başkasının sohbetini okuyabilir, silebilir ve `POST /chat` ile başkasının **belgelerinin içeriğini sorgulayarak sızdırabilir**. CORS koruması yalnızca tarayıcı için geçerlidir; `curl` için hiçbir engel yoktur.

**Çözüm:** Bir `users` tablosu ve oturum/JWT mekanizması ekleyin; `chats` tablosuna `owner_id` sütunu koyun. Her chat-kapsamlı endpoint'te sahiplik kontrolü yapan bir FastAPI `Depends` bağımlılığı yazın (`get_current_user` + `verify_chat_ownership`). Kısa vadede, tek kullanıcılı kalacaksa sunucunun **yalnızca `127.0.0.1`'e bind edildiğini doğrulayın** ve README'ye "bu servis çok kullanıcılı kullanıma uygun değildir" uyarısı ekleyin.

---

**K-2 — `openai_service.py` import anında çöküyor; Ollama-only kurulum imkânsız**
📍 [backend/openai_service.py:19-20](backend/openai_service.py#L19-L20) ← [backend/main.py:32](backend/main.py#L32)

```python
if not api_key:
    raise RuntimeError("OPENAI_API_KEY bulunamadı.")
```

`main.py:32` bu modülü koşulsuz import ettiği için, `LLM_PROVIDER=ollama` ayarlansa bile `OPENAI_API_KEY` olmadan uygulama **hiç başlamıyor**. README'nin vaat ettiği "tamamen yerel çalışma" senaryosu bu nedenle mevcut kodda çalışmıyor.

**Çözüm:** `RuntimeError`'ı modül seviyesinden çıkarın. İstemciyi tembel (lazy) oluşturun:
```python
_client = None
def _get_client():
    global _client
    if _client is None:
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            raise HTTPException(503, "OPENAI_API_KEY yapılandırılmamış.")
        _client = OpenAI(api_key=key)
    return _client
```
**Yeni API entegrasyonunuzda bu hatayı tekrarlamayın** — sağlayıcı modülleri import edilebilir olmalı, ama yapılandırma kontrolü ilk kullanımda yapılmalı.

---

**K-3 — Pahalı ve ücretli endpoint'lerde rate limiting yok**
📍 [backend/main.py:189](backend/main.py#L189) (`/chat`), [backend/main.py:287](backend/main.py#L287) (`/upload`)

`POST /chat` her çağrıda 1 embedding + 1 ücretli OpenAI çağrısı (`openai_service.py:48`) tetikliyor. Kimlik doğrulaması da olmadığı için servis dışarı açıldığı anda sınırsız fatura riski doğuyor. `POST /upload` ise chunk sayısı kadar HTTP isteği üretiyor.

**Çözüm:** `slowapi` ekleyin (`pip install slowapi`) ve `/chat` ile `/upload`'a IP+kullanıcı bazlı limit koyun (örn. dakikada 10 / saatte 20). Ayrıca OpenAI hesabınızda **hard spend limit** tanımlayın.

---

**K-4 — Dosya boyutu kontrolü, dosya belleğe okunduktan sonra yapılıyor**
📍 [backend/main.py:307-309](backend/main.py#L307-L309)

```python
file_content = await file.read()   # önce tümü okunur
validate_file_size(file_content)   # sonra kontrol
```

10 MB sınırı, sınırı aşan dosya tamamen işlendikten sonra uygulanıyor. Büyük yüklemeler bellek/disk tüketerek servisi durdurabilir.

**Çözüm:** Önce `Content-Length` başlığını kontrol edin; ardından dosyayı parça parça okuyup biriken boyut sınırı aştığında okumayı kesip 413 döndürün:
```python
size, parts = 0, []
while data := await file.read(1024 * 1024):
    size += len(data)
    if size > MAX_FILE_SIZE:
        raise HTTPException(413, "Dosya boyutu en fazla 10 MB olabilir.")
    parts.append(data)
```

---

### 🟠 YÜKSEK

---

**Y-1 — Çok adımlı yükleme akışında transaction/rollback yok → yetim vektörler**
📍 [backend/main.py:333-351](backend/main.py#L333-L351)

ChromaDB yazımı (`main.py:344`) başarılı olup SQLite yazımı (`main.py:351`) başarısız olursa, vektörler **arayüzden silinemez ama retrieval'da kullanılmaya devam eder**. Kullanıcı listede görmediği bir belgeden cevap alabilir.

**Çözüm:** Sırayı tersine çevirin (önce SQLite metadata, sonra vektörler) veya yükleme akışını `try/except` ile sarıp hata durumunda `delete_document_vectors(chat_id, filename)` ile telafi edici silme (compensating delete) yapın. Diske yazılan dosyayı da temizleyin.

---

**Y-2 — Foreign key'ler tanımlı ama uygulanmıyor; sohbet varlığı hiç kontrol edilmiyor**
📍 [backend/database.py:30](backend/database.py#L30), [backend/database.py:49](backend/database.py#L49), [backend/main.py:194](backend/main.py#L194), [backend/main.py:351](backend/main.py#L351)

SQLite'ta `PRAGMA foreign_keys = ON` hiçbir bağlantıda çalıştırılmıyor, dolayısıyla FK kısıtları devre dışı. `POST /chat` ve `POST /upload` var olmayan `chat_id` ile yetim kayıtlar oluşturuyor.

**Çözüm:** Her bağlantı açılışında `connection.execute("PRAGMA foreign_keys = ON")` çalıştırın (bir `get_connection()` yardımcı fonksiyonu ile merkezileştirin) ve FK'lere `ON DELETE CASCADE` ekleyin. Ayrıca `/chat` ve `/upload` başında sohbetin varlığını kontrol edip yoksa 404 döndürün.

---

**Y-3 — `chat_id` üzerinde index yok**
📍 [backend/database.py:22-33](backend/database.py#L22-L33), [backend/database.py:43-52](backend/database.py#L43-L52)

En sık çalışan dört sorgunun tamamı `WHERE chat_id = ?` kullanıyor ama hiç index yok → tam tablo taraması.

**Çözüm:** `init_database()` içine ekleyin:
```sql
CREATE INDEX IF NOT EXISTS idx_messages_chat_id  ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_documents_chat_id ON documents(chat_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_chat_file ON documents(chat_id, filename);
```
Üçüncüsü, `main.py:299-303`'teki mükerrer kontrolünü yarış koşullarına (race condition) karşı veritabanı seviyesinde de garantiler.

---

**Y-4 — N+1 çağrı: her chunk için ayrı embedding isteği ve ayrı ChromaDB yazımı**
📍 [backend/main.py:337-342](backend/main.py#L337-L342), [backend/rag.py:75-87](backend/rag.py#L75-L87)

10 MB'lık bir metin ~25.000 ardışık HTTP isteği üretir; her biri request thread'ini bloke eder.

**Çözüm:** `ollama_service`'e toplu (batch) embedding fonksiyonu ekleyin (Ollama'nın `/api/embed` endpoint'i liste kabul eder — **kurulu sürümünüz için doğrulanmalı**). `store_document_chunks`'ı tek `collection.add(ids=[...], documents=[...], embeddings=[...], metadatas=[...])` çağrısına indirin. Uzun vadede yükleme işini arka plan görevine (`BackgroundTasks` veya bir kuyruk) taşıyın.

---

**Y-5 — `main.py` ve `database.py`'de sıfır hata yönetimi**
📍 [backend/main.py:78-360](backend/main.py#L78-L360), [backend/database.py](backend/database.py)

579 satırda tek bir `try/except` yok. `IntegrityError`, `OperationalError` (DB kilidi), `TypeError` (`filename=None`), ChromaDB hataları ve `JSONDecodeError` yakalanmadan 500 + stack trace olarak dönüyor.

**Çözüm:** Bir global exception handler ekleyin (`@app.exception_handler(Exception)`) — hatayı loglayıp istemciye genel bir mesaj döndürsün. `POST /chats`'te `IntegrityError`'ı açıkça yakalayıp 409 Conflict döndürün.

---

**Y-6 — `/upload` yanıtı belgenin tüm metnini ve tüm chunk'ları döndürüyor**
📍 [backend/main.py:353-360](backend/main.py#L353-L360)

10 MB belge için ~22 MB JSON yanıt. Frontend bu alanları kullanmıyor.

**Çözüm:** `text` ve `chunks` alanlarını kaldırın; `chunk_count` ve `embedding_count` yeterli. Ardından `response_model` tanımlayarak bu tür sızıntıları yapısal olarak engelleyin.

---

**Y-7 — Yüklenen dosyalar diskte kalıcı olarak birikiyor**
📍 [backend/file_service.py:86-99](backend/file_service.py#L86-L99), [backend/main.py:311-314](backend/main.py#L311-L314)

`save_uploaded_file`'ın döndürdüğü UUID yolu hiçbir yerde saklanmıyor → dosyalar hiçbir zaman silinemiyor. Belge veya sohbet silindiğinde de dosya diskte kalıyor. `.txt` dosyalarında diske yazılan kopya **hiç kullanılmıyor bile** (çıkarım `file_content`'ten yapılıyor, `main.py:319`).

**Çözüm:** İki seçenek — (a) `documents` tablosuna `stored_path` sütunu ekleyip silme akışında dosyayı da silin, veya (b) daha basiti: metin çıkarımını tamamen bellek üzerinden yapın (PyMuPDF `fitz.open(stream=..., filetype="pdf")`, python-docx `Document(io.BytesIO(...))` kabul eder) ve **hiç diske yazmayın**. Seçenek (b) bu proje için daha uygun görünüyor.

---

**Y-8 — Sağlayıcı ayarı global mutable state; kalıcı değil ve kullanıcıya özel değil**
📍 [backend/main.py:44](backend/main.py#L44), [backend/main.py:170-186](backend/main.py#L170-L186)

`global LLM_PROVIDER` mutasyonu yeniden başlatmada sıfırlanıyor, tüm kullanıcıları etkiliyor ve çok işçili kurulumda worker'lar arası tutarsız davranıyor.

**Çözüm:** Ayarı `settings` adlı bir SQLite tablosunda saklayın (veya kullanıcı bazlı tutun). Okuma/yazmayı `database.py` üzerinden yapın. **Yeni API entegrasyonunuz için:** sağlayıcı adını `if/else` yerine bir registry sözlüğüyle çözün:
```python
PROVIDERS = {"openai": openai_generate, "ollama": ollama_generate, "yeni_api": yeni_generate}
```
Böylece `main.py:262-265` ve `main.py:176` tek noktadan yönetilir.

---

### 🟡 ORTA

---

**O-1 — `requirements.txt`'te hiç sürüm sabitlemesi yok**
📍 [backend/requirements.txt](backend/requirements.txt)

9 paketin hiçbirinde sürüm yok. `chromadb` ve `openai` SDK'ları kırıcı değişiklik geçmişine sahip.
**Çözüm:** `pip freeze > requirements.lock` ile mevcut çalışan durumu sabitleyin; `requirements.txt`'te en azından majör sürüm aralıkları belirtin (`openai>=1.0,<2.0` gibi).

---

**O-2 — İki endpoint tuple dizisi döndürüyor; API sözleşmesi sütun sırasına bağlı**
📍 [backend/main.py:98](backend/main.py#L98), [backend/main.py:134](backend/main.py#L134) ← [backend/database.py:84](backend/database.py#L84), [backend/database.py:109](backend/database.py#L109)

Frontend `chat[0]`/`chat[1]` (App.tsx:165) ve `document[0]`/`document[1]` (App.tsx:436) pozisyonel indeksleri kullanıyor. Backend'in kendisi de `document[1]` sabitine güveniyor (`main.py:144`, `main.py:296`). `SELECT`'e sütun eklenirse her şey sessizce bozulur.
**Çözüm:** `database.py`'de `connection.row_factory = sqlite3.Row` kullanıp dict döndürün; `main.py`'de Pydantic `response_model` tanımlayın. Frontend'i aynı anda güncelleyin.

---

**O-3 — Retrieval'da mesafe (distance) eşiği uygulanmıyor**
📍 [backend/rag.py:36-66](backend/rag.py#L36-L66)

`distance` değeri hesaplanıp dict'e ekleniyor (`rag.py:62`) ama **hiçbir yerde kullanılmıyor**. Sonuç: soru belgelerle tamamen alakasız olsa bile en yakın 5 chunk her zaman prompt'a giriyor. Sistem "Bu bilgi bulunamadı" demeyi yalnızca LLM'in muhakemesine bırakıyor.
**Çözüm:** `retrieve_relevant_chunks`'a bir `max_distance` eşiği ekleyip filtreleyin. Eşik değeri `nomic-embed-text` için ampirik olarak **kalibre edilmeli/doğrulanmalı** (ChromaDB varsayılan olarak L2 mesafesi kullanır).

---

**O-4 — Chunking kelime sınırlarına saygı göstermiyor**
📍 [backend/rag.py:19-33](backend/rag.py#L19-L33)

Ham karakter dilimlemesi (`text[i:i+chunk_size]`) kelimeleri ve cümleleri ortadan kesiyor. Bu, hem embedding kalitesini hem LLM'in bağlamı anlamasını düşürür.
**Çözüm:** Cümle/paragraf sınırlarına göre bölen bir yaklaşım kullanın (örn. önce `\n\n` ile böl, sonra uzun parçaları cümle bazında birleştir). Ayrıca `chunk_size`/`overlap` değerlerini yapılandırılabilir yapın.

---

**O-5 — Var olmayan kaynaklarda sessiz başarı (404 dönmüyor)**
📍 [backend/main.py:101-109](backend/main.py#L101-L109), [backend/main.py:112-120](backend/main.py#L112-L120)

`cursor.rowcount` hiç kontrol edilmediği için olmayan sohbetin başlığını güncellemek veya silmek **200 OK** döndürüyor. `delete_document` (`main.py:148-152`) bu kontrolü doğru yapıyor — tutarsızlık var.
**Çözüm:** `update_chat_title_in_db` ve `delete_chat_from_db`'nin `cursor.rowcount` döndürmesini sağlayıp 0 ise 404 fırlatın.

---

**O-6 — Girdi uzunluk sınırları yok**
📍 [backend/main.py:57-72](backend/main.py#L57-L72)

Dört Pydantic DTO'sunun hiçbirinde `Field(max_length=...)` yok. Devasa bir `message` doğrudan embedding'e ve LLM prompt'una giriyor.
**Çözüm:** `message: str = Field(min_length=1, max_length=4000)`, `title: str = Field(min_length=1, max_length=200)`, `chat_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")` gibi kısıtlar ekleyin.

---

**O-7 — İki sağlayıcı arasında çıktı-zorlama davranışı tutarsız**
📍 [backend/openai_service.py:48-51](backend/openai_service.py#L48-L51) ↔ [backend/ollama_service.py:84-96](backend/ollama_service.py#L84-L96)

Ollama tarafında `format: "json"` ve `temperature: 0` var; OpenAI tarafında ikisi de yok ve yapılandırılmış çıktı (structured output) zorlaması kullanılmıyor. Ayrıca Ollama'da JSON kurtarma mantığı var (`ollama_service.py:103-114`), OpenAI'de yok — `openai_service.py:53` doğrudan `json.loads` yapıyor, model markdown code fence eklerse 502 döner.
**Çözüm:** Ortak bir `parse_llm_json(raw)` yardımcı fonksiyonu yazıp her iki serviste kullanın. OpenAI tarafında yapılandırılmış çıktı/JSON modu kullanın. **Yeni API entegrasyonunuzda bu ortak yardımcıyı baştan kullanın.**

---

**O-8 — Prompt mantığı üç dosyaya bölünmüş**
📍 [backend/main.py:216-255](backend/main.py#L216-L255) + [backend/ollama_service.py:49-82](backend/ollama_service.py#L49-L82) + [backend/openai_service.py:27-46](backend/openai_service.py#L27-L46)

Ana RAG talimatları `main.py`'de, JSON çıktı kuralları her iki servis dosyasında ayrı ayrı (ve **farklı içerikle**) tekrarlanıyor. Bir kuralı değiştirmek üç dosyaya dokunmayı gerektiriyor ve sağlayıcılar arası davranış farkı yaratıyor.
**Çözüm:** Tüm prompt'ları tek bir `prompts.py` modülünde toplayın. **Yeni API'yi entegre ederken dördüncü bir kopya oluşturmayın.**

---

**O-9 — SQLite eşzamanlılık ayarları yapılmamış**
📍 [backend/database.py:10](backend/database.py#L10) ve diğer 8 `sqlite3.connect()` çağrısı

`journal_mode=WAL` ayarlanmamış, `timeout` parametresi verilmemiş. Senkron endpoint'ler thread pool'da çalıştığı için eşzamanlı yazmalarda `database is locked` hatası beklenebilir — **yük altında doğrulanmalı**.
**Çözüm:** Merkezi bir `get_connection()` yazın: `sqlite3.connect(DATABASE_PATH, timeout=10)` + `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON`. Dokuz tekrarlanan bağlantı kodunu da bu fonksiyonla sadeleştirin.

---

**O-10 — Kaynak etiketine sanitize edilmemiş dosya adı gömülüyor**
📍 [backend/main.py:212](backend/main.py#L212)

```python
f"[KAYNAK: {chunk['filename']}]\n{chunk['text']}"
```
Dosya adı kullanıcı kontrolünde ve hiç temizlenmiyor. `a.txt]\n[KAYNAK: gizli.pdf` gibi bir ad, prompt'taki kaynak etiketlemesini bozarak **sahte kaynak atıfı** üretebilir. Benzer şekilde belge metni `--- BELGE SONU ---` içerirse sınırlayıcı kırılabilir.
**Çözüm:** Dosya adlarını depolamadan önce sanitize edin (yeni satır ve köşeli parantezleri kaldırın, uzunluk sınırlayın). Sınırlayıcı olarak metinde geçmesi imkânsız rastgele bir token kullanın.

---

### 🟢 DÜŞÜK

---

**D-1 — `load_dotenv()` iki kez çağrılıyor**
📍 [backend/main.py:42](backend/main.py#L42), [backend/openai_service.py:15](backend/openai_service.py#L15)
Zararsız ama yapılandırma yükleme noktasının belirsizliğini gösteriyor.
**Çözüm:** Tek bir `config.py` modülü oluşturup `load_dotenv()`'i yalnızca orada çağırın; tüm ayarları oradan okuyun.

---

**D-2 — Başlatma işlemleri import yan etkisi olarak yapılıyor**
📍 [backend/main.py:75](backend/main.py#L75), [backend/rag.py:10-16](backend/rag.py#L10-L16)
`init_database()` ve ChromaDB istemcisi import anında çalışıyor. Bu, testi ve modül import'unu zorlaştırıyor.
**Çözüm:** FastAPI `lifespan` context manager'ına taşıyın.

---

**D-3 — `POST /chats` 201 yerine 200 döndürüyor**
📍 [backend/main.py:83](backend/main.py#L83)
**Çözüm:** `@app.post("/chats", status_code=201)`.

---

**D-4 — API versiyonlaması yok**
📍 [backend/main.py:78-360](backend/main.py#L78-L360)
**Çözüm:** `APIRouter(prefix="/api/v1")` kullanın. Yeni sağlayıcı entegrasyonu response şemasını değiştirecekse bu geçiş öncesi yapılmalı.

---

**D-5 — Endpoint isimlendirmesi kısmen tutarsız**
📍 [backend/main.py:189](backend/main.py#L189) (`/chat`), [backend/main.py:287](backend/main.py#L287) (`/upload`)
`/chat` ve `/chats` yan yana kafa karıştırıcı; `/upload` `chat_id`'yi path yerine form-data'da alıyor.
**Çözüm:** `POST /chats/{chat_id}/messages` ve `POST /chats/{chat_id}/documents` şeklinde kaynak-temelli hale getirin (versiyonlama ile birlikte yapılırsa kırıcı olmaz).

---

**D-6 — `.env.example` CRLF satır sonu kullanıyor ve `requirements.txt` newline ile bitmiyor**
📍 [backend/.env.example](backend/.env.example), [backend/requirements.txt](backend/requirements.txt)
Kozmetik; bazı Linux araçlarında `OPENAI_API_KEY` değerinin sonunda `\r` kalmasına yol açabilir.
**Çözüm:** `.gitattributes` ile `* text=auto eol=lf` tanımlayın.

---

**D-7 — CORS origin'i sabit kodlanmış**
📍 [backend/main.py:50](backend/main.py#L50)
**Çözüm:** `CORS_ORIGINS` ortam değişkeninden virgülle ayrılmış liste olarak okuyun.

---

**D-8 — Çıplak `except Exception` blokları orijinal hatayı yutuyor**
📍 [backend/openai_service.py:93](backend/openai_service.py#L93), [backend/file_service.py:36](backend/file_service.py#L36), [backend/file_service.py:59](backend/file_service.py#L59)
Log da olmadığı için hata nedeni tamamen kayboluyor.
**Çözüm:** En azından `logger.exception(...)` ekleyin ve `raise HTTPException(...) from exc` kullanın.

---

**D-9 — `response_model` hiçbir endpoint'te tanımlı değil**
📍 [backend/main.py:78-360](backend/main.py#L78-L360)
Swagger dokümantasyonu eksik kalıyor, çıktı doğrulaması yapılmıyor.
**Çözüm:** Her endpoint için Pydantic response modeli tanımlayın (O-2 ve Y-6 ile birlikte ele alınabilir).

---

## 9. Doğrulanması Gerekenler

Statik okumayla kesinleştiremediğim, sizin ortamınızda kontrol etmeniz gereken noktalar:

1. **`openai_service.py:49`'daki `gpt-5.6-luna` model adının geçerliliği.** Kodda hiçbir yedek (fallback) yok; geçersizse tüm OpenAI akışı `APIStatusError` → 502 ile başarısız olur. Sağlayıcı dokümantasyonundan doğrulayın.
2. **`client.responses.create()` API'sinin kurulu `openai` SDK sürümünde mevcut olup olmadığı.** Sürüm sabitlenmediği için bu **doğrulanmalı** (`pip show openai`).
3. **Kurulu paket sürümleri** — `pip freeze` çıktısı alınmalı; bilinen güvenlik açığı taraması için `pip-audit` çalıştırılmalı.
4. **`git log --all -- backend/.env`** — `.env` dosyasının geçmişte yanlışlıkla commit'lenip commit'lenmediği.
5. **SQLite kilitlenme davranışı** — eşzamanlı istek altında `database is locked` hatasının gerçekten oluşup oluşmadığı (O-9).
6. **Ollama `/api/embed` toplu endpoint'inin** kurulu Ollama sürümünde mevcut olup olmadığı (Y-4 çözümü için).
7. **Retrieval mesafe eşiği** için uygun değer — `nomic-embed-text` + ChromaDB L2 mesafesi ile ampirik kalibrasyon gerekir (O-3).

---

## 10. Yeni Bir LLM API'si Entegre Etmek İçin Yol Haritası

Devraldığınız kodda entegrasyon için dokunmanız gereken noktalar, sırayla:

| Adım | Dosya:Satır | Yapılacak |
|---|---|---|
| 1 | [openai_service.py:19-20](backend/openai_service.py#L19-L20) | **Önce K-2'yi düzeltin.** Import-time `RuntimeError` durduğu sürece sağlayıcı ekleme/çıkarma esnekliğiniz olmaz. |
| 2 | yeni `config.py` | Bölüm 3.3'teki sabit kodlanmış 10 değeri ortam değişkenlerine taşıyın. |
| 3 | yeni `prompts.py` | `main.py:216-255` + `ollama_service.py:49-82` + `openai_service.py:27-46`'daki prompt'ları birleştirin (O-8). Üç kopyayı dörde çıkarmayın. |
| 4 | yeni `llm_providers.py` | Ortak arayüzü tanımlayın: `generate_answer_with_sources(prompt) -> {"answer": str, "used_sources": list[str]}`. Ortak `parse_llm_json()` yardımcısını buraya koyun (O-7). |
| 5 | [main.py:262-265](backend/main.py#L262-L265) | `if/else`'i registry sözlüğüyle değiştirin (Y-8). |
| 6 | [main.py:176](backend/main.py#L176) | Whitelist'i registry anahtarlarından türetin: `if provider not in PROVIDERS`. |
| 7 | [main.py:30](backend/main.py#L30) | **Embedding bağımlılığına karar verin.** Şu an `generate_embedding` Ollama'ya sabit. Yeni API'nin embedding'i varsa bunu da soyutlayın — ancak **kritik uyarı:** embedding modelini değiştirirseniz ChromaDB'deki mevcut vektörler geçersiz hale gelir (farklı vektör uzayı, muhtemelen farklı boyut). Mevcut koleksiyonun yeniden indekslenmesi gerekir. |
| 8 | — | En azından `/chat` akışı için bir entegrasyon testi yazın (şu an %0 kapsam). Adım 1 bunu mümkün kılacak. |
| 9 | tüm servisler | `logging` ekleyin. Yeni API'nin hatalarını teşhis etmek için zorunlu (7.2). |

---

*Rapor sonu. Tüm bulgular kod okunarak doğrulanmıştır; belirsiz kalan noktalar Bölüm 9'da "doğrulanmalı" olarak işaretlenmiştir.*
