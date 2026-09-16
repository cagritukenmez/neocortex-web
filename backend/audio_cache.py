from pathlib import Path

AUDIO_CACHE_DIR = Path(__file__).resolve().parent / "audio_cache"

def get_audio_cache_path(message_id: int) -> Path:
    return AUDIO_CACHE_DIR / f"{message_id}.mp3"


def read_cached_audio(message_id: int)-> bytes | None:
    cache_path = get_audio_cache_path(message_id)
    try:
        return cache_path.read_bytes()
    except FileNotFoundError:
        return None

def save_cached_audio(message_id: int, audio: bytes):
    AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    cache_path = get_audio_cache_path(message_id)
    temp_path = cache_path.with_suffix(".tmp")

    temp_path.write_bytes(audio)
    temp_path.replace(cache_path)

def delete_cached_audio(message_ids: list[int]) -> None:
    for message_id in message_ids:
        get_audio_cache_path(message_id).unlink(missing_ok = True) 
    