import json
import os

from dotenv import load_dotenv
from fastapi import HTTPException
from openai import (
    APIConnectionError,
    APIStatusError,
    AuthenticationError,
    OpenAI,
    RateLimitError,
)


load_dotenv()

api_key = os.getenv("OPENAI_API_KEY")

if not api_key:
    raise RuntimeError("OPENAI_API_KEY bulunamadı.")

client = OpenAI(api_key=api_key)


def generate_answer_with_sources(prompt: str) -> dict:
    try:
        source_prompt = f"""
{prompt}

Ek çıktı kuralı:

Cevabı SADECE geçerli JSON formatında döndür.

Format tam olarak şöyle olmalıdır:

{{
    "answer": "Kullanıcıya verilecek cevap",
    "used_sources": ["cevap oluşturulurken gerçekten kullanılan dosya adı"]
}}

Kurallar:
1. used_sources alanına yalnızca cevabı oluştururken gerçekten bilgi aldığın dosyaları ekle.
2. Belgede cevabı olmayan bir soruysa used_sources boş liste olmalıdır.
3. Kaynak olarak yalnızca sana verilen belge içeriklerinde bulunan dosya adlarını kullan.
4. JSON dışında hiçbir açıklama yazma.
"""

        response = client.responses.create(
            model="gpt-5.6-luna",
            input=source_prompt,
        )

        result = json.loads(response.output_text)

        return {
            "answer": result.get(
                "answer",
                "Bu bilgi yüklenen belgelerde bulunamadı.",
            ),
            "used_sources": result.get("used_sources", []),
        }

    except json.JSONDecodeError:
        raise HTTPException(
            status_code=502,
            detail="OpenAI cevabı beklenen JSON formatında döndürmedi.",
        )

    except AuthenticationError:
        raise HTTPException(
            status_code=401,
            detail="OpenAI API anahtarı geçersiz veya yetkisiz.",
        )

    except RateLimitError:
        raise HTTPException(
            status_code=429,
            detail="OpenAI API kullanım limiti aşıldı. Lütfen daha sonra tekrar deneyin.",
        )

    except APIConnectionError:
        raise HTTPException(
            status_code=503,
            detail="OpenAI servisine bağlanılamadı.",
        )

    except APIStatusError:
        raise HTTPException(
            status_code=502,
            detail="OpenAI API isteği başarısız oldu.",
        )

    except Exception:
        raise HTTPException(
            status_code=500,
            detail="OpenAI ile cevap oluşturulurken beklenmeyen bir hata oluştu.",
        )