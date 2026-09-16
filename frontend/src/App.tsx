import { useEffect, useRef, useState } from "react";
import "./App.css";
import { useAgentAudio } from "./hooks/useAgentAudio";
import { useVoiceRecorder } from "./hooks/useVoiceRecorder";
import { VoiceMessage } from "./components/VoiceMessage";
import { VoiceStage, type VoiceStageStatus } from "./components/VoiceStage";
import { createPlaceholderPeaks } from "./waveform";

type Message = {
  text: string;
  sender: "user" | "bot";
  sources?: string[];
  emoji?: string | null;
  message_id?: number;
};

type ChatDocument = {
  id: number;
  filename: string;
};

// "voice" de Neocortex agent'ıyla konuşur; farkı cevapları yazı yerine ses
// olarak göstermesi ve sohbetlerinin ayrı listelenmesidir.
type ChatMode = "knowledge" | "agent" | "voice";

const AGENT_PATH = "/agent";
const VOICE_PATH = "/voice";

const getModeFromPath = (): ChatMode => {
  const path = window.location.pathname;

  if (path.startsWith(VOICE_PATH)) {
    return "voice";
  }

  return path.startsWith(AGENT_PATH) ? "agent" : "knowledge";
};

const getModePath = (mode: ChatMode): string => {
  if (mode === "voice") {
    return VOICE_PATH;
  }

  return mode === "agent" ? AGENT_PATH : "/";
};

// Yazılı ve sesli agent sekmeleri aynı backend uçlarını kullanır: /agent/chat,
// belge yükleme yok, RAG yok.
const isAgentChatMode = (mode: ChatMode): boolean => mode !== "knowledge";

// Her sekmenin metinleri tek yerde toplanır; JSX'te üçlü koşul zinciri olmaz.
const MODE_CONFIG: Record<
  ChatMode,
  {
    tab: string;
    icon: string;
    title: string;
    subtitle: string;
    placeholder: string;
    welcome: {
      heading: string;
      text: string;
      tips: string[];
    };
  }
> = {
  knowledge: {
    tab: "📚 Knowledge",
    icon: "📚",
    title: "Knowledge Assistant",
    subtitle: "Document AI",
    placeholder: "Belgelerin hakkında bir soru sor...",
    welcome: {
      heading: "Belgelerinle konuş",
      text: "PDF, DOCX veya TXT dosyalarını yükle ve içerikleri hakkında doğal dilde sorular sor.",
      tips: ["📄 Belge yükle", "💬 Soru sor", "🔎 Kaynakları gör"],
    },
  },
  agent: {
    tab: "🤖 Agent",
    icon: "🤖",
    title: "AI Agent",
    subtitle: "Neocortex",
    placeholder: "AI Agent'a bir mesaj yaz...",
    welcome: {
      heading: "AI Agent ile konuş",
      text: "Neocortex karakteriyle sohbet et. Agent, aynı sohbet içindeki konuşmaları hatırlar.",
      tips: [
        "💬 Mesaj yaz",
        "🧠 Sohbet hafızası",
        "😊 Duyguları gör",
        "🔊 Sesli dinle",
      ],
    },
  },
  voice: {
    tab: "🔊 Sesli",
    icon: "🔊",
    title: "Sesli Agent",
    subtitle: "Neocortex",
    placeholder: "Sesli Agent'a bir mesaj yaz...",
    welcome: {
      heading: "Sesli Agent ile konuş",
      text: "Sen yaz, Neocortex karakteri sesli cevap versin. Cevaplar otomatik çalar, yazıya dökülmez.",
      tips: [
        "💬 Mesaj yaz",
        "🔊 Sesli cevap",
        "😊 Duyguları gör",
        "🧠 Sohbet hafızası",
      ],
    },
  },
};

const CHAT_TITLE_MAX_LENGTH = 30;

// Sohbet başlığı ilk mesajdan üretilir. Uzun mesajlar kelime ortasından değil,
// son tam kelimeden kesilir.
const createChatTitle = (text: string): string => {
  const normalizedText = text.trim().replace(/\s+/g, " ");

  if (normalizedText.length <= CHAT_TITLE_MAX_LENGTH) {
    return normalizedText;
  }

  const cutText = normalizedText.slice(0, CHAT_TITLE_MAX_LENGTH);

  // Sınırdan hemen sonra boşluk geliyorsa kesilen kısım zaten tam kelimedir.
  const endsOnWord = normalizedText[CHAT_TITLE_MAX_LENGTH] === " ";
  const lastSpaceIndex = cutText.lastIndexOf(" ");

  // Kelime sınırı çok başta kalıyorsa (ör. tek bir uzun kelime) başlık
  // anlamsız kısalmasın diye karakter sınırından kesilir.
  const title =
    endsOnWord || lastSpaceIndex < CHAT_TITLE_MAX_LENGTH / 2
      ? cutText
      : cutText.slice(0, lastSpaceIndex);

  return `${title.replace(/[\s.,;:!?-]+$/, "")}…`;
};

function App() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [mode, setMode] = useState<ChatMode>(getModeFromPath);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [provider, setProvider] = useState<"openai" | "ollama">("openai");
  const [chatId, setChatId] = useState("");
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Sohbet geçmişi yüklendiğinde true olur; bir sonraki kaydırma animasyonsuz yapılır.
  const scrollInstantlyRef = useRef(false);
  const [isVoiceChatEnabled, setIsVoiceChatEnabled] = useState(false);
  // Agent cevabı beklenirken sesli sohbet kapatılırsa güncel değer okunabilsin
  // diye state'in yanında ref'te de tutulur.
  const isVoiceChatEnabledRef = useRef(false);
  // Geç gelen yanıtların, kullanıcı başka bir sohbete veya moda geçtikten
  // sonra yanlış ekrana yazılmaması için aktif sohbet ve mod burada tutulur.
  const activeChatIdRef = useRef("");
  const activeModeRef = useRef<ChatMode>(mode);
  // Ses çalma, durdurma, ilerleme ve dalga formu useAgentAudio içinde.
  const {
    playingMessageId,
    audioLoadingMessageId,
    audioError,
    playbackTime,
    playbackDuration,
    waveforms,
    stopAudio,
    playMessageAudio,
    toggleMessageAudio,
    seekTo,
  } = useAgentAudio(activeChatIdRef);

  const selectChat = (newChatId: string) => {
    // Başka bir sohbete veya moda geçilince önceki sohbetin sesi susturulur.
    if (newChatId !== activeChatIdRef.current) {
      stopAudio();
    }

    activeChatIdRef.current = newChatId;
    setChatId(newChatId);
  };

  const addMessageToChat = (targetChatId: string, newMessage: Message) => {
    if (activeChatIdRef.current !== targetChatId) {
      return;
    }

    setMessages((previousMessages) => [...previousMessages, newMessage]);
  };
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDocumentsPanelOpen, setIsDocumentsPanelOpen] = useState(true);
  const [chatDocuments, setChatDocuments] = useState<ChatDocument[]>([]);
  useEffect(() => {
    // Sohbet yeni açıldıysa doğrudan en alta inilir; yeni mesajlarda yumuşak
    // kaydırılır. Uzun sohbetlerde tüm geçmişin gözün önünden akması önlenir.
    const behavior = scrollInstantlyRef.current ? "auto" : "smooth";

    scrollInstantlyRef.current = false;

    messagesEndRef.current?.scrollIntoView({
      behavior,
    });
  }, [messages, loadingChatId]);
  type Chat = {
    id: string;
    title: string;
  };

  const startVoiceInput = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Tarayıcınız sesli yazmayı desteklemiyor.");
      return;
    }

    // Zaten dinliyorsa tekrar başlatma
    if (isListening) {
      return;
    }
    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;

    recognition.lang = "tr-TR";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      console.log("Speech recognition started");
      setIsListening(true);
    };

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;

      console.log("Transcript:", transcript);

      setMessage((previousMessage) =>
        previousMessage ? `${previousMessage} ${transcript}` : transcript,
      );
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      console.log("Speech recognition ended");
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.start();
  };

  const toggleVoiceChat = () => {
    const nextValue = !isVoiceChatEnabled;

    isVoiceChatEnabledRef.current = nextValue;
    setIsVoiceChatEnabled(nextValue);

    if (!nextValue) {
      stopAudio();
    }
  };

  useEffect(() => {
    const loadProvider = async () => {
      try {
        const response = await fetch("http://127.0.0.1:8000/settings/provider");

        const data = await response.json();

        setProvider(data.provider);
      } catch (error) {
        console.error("Provider bilgisi alınamadı:", error);
      }
    };

    loadProvider();
  }, []);

  const changeProvider = async (newProvider: "openai" | "ollama") => {
    try {
      const response = await fetch("http://127.0.0.1:8000/settings/provider", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: newProvider,
        }),
      });

      if (!response.ok) {
        throw new Error("Provider değiştirilemedi.");
      }

      const data = await response.json();

      setProvider(data.provider);
    } catch (error) {
      console.error("Provider değiştirme hatası:", error);
    }
  };

  const deleteChat = async (chatToDeleteId: string) => {
    const response = await fetch(
      `http://127.0.0.1:8000/chats/${chatToDeleteId}`,
      {
        method: "DELETE",
      },
    );

    if (!response.ok) {
      return;
    }

    const updatedChats = await loadChats(mode);

    if (!updatedChats) {
      return;
    }

    if (chatToDeleteId === activeChatIdRef.current) {
      setSelectedFiles([]);

      if (updatedChats.length > 0) {
        const nextChat = updatedChats[0];

        selectChat(nextChat.id);
        await loadMessages(nextChat.id);
        await loadChatDocuments(nextChat.id);
      } else {
        selectChat("");
        setMessages([]);
        setChatDocuments([]);
      }
    }
  };

  const [chats, setChats] = useState<Chat[]>([]);
  // Backend, seçili moddaki sohbetleri en son aktiviteden en eskiye sıralı döndürür.
  const loadChats = async (chatMode: ChatMode): Promise<Chat[] | null> => {
    const response = await fetch(
      `http://127.0.0.1:8000/chats?chat_type=${chatMode}`,
    );
    const data = await response.json();

    // Bu arada mod değiştiyse eski modun listesi ekrana basılmaz.
    if (chatMode !== activeModeRef.current) {
      return null;
    }

    const formattedChats = data.chats.map((chat: [string, string]) => ({
      id: chat[0],
      title: chat[1],
    }));

    setChats(formattedChats);

    return formattedChats;
  };

  useEffect(() => {
    loadChats(getModeFromPath());
  }, []);

  // Mod değişince ekran boş bir sohbetle başlar ve o modun sohbetleri yüklenir.
  const applyMode = (newMode: ChatMode) => {
    activeModeRef.current = newMode;
    recognitionRef.current?.stop();
    setMode(newMode);
    // Yeni modun listesi gelene kadar eski modun sohbetleri gösterilmez.
    setChats([]);
    selectChat("");
    setMessages([]);
    setChatDocuments([]);
    setSelectedFiles([]);
    setMessage("");
    loadChats(newMode);
  };

  // Tarayıcının geri/ileri butonları modu da değiştirir. Dinleyici bilerek
  // yalnızca bir kez kurulur: applyMode bağımlılığa eklenirse her çizimde
  // sökülüp yeniden takılır. applyMode sadece ref'lere ve state güncelleyicilere
  // dokunduğu için ilk çizimdeki kopyası doğru çalışır.
  useEffect(() => {
    const handlePopState = () => applyMode(getModeFromPath());

    window.addEventListener("popstate", handlePopState);

    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const changeMode = (newMode: ChatMode) => {
    if (newMode === mode) {
      return;
    }

    window.history.pushState(null, "", getModePath(newMode));
    applyMode(newMode);
  };

  const createChat = async (newChatId: string, title: string) => {
    await fetch("http://127.0.0.1:8000/chats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: newChatId,
        title: title,
        chat_type: mode,
      }),
    });
  };

  // Yeni sohbet veritabanında hemen oluşturulmaz; ekran boşaltılır. İlk mesaj
  // gönderildiğinde sendMessage sohbeti mesajın başlığıyla oluşturur. Böylece
  // hiç kullanılmayan "Yeni Sohbet" kayıtları listede birikmez.
  const startNewChat = () => {
    selectChat("");
    setMessages([]);
    setChatDocuments([]);
    setSelectedFiles([]);
  };

  const loadMessages = async (chatId: string) => {
    const response = await fetch(
      `http://127.0.0.1:8000/chats/${chatId}/messages`,
    );

    const data = await response.json();

    const formattedMessages: Message[] = data.messages.map(
      (message: {
        sender: "user" | "bot";
        text: string;
        sources?: string[];
        emoji?: string | null;
        id: number;
      }) => ({
        sender: message.sender,
        text: message.text,
        sources: message.sources || [],
        emoji: message.emoji,
        message_id: message.id,
      }),
    );

    if (activeChatIdRef.current !== chatId) {
      return;
    }

    // Geçmiş yüklendiği için bir sonraki kaydırma animasyonsuz yapılır.
    scrollInstantlyRef.current = true;
    setMessages(formattedMessages);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;

    if (files) {
      const newFiles = Array.from(files);

      setSelectedFiles((previousFiles) => [...previousFiles, ...newFiles]);
    }

    event.target.value = "";
  };

  // textToSend verilmezse mesaj kutusundaki yazı gönderilir. Mikrofondan gelen
  // metin kutuya hiç yazılmadan doğrudan buraya verilir.
  const sendMessage = async (textToSend?: string) => {
    const currentMessage = (textToSend ?? message).trim();

    if (currentMessage === "") {
      return;
    }

    if (textToSend === undefined) {
      setMessage("");
    }

    let currentChatId = chatId;

    if (!currentChatId) {
      currentChatId = `chat-${Date.now()}`;

      const title = createChatTitle(currentMessage);

      await createChat(currentChatId, title);

      selectChat(currentChatId);
      await loadChats(mode);
    }

    setLoadingChatId(currentChatId);

    try {
      const userMessage: Message = {
        text: currentMessage,
        sender: "user",
      };

      if (messages.length === 0 && chatId) {
        const title = createChatTitle(currentMessage);

        await fetch(`http://127.0.0.1:8000/chats/${currentChatId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: title,
          }),
        });

        await loadChats(mode);
      }

      addMessageToChat(currentChatId, userMessage);

      if (selectedFiles.length > 0) {
        for (const file of selectedFiles) {
          const formData = new FormData();

          formData.append("file", file);
          formData.append("chat_id", currentChatId);

          const uploadResponse = await fetch("http://127.0.0.1:8000/upload", {
            method: "POST",
            body: formData,
          });

          if (!uploadResponse.ok) {
            const errorData = await uploadResponse.json();

            addMessageToChat(currentChatId, {
              text:
                errorData.detail || `${file.name} yüklenirken bir hata oluştu.`,
              sender: "bot",
            });

            return;
          }
        }
        setSelectedFiles([]);
        await loadChatDocuments(currentChatId);
      }

      const chatEndpoint = isAgentChatMode(mode) ? "/agent/chat" : "/chat";

      const response = await fetch(`http://127.0.0.1:8000${chatEndpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: currentMessage,
          chat_id: currentChatId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();

        addMessageToChat(currentChatId, {
          text: errorData.detail || "Bir hata oluştu.",
          sender: "bot",
        });

        return;
      }

      const data = await response.json();

      const botMessage: Message = {
        text: data.answer,
        sender: "bot",
        sources: data.sources || [],
        emoji: data.agent?.emoji,
        message_id: data.message_id,
      };

      addMessageToChat(currentChatId, botMessage);

      // Sesli sohbet açıksa ses beklenmeden istenir; böylece yükleniyor
      // göstergesi ve sohbet listesi sesin gelmesini beklemez. Kullanıcı bu
      // arada başka bir sohbete geçtiyse o sohbetteki ses kesilmez.
      // Sesli sekmede cevaplar her zaman sesli; yazılı sekmede "Sesli yanıt"
      // anahtarına bağlı.
      const shouldPlayAnswer =
        mode === "voice" || (mode === "agent" && isVoiceChatEnabledRef.current);

      if (
        shouldPlayAnswer &&
        activeChatIdRef.current === currentChatId &&
        botMessage.message_id !== undefined
      ) {
        playMessageAudio(currentChatId, botMessage.message_id);
      }

      setSelectedFiles([]);
    } catch (error) {
      console.error("Mesaj gönderme hatası:", error);

      addMessageToChat(currentChatId, {
        text: "Sunucuya bağlanırken bir hata oluştu.",
        sender: "bot",
      });
    } finally {
      // Bu arada başka bir sohbette yeni istek başladıysa onun yükleniyor
      // göstergesi silinmez.
      setLoadingChatId((currentLoadingChatId) =>
        currentLoadingChatId === currentChatId ? null : currentLoadingChatId,
      );

      // Mesaj atılan sohbet listenin en üstüne çıksın; hata olsa bile
      // sıralama güncellenir.
      await loadChats(mode).catch((error) =>
        console.error("Sohbet listesi yenilenemedi:", error),
      );
    }
  };

  // Mikrofon kaydı wav'a çevrilip Neocortex'e yazdırılır; dönen metin mesaj
  // kutusuna hiç uğramadan gönderilir ve cevap sesli çalar.
  const { recorderStatus, recorderError, toggleRecording } = useVoiceRecorder(
    (text) => {
      sendMessage(text);
    },
  );

  const deleteDocument = async (filename: string) => {
    if (!chatId) {
      return;
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:8000/chats/${chatId}/documents/${encodeURIComponent(filename)}`,
        {
          method: "DELETE",
        },
      );

      const data = await response.json();

      if (!response.ok) {
        setMessages((previousMessages) => [
          ...previousMessages,
          {
            text: data.detail || "Belge silinirken bir hata oluştu.",
            sender: "bot",
          },
        ]);
        return;
      }

      setChatDocuments((previousDocuments) =>
        previousDocuments.filter((document) => document.filename !== filename),
      );

      setSelectedFiles((previousFiles) =>
        previousFiles.filter((file) => file.name !== filename),
      );
    } catch (error) {
      console.error("Belge silme hatası:", error);

      setMessages((previousMessages) => [
        ...previousMessages,
        {
          text: "Belge silinirken sunucuya bağlanılamadı.",
          sender: "bot",
        },
      ]);
    }
  };

  const loadChatDocuments = async (selectedChatId: string) => {
    setChatDocuments([]);

    const response = await fetch(
      `http://127.0.0.1:8000/chats/${selectedChatId}/documents`,
    );

    if (!response.ok) {
      return;
    }

    const data = await response.json();

    const formattedDocuments: ChatDocument[] = data.documents.map(
      (document: [number, string]) => ({
        id: document[0],
        filename: document[1],
      }),
    );

    if (activeChatIdRef.current !== selectedChatId) {
      return;
    }

    setChatDocuments(formattedDocuments);
  };

  // Başlık, zaten yüklü olan sohbet listesinden bulunur; ek istek gerekmez.
  // Sohbet seçili değilse veya liste henüz gelmediyse varsayılan başlık gösterilir.
  const headerTitle =
    chats.find((chat) => chat.id === chatId)?.title || "Yeni Sohbet";

  // Ses çözülmediyse mesaj ID'sinden üretilen sabit yer tutucu desen kullanılır;
  // böylece dinlenmemiş mesajlar için Neocortex'e istek gitmez.
  const getMessagePeaks = (messageId: number): number[] =>
    waveforms.get(messageId)?.peaks ?? createPlaceholderPeaks(messageId);

  const getMessageDuration = (messageId: number): number =>
    playingMessageId === messageId
      ? playbackDuration
      : (waveforms.get(messageId)?.duration ?? 0);

  const getMessageStatus = (messageId: number) => {
    if (playingMessageId === messageId) {
      return "playing" as const;
    }

    if (audioLoadingMessageId === messageId) {
      return "loading" as const;
    }

    return audioError?.messageId === messageId
      ? ("error" as const)
      : ("idle" as const);
  };

  // Sahnede çalan ses gösterilir; hiçbiri çalmıyorsa son agent cevabı.
  const lastAgentMessageId = messages.findLast(
    (msg) => msg.sender === "bot" && msg.message_id !== undefined,
  )?.message_id;

  const stageMessageId =
    playingMessageId ?? audioLoadingMessageId ?? lastAgentMessageId ?? null;

  const stageMessage = messages.find(
    (msg) => msg.message_id === stageMessageId,
  );

  // Sahne sırayla şunları gösterir: mikrofon dinliyor, kayıt yazıya çevriliyor,
  // agent düşünüyor, ses hazırlanıyor/çalıyor.
  const stageStatus: VoiceStageStatus =
    recorderStatus === "recording"
      ? "listening"
      : recorderStatus === "processing"
        ? "transcribing"
        : loadingChatId === chatId
          ? "thinking"
          : stageMessageId === null
            ? "idle"
            : getMessageStatus(stageMessageId);

  return (
    <div className="app" data-theme={theme}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">{MODE_CONFIG[mode].icon}</div>

          <div className="sidebar-brand-text">
            <span className="sidebar-brand-title">
              {MODE_CONFIG[mode].title}
            </span>
            <span className="sidebar-brand-subtitle">
              {MODE_CONFIG[mode].subtitle}
            </span>
          </div>
        </div>

        <div className="mode-switch" role="tablist" aria-label="Asistan seçimi">
          {(["knowledge", "agent", "voice"] as const).map((tabMode) => (
            <button
              key={tabMode}
              type="button"
              role="tab"
              aria-selected={mode === tabMode}
              className={
                mode === tabMode ? "mode-option active-mode" : "mode-option"
              }
              title={MODE_CONFIG[tabMode].title}
              onClick={() => changeMode(tabMode)}
            >
              {MODE_CONFIG[tabMode].tab}
            </button>
          ))}
        </div>
        <button className="new-chat-button" onClick={startNewChat}>
          + Yeni Sohbet
        </button>

        <div className="chat-list">
          {chats.map((chat) => (
            <div
              className={
                chat.id === chatId ? "chat-item active-chat" : "chat-item"
              }
              key={chat.id}
              onClick={() => {
                selectChat(chat.id);
                loadMessages(chat.id);
                loadChatDocuments(chat.id);
                setSelectedFiles([]);
              }}
            >
              <span className="chat-title">{chat.title}</span>

              <button
                className="delete-chat-button"
                onClick={(event) => {
                  event.stopPropagation();
                  deleteChat(chat.id);
                }}
                title="Sohbeti sil"
              >
                🗑️
              </button>
            </div>
          ))}
        </div>
        {mode === "knowledge" && (
          <div className="provider-settings">
            <label htmlFor="provider-select">AI Modeli</label>

            <select
              id="provider-select"
              value={provider}
              onChange={(event) =>
                changeProvider(event.target.value as "openai" | "ollama")
              }
            >
              <option value="openai">OpenAI (Önerilen)</option>
              <option value="ollama">Local (Ollama)</option>
            </select>
          </div>
        )}
        <button
          type="button"
          className="theme-button"
          onClick={() =>
            setTheme((currentTheme) =>
              currentTheme === "dark" ? "light" : "dark",
            )
          }
        >
          {theme === "dark" ? "☀️ Açık Tema" : "🌙 Koyu Tema"}
        </button>
      </aside>

      <main className="chat-area">
        <header className="chat-header">
          <h1 title={headerTitle}>{headerTitle}</h1>
        </header>

        {mode === "voice" && (
          <VoiceStage
            emoji={stageMessage?.emoji}
            status={stageStatus}
            canPlay={stageMessageId !== null}
            peaks={
              stageMessageId !== null ? getMessagePeaks(stageMessageId) : []
            }
            hasRealWaveform={
              stageMessageId !== null && waveforms.has(stageMessageId)
            }
            currentTime={playingMessageId === stageMessageId ? playbackTime : 0}
            duration={
              stageMessageId !== null ? getMessageDuration(stageMessageId) : 0
            }
            errorText={
              audioError?.messageId === stageMessageId
                ? audioError.text
                : undefined
            }
            onToggle={() => {
              if (stageMessageId !== null) {
                toggleMessageAudio(chatId, stageMessageId);
              }
            }}
            onSeek={(ratio) => seekTo(ratio * playbackDuration)}
          />
        )}

        <div className="messages">
          {messages.length === 0 ? (
            <div className="welcome-message">
              <div className="welcome-icon">{MODE_CONFIG[mode].icon}</div>

              <h2>{MODE_CONFIG[mode].welcome.heading}</h2>

              <p>{MODE_CONFIG[mode].welcome.text}</p>

              <div className="welcome-tips">
                {MODE_CONFIG[mode].welcome.tips.map((tip) => (
                  <span key={tip}>{tip}</span>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, index) => (
              <div
                // Veritabanından gelen mesajlar kalıcı ID'leriyle eşleşir; henüz
                // ID'si olmayan mesajlar (yeni yazılan, hata mesajları) sırasıyla.
                key={msg.message_id ?? `local-${index}`}
                className={`message-wrapper ${
                  msg.sender === "user" ? "user-wrapper" : "bot-wrapper"
                }`}
              >
                <div className="message-row">
                  {msg.sender === "bot" && msg.emoji && (
                    <span className="message-emotion">{msg.emoji}</span>
                  )}

                  {mode === "voice" &&
                  msg.sender === "bot" &&
                  msg.message_id !== undefined ? (
                    // Sesli sekmede agent'ın yazısı gösterilmez, yerine ses balonu çizilir.
                    <VoiceMessage
                      peaks={getMessagePeaks(msg.message_id)}
                      hasRealWaveform={waveforms.has(msg.message_id)}
                      status={getMessageStatus(msg.message_id)}
                      currentTime={
                        playingMessageId === msg.message_id ? playbackTime : 0
                      }
                      duration={getMessageDuration(msg.message_id)}
                      errorText={
                        audioError?.messageId === msg.message_id
                          ? audioError.text
                          : undefined
                      }
                      onToggle={() =>
                        toggleMessageAudio(chatId, msg.message_id!)
                      }
                      onSeek={(ratio) => seekTo(ratio * playbackDuration)}
                    />
                  ) : (
                    <div
                      className={
                        msg.sender === "user" ? "user-message" : "bot-message"
                      }
                    >
                      {msg.text}
                    </div>
                  )}
                </div>

                {mode === "agent" &&
                  msg.sender === "bot" &&
                  msg.message_id !== undefined && (
                    <div
                      className={`message-actions ${
                        msg.emoji ? "has-emotion" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className={`message-audio-button ${
                          playingMessageId === msg.message_id
                            ? "playing"
                            : audioLoadingMessageId === msg.message_id
                              ? "loading"
                              : ""
                        }`}
                        title={
                          playingMessageId === msg.message_id ||
                          audioLoadingMessageId === msg.message_id
                            ? "Sesi durdur"
                            : "Mesajı sesli dinle"
                        }
                        // onClick sonradan çalıştığı için TypeScript üstteki
                        // kontrolü buraya taşımaz; ID'nin var olduğu kesin.
                        onClick={() =>
                          toggleMessageAudio(chatId, msg.message_id!)
                        }
                      >
                        <span className="message-audio-icon">
                          {playingMessageId === msg.message_id
                            ? "⏹"
                            : audioLoadingMessageId === msg.message_id
                              ? "⏳"
                              : "🔊"}
                        </span>
                        {playingMessageId === msg.message_id
                          ? "Durdur"
                          : audioLoadingMessageId === msg.message_id
                            ? "Yükleniyor"
                            : "Dinle"}
                      </button>

                      {audioError?.messageId === msg.message_id && (
                        <span className="message-audio-error">
                          {audioError.text}
                        </span>
                      )}
                    </div>
                  )}

                {msg.sender === "bot" &&
                  msg.sources &&
                  msg.sources.length > 0 && (
                    <div className="message-sources">
                      {msg.sources.map((source) => (
                        <span key={source} className="source-bubble">
                          📄
                          <span className="source-tooltip">{source}</span>
                        </span>
                      ))}
                    </div>
                  )}
              </div>
            ))
          )}

          {loadingChatId === chatId && (
            <div className="bot-message loading-message">
              <span className="loading-dot">●</span>
              <span className="loading-dot">●</span>
              <span className="loading-dot">●</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-area">
          {selectedFiles.length > 0 && (
            <div className="selected-files">
              {selectedFiles.map((file, index) => (
                <div className="selected-file" key={`${file.name}-${index}`}>
                  <span className="selected-file-name">📄 {file.name}</span>

                  <button
                    className="remove-file-button"
                    onClick={() => {
                      setSelectedFiles((previousFiles) =>
                        previousFiles.filter(
                          (_, fileIndex) => fileIndex !== index,
                        ),
                      );
                    }}
                    title="Dosyayı kaldır"
                    type="button"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="input-row">
            <div className="message-composer">
              {mode === "knowledge" && (
                <label className="file-button" title="Dosya ekle">
                  +
                  <input
                    type="file"
                    onChange={handleFileChange}
                    hidden
                    multiple
                  />
                </label>
              )}

              <input
                type="text"
                placeholder={MODE_CONFIG[mode].placeholder}
                className="message-input"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && loadingChatId !== chatId) {
                    sendMessage();
                  }
                }}
              />

              {mode === "voice" && (
                <>
                  {recorderError && (
                    <span className="voice-record-error">{recorderError}</span>
                  )}

                  <button
                    type="button"
                    className={`voice-record-button ${
                      recorderStatus === "recording" ? "recording" : ""
                    }`}
                    title={
                      recorderStatus === "recording"
                        ? "Kaydı bitir ve gönder"
                        : "Mikrofona konuş"
                    }
                    disabled={recorderStatus === "processing"}
                    onClick={toggleRecording}
                  >
                    {recorderStatus === "recording"
                      ? "⏹"
                      : recorderStatus === "processing"
                        ? "⏳"
                        : "🎤"}

                    <span className="voice-record-label">
                      {recorderStatus === "recording"
                        ? "Bitir"
                        : recorderStatus === "processing"
                          ? "Çevriliyor"
                          : "Konuş"}
                    </span>
                  </button>
                </>
              )}

              {mode === "knowledge" && (
                <button
                  type="button"
                  className={`voice-button ${isListening ? "listening" : ""}`}
                  title={isListening ? "Dinleniyor..." : "Sesle yaz"}
                  onClick={startVoiceInput}
                >
                  {isListening ? "🔴" : "🎤"}
                </button>
              )}

              {mode === "agent" && (
                <button
                  type="button"
                  className={`voice-chat-toggle ${
                    isVoiceChatEnabled ? "active" : ""
                  }`}
                  title={
                    isVoiceChatEnabled
                      ? "Sesli yanıtı kapat"
                      : "Agent cevaplarını otomatik sesli oku"
                  }
                  aria-pressed={isVoiceChatEnabled}
                  onClick={toggleVoiceChat}
                >
                  {isVoiceChatEnabled ? "🔊" : "🔇"}
                  <span className="voice-chat-toggle-label">Sesli yanıt</span>
                </button>
              )}

              <button
                className="send-button"
                onClick={() => sendMessage()}
                disabled={loadingChatId === chatId}
                title="Gönder"
              >
                ➤
              </button>
            </div>
          </div>
        </div>
      </main>
      {isAgentChatMode(mode) ? null : isDocumentsPanelOpen ? (
        <aside className="documents-panel">
          <div className="documents-header">
            <h3>Belgeler</h3>

            <button
              type="button"
              className="documents-toggle-button"
              onClick={() => setIsDocumentsPanelOpen(false)}
              title="Belge panelini kapat"
            >
              &gt;
            </button>
          </div>

          <div className="documents-list">
            {chatDocuments.length === 0 ? (
              <p className="no-documents">Bu sohbette belge yok.</p>
            ) : (
              chatDocuments.map((document) => (
                <div className="document-item" key={document.id}>
                  <span className="document-icon">📄</span>
                  <span className="document-name">{document.filename}</span>

                  <button
                    type="button"
                    className="document-delete-button"
                    onClick={() => deleteDocument(document.filename)}
                    title="Belgeyi sil"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      ) : (
        <button
          type="button"
          className="documents-open-button"
          onClick={() => setIsDocumentsPanelOpen(true)}
          title="Belge panelini aç"
        >
          &lt;
        </button>
      )}
    </div>
  );
}

export default App;
