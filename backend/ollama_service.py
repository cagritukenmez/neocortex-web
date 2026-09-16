import json

import requests
from fastapi import HTTPException


def generate_embedding(text: str, embedding_type: str = "document"):
    try:
        if embedding_type == "query":
            text = f"search_query: {text}"
        else:
            text = f"search_document: {text}"

        response = requests.post(
            "http://localhost:11434/api/embeddings",
            json={
                "model": "nomic-embed-text",
                "prompt": text,
            },
            timeout=30,
        )

        response.raise_for_status()
        data = response.json()

        return data["embedding"]

    except requests.exceptions.ConnectionError:
        raise HTTPException(
            status_code=503,
            detail="Ollama çalışmıyor. Lütfen Ollama servisini başlatın.",
        )

    except requests.exceptions.Timeout:
        raise HTTPException(
            status_code=504,
            detail="Embedding işlemi zaman aşımına uğradı.",
        )

    except requests.exceptions.RequestException:
        raise HTTPException(
            status_code=500,
            detail="Embedding oluşturulurken bir hata oluştu.",
        )


def generate_answer_with_sources(prompt: str) -> dict:
    try:
        source_prompt = f"""
{prompt}

OLLAMA İÇİN ZORUNLU ÇIKTI KURALLARI:

Cevabı SADECE geçerli JSON formatında döndür.

Format tam olarak şöyle olmalıdır:

{{
    "answer": "Kullanıcıya verilecek cevap",
    "used_sources": ["gerçekten kullanılan dosya adı"]
}}

ÇOK ÖNEMLİ KURALLAR:

1. Yalnızca BELGE İÇERİĞİ bölümündeki bilgileri kullan.
2. Kendi genel bilgini ASLA kullanma.
3. Bir bilgiyi önceden biliyor olsan bile belgede açıkça yazmıyorsa kullanma.
4. Tahmin, çıkarım veya dış bilgi ekleme.
5. Cevabın tamamı verilen belge parçaları tarafından desteklenmelidir.
6. Cevabı destekleyen hiçbir belge parçası yoksa:
   "answer": "Bu bilgi yüklenen belgelerde bulunamadı."
   döndür.
7. Böyle bir durumda "used_sources": [] olmalıdır.
8. used_sources alanına yalnızca cevabı gerçekten destekleyen dosyaları ekle.
9. Sadece BELGE İÇERİĞİNDE [KAYNAK: dosya_adı] şeklinde verilen dosya adlarını kullan.
10. Retrieval sonucunda bir dosyanın bulunması, o dosyanın cevap için kaynak olduğu anlamına gelmez.
11. Soru birden fazla bilgi istiyorsa her alt soruyu ayrı değerlendir.
12. Belgede bulunan kısmı cevapla; bulunmayan kısmı
    "Bu bilgi yüklenen belgelerde bulunamadı."
    şeklinde belirt.
13. JSON dışında hiçbir açıklama, markdown veya ek metin yazma.
"""

        response = requests.post(
            "http://localhost:11434/api/generate",
            json={
                "model": "qwen3:4b",
                "prompt": source_prompt,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0,
                },
            },
            timeout=60,
        )

        response.raise_for_status()
        data = response.json()

        raw_response = data["response"].strip()
        
        try:
            result = json.loads(raw_response)

        except json.JSONDecodeError:
            start = raw_response.find("{")
            end = raw_response.rfind("}")

            if start != -1 and end != -1 and end > start:
                json_text = raw_response[start:end + 1]
                result = json.loads(json_text)
            else:
                raise

        return {
            "answer": result.get(
                "answer",
                "Bu bilgi yüklenen belgelerde bulunamadı.",
            ),
            "used_sources": result.get("used_sources", []),
        }

    except json.JSONDecodeError:
        raise HTTPException(
            status_code=500,
            detail="Ollama cevabı beklenen JSON formatında döndürmedi.",
        )

    except requests.exceptions.ConnectionError:
        raise HTTPException(
            status_code=503,
            detail="Ollama çalışmıyor. Lütfen Ollama servisini başlatın.",
        )

    except requests.exceptions.Timeout:
        raise HTTPException(
            status_code=504,
            detail="Model yanıtı zaman aşımına uğradı.",
        )

    except requests.exceptions.RequestException:
        raise HTTPException(
            status_code=500,
            detail="Model yanıtı oluşturulurken bir hata oluştu.",
        )