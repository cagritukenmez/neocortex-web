import os

import requests
from fastapi import HTTPException

DEFAULT_CHAT_API_URL = "https://api.neocortex.link/v3/chat"
DEFAULT_AUDIO_API_URL = "https://api.neocortex.link/v3/audio/generate"
DEFAULT_TRANSCRIBE_API_URL = "https://api.neocortex.link/v3/audio/transcribe"
SOUND_FORMAT = "mp3"
DEFAULT_TIMEOUT = 30
EMPTY_REPLY_TEXT = "Agent bu mesaja bir cevap üretmedi."

# Neocortex'in tüm duygu değerleri. Kaynak: resmi Unity SDK
# Runtime/Data/Enums/Emotions.cs (API bu değerleri büyük harfle döndürür).
EMOTION_EMOJIS = {
    "NEUTRAL": "😐",
    "HAPPY": "😄",
    "PLEASED": "😊",
    "DISAPPOINTED": "😞",
    "UPSET": "😣",
    "AMAZED": "😲",
    "CURIOUS": "🤔",
    "CONFUSED": "😕",
    "ALARMED": "😧",
    "FASCINATED": "🤩",
    "IMPRESSED": "😮",
    "ANNOYED": "😒",
    "ANGRY": "😠",
    "CONFIDENT": "😎",
    "REASSURED": "😌",
    "CONCERNED": "😟",
    "SCARED": "😨",
}

# Neocortex hata kodu -> (bizim döndüreceğimiz kod, kullanıcı mesajı)
ERROR_RESPONSES = {
    400: (402, "Neocortex kredisi tükendi."),
    401: (502, "Neocortex API anahtarı geçersiz."),
    403: (502, "Karakter bu hesaba ait değil veya mevcut plan bu isteğe izin vermiyor."),
    422: (502, "Neocortex isteği geçersiz buldu."),
    429: (429, "Neocortex günlük kullanım limiti aşıldı. Lütfen daha sonra tekrar deneyin."),
}


def get_neocortex_config() -> dict:
    # Ayarlar import anında değil, çağrı anında okunur; böylece Neocortex
    # yapılandırılmamış olsa bile uygulamanın geri kalanı çalışmaya devam eder.
    api_key = os.getenv("NEOCORTEX_API_KEY")
    character_id = os.getenv("NEOCORTEX_CHARACTER_ID")

    if not api_key or not character_id:
        raise HTTPException(
            status_code=503,
            detail="Neocortex yapılandırılmamış. NEOCORTEX_API_KEY ve NEOCORTEX_CHARACTER_ID tanımlanmalıdır.",
        )

    return {
        "api_key": api_key,
        "audio_api_url": DEFAULT_AUDIO_API_URL,
        "chat_api_url": DEFAULT_CHAT_API_URL,
        "transcribe_api_url": os.getenv(
            "NEOCORTEX_TRANSCRIBE_API_URL", DEFAULT_TRANSCRIBE_API_URL
        ),
        "character_id": character_id,
        "timeout": float(os.getenv("NEOCORTEX_TIMEOUT", DEFAULT_TIMEOUT)),
    }

def post_to_neocortex(url,api_key,payload,timeout,error_overrides = None, files=None):

    try:
        if files:
            # Dosya gönderilirken istek JSON değil, çoklu parça (multipart) olur;
            # payload bu durumda metin alanlarını taşır.
            response = requests.post(
                url,
                headers={"x-api-key": api_key},
                data=payload,
                files=files,
                timeout=timeout,
            )
        else:
            response= requests.post(
                url,
                headers={"x-api-key": api_key},
                json=payload,
                timeout=timeout,
            )
    except requests.exceptions.ConnectionError:
        raise HTTPException(
            status_code=503,
            detail="Neocortex servisine bağlanılamadı."
        )
    except requests.exceptions.Timeout:
        raise HTTPException(
            status_code=504,
            detail = "Yanıt zaman aşımına uğradı."
        )

    except requests.exceptions.RequestException:
        raise HTTPException(
            status_code=502,
            detail="İstek gönderilirken bir hata oluştu."
        )
    if not response.ok:
        if error_overrides is None:
            error_overrides={}
        error_table = ERROR_RESPONSES | error_overrides
        status_code,detail = error_table.get(
            response.status_code,
            (502, "Neocortex isteği başarısız oldu."),
        )
        raise HTTPException(
            status_code = status_code,
            detail=detail
        )
    return response



def send_agent_message(message: str, session_id=None) -> dict:
    config = get_neocortex_config()
    payload = {
        "characterIds": [config["character_id"]],
        "message": message,
    }

    # Saklı session sessizce silinmez; agent'ın konuşma hafızası
    # kullanıcı fark etmeden kaybolmasın diye açık hata döndürülür.
    if session_id:
        payload["sessionId"] = session_id
        error_overrides = {404:(404, "Agent oturumu veya karakteri bulunamadı. Oturumun süresi dolmuş olabilir.")}
    else:
        error_overrides = {404:(502,"Neocortex karakteri bulunamadı. NEOCORTEX_CHARACTER_ID değerini kontrol edin.")}

    response = post_to_neocortex(url=config["chat_api_url"],api_key=config["api_key"],payload=payload
                                 ,timeout=config["timeout"],error_overrides=error_overrides)

    try:
        data = response.json()

    except ValueError:
        raise HTTPException(
            status_code=502,
            detail="Neocortex cevabı beklenen JSON formatında dönmedi.",
        )

    return parse_agent_response(data, session_id)

def generate_agent_audio(text: str, emotion:str | None = None) -> bytes:
    config = get_neocortex_config()

    payload = {
        "characterId":config["character_id"],
        "message":text,
        "format":SOUND_FORMAT
    }
    if emotion:
        payload["emotion"]=emotion

    error_overrides = {
        403:(502, "Karakterin ses ayarı bulunamadı."),
        404:(502, "Karakterin ses ayarı bulunamadı."),
    }

    response = post_to_neocortex(url=config["audio_api_url"],api_key=config["api_key"]
                                 ,payload=payload,timeout=config["timeout"],error_overrides=error_overrides)

    if not response.content:
        raise HTTPException(
            status_code=502,
            detail="Neocortex boş ses döndürdü.",
        )
    return response.content


def transcribe_agent_audio(audio: bytes) -> str:
    """Mikrofon kaydını Neocortex'e gönderip yazıya çevirir.

    Ses wav olarak gönderilir: resmi SDK'nın kullandığı ve denemeyle
    doğruladığımız format. Çeviri dili karakterin Language ayarından gelir.
    """
    config = get_neocortex_config()

    # Dosya gönderildiği için istek JSON değil, çoklu parça olur.
    payload = {"characterId": config["character_id"]}
    files = {"audio": ("audio.wav", audio, "audio/wav")}

    error_overrides = {
        403: (502, "Karakterin ses tanıma ayarı bulunamadı."),
        404: (502, "Karakterin ses tanıma ayarı bulunamadı."),
    }

    response = post_to_neocortex(
        url=config["transcribe_api_url"],
        api_key=config["api_key"],
        payload=payload,
        timeout=config["timeout"],
        error_overrides=error_overrides,
        files=files,
    )

    try:
        data = response.json()

    except ValueError:
        raise HTTPException(
            status_code=502,
            detail="Neocortex cevabı beklenen JSON formatında dönmedi.",
        )

    return (data.get("response") or "").strip()


def parse_agent_response(data: dict, session_id=None) -> dict:
    lines = []
    actions = []
    character_name = None

    for message in data.get("messages") or []:
        character_name = character_name or message.get("name")

        for line in message.get("lines") or []:
            text = (line.get("text") or "").strip()

            if text:
                lines.append(
                    {
                        "text": text,
                        "emotion": line.get("emotion"),
                    }
                )

        actions.extend(message.get("actions") or [])

    answer = " ".join(line["text"] for line in lines)

    # Görünümde yalnızca son duygu gösterilir: duygusu olan son satırınki.
    emotion = next(
        (line["emotion"] for line in reversed(lines) if line["emotion"]),
        None,
    )

    return {
        # Neocortex yeni bir sessionId döndürmezse mevcut oturum korunur.
        "session_id": data.get("sessionId") or session_id,
        "answer": answer or EMPTY_REPLY_TEXT,
        "character_name": character_name,
        "emotion": emotion,
        "emoji": emotion_to_emoji(emotion),
        "lines": lines,
        "actions": actions,
    }


def emotion_to_emoji(emotion):
    # Duygu yoksa veya listede olmayan bir değer gelirse emoji gösterilmez.
    if not emotion:
        return None

    return EMOTION_EMOJIS.get(emotion.upper())
