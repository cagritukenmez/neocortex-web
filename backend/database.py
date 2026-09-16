import json
import sqlite3
import time
from pathlib import Path


DATABASE_PATH = Path(__file__).resolve().parent / "chatbot.db"


def current_timestamp_ms() -> int:
    return time.time_ns() // 1_000_000


def init_database():
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            sender TEXT NOT NULL,
            text TEXT NOT NULL,
            sources TEXT DEFAULT '[]',
            FOREIGN KEY (chat_id) REFERENCES chats(id)
        )
        """
    )

    cursor.execute("PRAGMA table_info(messages)")
    columns = [column[1] for column in cursor.fetchall()]

    if "sources" not in columns:
        cursor.execute(
            "ALTER TABLE messages ADD COLUMN sources TEXT DEFAULT '[]'"
        )

    # Agent mesajlarının son duygusu; RAG ve kullanıcı mesajlarında NULL kalır.
    if "emotion" not in columns:
        cursor.execute(
            "ALTER TABLE messages ADD COLUMN emotion TEXT"
        )

    cursor.execute("PRAGMA table_info(chats)")
    chat_columns = [column[1] for column in cursor.fetchall()]

    if "agent_session_id" not in chat_columns:
        cursor.execute(
            "ALTER TABLE chats ADD COLUMN agent_session_id TEXT"
        )

    # Sohbet türü: "knowledge" (belge tabanlı RAG), "agent" (Neocortex, yazılı)
    # veya "voice" (Neocortex, sesli arayüz).
    if "chat_type" not in chat_columns:
        cursor.execute(
            "ALTER TABLE chats ADD COLUMN chat_type TEXT NOT NULL DEFAULT 'knowledge'"
        )

        # Bu sütundan önce agent ile konuşulmuş sohbetler agent listesine taşınır.
        cursor.execute(
            "UPDATE chats SET chat_type = 'agent' WHERE agent_session_id IS NOT NULL"
        )

    # Son aktivite zamanı (unix ms); sohbet listesi buna göre sıralanır.
    # Bu sütundan önce oluşturulmuş sohbetlerde NULL kalır.
    if "last_activity_at" not in chat_columns:
        cursor.execute(
            "ALTER TABLE chats ADD COLUMN last_activity_at INTEGER"
        )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            FOREIGN KEY (chat_id) REFERENCES chats(id)
        )
        """
    )

    connection.commit()
    connection.close()


def save_document_metadata(chat_id: str, filename: str):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        "INSERT INTO documents (chat_id, filename) VALUES (?, ?)",
        (chat_id, filename),
    )

    connection.commit()
    connection.close()


def get_documents_from_db(chat_id: str):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        "SELECT id, filename FROM documents WHERE chat_id = ?",
        (chat_id,),
    )

    documents = cursor.fetchall()

    connection.close()

    return documents


def create_chat_in_db(chat_id: str, title: str, chat_type: str = "knowledge"):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        """
        INSERT INTO chats (id, title, chat_type, last_activity_at)
        VALUES (?, ?, ?, ?)
        """,
        (chat_id, title, chat_type, current_timestamp_ms()),
    )

    connection.commit()
    connection.close()


def get_chats_from_db(chat_type=None):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    # En son aktivite olan sohbet en üstte. Zamanı bilinmeyen eski sohbetler
    # en alta, kendi aralarında en yeni eklenen üstte olacak şekilde sıralanır.
    query = "SELECT id, title FROM chats"
    parameters = ()

    if chat_type:
        query += " WHERE chat_type = ?"
        parameters = (chat_type,)

    query += " ORDER BY last_activity_at IS NULL, last_activity_at DESC, rowid DESC"

    cursor.execute(query, parameters)
    chats = cursor.fetchall()

    connection.close()

    return chats


def save_message(
    chat_id: str,
    sender: str,
    text: str,
    sources=None,
    emotion=None,
) -> int:
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    if sources is None:
        sources = []

    sources_json = json.dumps(sources)

    cursor.execute(
        """
        INSERT INTO messages (chat_id, sender, text, sources, emotion)
        VALUES (?, ?, ?, ?, ?)
        """,
        (chat_id, sender, text, sources_json, emotion),
    )
    message_id = cursor.lastrowid
    cursor.execute(
        "UPDATE chats SET last_activity_at = ? WHERE id = ?",
        (current_timestamp_ms(), chat_id),
    )

    connection.commit()
    connection.close()
    return message_id


def get_messages_from_db(chat_id: str)->list[dict]:
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        """
        SELECT id, sender, text, sources, emotion
        FROM messages
        WHERE chat_id = ?
        ORDER BY id ASC
        """,
        (chat_id,),
    )

    rows = cursor.fetchall()

    connection.close()

    messages = []

    for message_id, sender, text, sources_json, emotion in rows:
        sources = json.loads(sources_json) if sources_json else []

        messages.append(
            {
                "id": message_id,
                "sender": sender,
                "text": text,
                "sources": sources,
                "emotion": emotion,
            }
        )

    return messages

def get_message_from_db(chat_id:str, message_id:str)-> dict | None:
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()
    cursor.execute(
        """
        SELECT sender, text, emotion
        FROM messages
        WHERE id =  ? AND chat_id = ?
        ORDER BY id ASC
        """,
        (message_id,chat_id,),
    )
    row = cursor.fetchone()
    connection.close()
    if row == None :
        return None
    message = {
        "sender": row[0],
        "text": row[1],
        "emotion": row[2],
    }
    return message







# Sohbet yoksa None döner; varlık kontrolü için de kullanılır.
def get_chat_type(chat_id: str):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        "SELECT chat_type FROM chats WHERE id = ?",
        (chat_id,),
    )

    row = cursor.fetchone()

    connection.close()

    return row[0] if row else None

#chat_id'ye göre session id bulunuyor
#ilk chatte None döner.
def get_agent_session_id(chat_id: str):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        "SELECT agent_session_id FROM chats WHERE id = ?",
        (chat_id,),
    )

    row = cursor.fetchone()

    connection.close()

    return row[0] if row else None


def save_agent_session_id(chat_id: str, session_id: str):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        "UPDATE chats SET agent_session_id = ? WHERE id = ?",
        (session_id, chat_id),
    )

    connection.commit()
    connection.close()


def update_chat_title_in_db(chat_id: str, title: str):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        "UPDATE chats SET title = ? WHERE id = ?",
        (title, chat_id),
    )

    connection.commit()
    connection.close()


def delete_chat_from_db(chat_id: str):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        "DELETE FROM messages WHERE chat_id = ?",
        (chat_id,),
    )

    cursor.execute(
        "DELETE FROM documents WHERE chat_id = ?",
        (chat_id,),
    )

    cursor.execute(
        "DELETE FROM chats WHERE id = ?",
        (chat_id,),
    )

    connection.commit()
    connection.close()


def delete_document_from_db(chat_id: str, filename: str):
    connection = sqlite3.connect(DATABASE_PATH)
    cursor = connection.cursor()

    cursor.execute(
        """
        DELETE FROM documents
        WHERE chat_id = ? AND filename = ?
        """,
        (chat_id, filename),
    )

    connection.commit()
    connection.close()

