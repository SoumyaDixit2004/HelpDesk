/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  Mic, 
  Send, 
  FileText, 
  Upload, 
  Trash2, 
  Loader2, 
  Volume2, 
  VolumeX, 
  Search, 
  Brain, 
  History,
  AlertCircle
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";

// --- Types ---
interface Message {
  role: "user" | "model";
  text: string;
  isThinking?: boolean;
  confidence?: number;
  sources?: string[];
}

interface UploadedFile {
  filename: string;
  originalName: string;
}

// --- Components ---

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const chatEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  // Initialize Gemini
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

  useEffect(() => {
    fetchFiles();
    setupSpeechRecognition();
    // Initial greeting
    setMessages([
      { 
        role: "model", 
        text: "Hello! I'm your Agentic University Helpdesk Assistant. I can help with admissions, exams, timetables, and more. You can upload university documents (PDFs) for me to reference, or ask me to search the web." 
      }
    ]);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fetchFiles = async () => {
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      setFiles(data);
    } catch (err) {
      console.error("Failed to fetch files", err);
    }
  };

  const setupSpeechRecognition = () => {
    if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = "en-US";

      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInput(transcript);
        setIsRecording(false);
        handleSend(transcript);
      };

      recognitionRef.current.onerror = (event: any) => {
        console.error("Speech recognition error", event.error);
        setIsRecording(false);
        setError("Speech recognition failed. Please try again.");
      };

      recognitionRef.current.onend = () => {
        setIsRecording(false);
      };
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      recognitionRef.current?.stop();
    } else {
      setError(null);
      recognitionRef.current?.start();
      setIsRecording(true);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.[0]) return;
    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", e.target.files[0]);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        await fetchFiles();
      }
    } catch (err) {
      console.error("Upload failed", err);
      setError("Failed to upload file.");
    } finally {
      setIsUploading(false);
    }
  };

  const deleteFile = async (filename: string) => {
    try {
      await fetch(`/api/files/${filename}`, { method: "DELETE" });
      await fetchFiles();
    } catch (err) {
      console.error("Delete failed", err);
    }
  };

  const speak = async (text: string) => {
    if (!isVoiceEnabled) return;
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Say clearly: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Kore" },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        const binary = atob(base64Audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: "audio/pcm;rate=24000" });
        
        // Use AudioContext to play raw PCM
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        const buffer = audioCtx.createBuffer(1, bytes.length / 2, 24000);
        const channelData = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < channelData.length; i++) {
          channelData[i] = view.getInt16(i * 2, true) / 32768;
        }
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start();
      }
    } catch (err) {
      console.error("TTS failed", err);
    }
  };

  const handleSend = async (textOverride?: string) => {
    const query = textOverride || input;
    if (!query.trim() || isProcessing) return;

    const userMessage: Message = { role: "user", text: query };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsProcessing(true);
    setError(null);

    // Add a temporary "thinking" message
    setMessages(prev => [...prev, { role: "model", text: "Analyzing query and retrieving context...", isThinking: true }]);

    try {
      // 1. Get context from uploaded files
      const fileContextParts = await Promise.all(
        files.map(async (file) => {
          const res = await fetch(`/api/files/${file.filename}`);
          const data = await res.json();
          return {
            inlineData: {
              data: data.base64,
              mimeType: data.mimeType,
            },
          };
        })
      );

      // 2. Call Gemini with Tools and History
      const historyParts = messages.slice(-10).map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          ...fileContextParts.map(p => ({ role: "user", parts: [p] })),
          ...historyParts,
          { role: "user", parts: [{ text: `User Query: ${query}\n\nContext: You are a University Helpdesk Assistant. Use the provided documents (if any) and your tools to answer the student's question accurately. If the answer is not in the documents, use Google Search. Maintain a professional and helpful tone.` }] }
        ],
        config: {
          tools: [{ googleSearch: {} }],
          systemInstruction: "You are an autonomous university helpdesk agent. You have access to university documents and the web. Always cite your sources if possible. If you are unsure, state your confidence level.",
        },
      });

      const modelText = response.text || "I'm sorry, I couldn't generate a response.";
      const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map(c => c.web?.uri).filter(Boolean) as string[];

      // 3. Update messages
      setMessages(prev => {
        const filtered = prev.filter(m => !m.isThinking);
        return [...filtered, { 
          role: "model", 
          text: modelText, 
          sources: sources?.length > 0 ? sources : undefined,
          confidence: 0.95 // Simulated confidence for demo
        }];
      });

      // 4. Speak response
      if (isVoiceEnabled) {
        speak(modelText);
      }

    } catch (err) {
      console.error("Gemini error", err);
      setError("I encountered an error while processing your request. Please check your API key or try again.");
      setMessages(prev => prev.filter(m => !m.isThinking));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F5] text-[#1A1A1A] font-sans flex flex-col md:flex-row overflow-hidden">
      {/* Sidebar - Document Manager */}
      <aside className="w-full md:w-80 bg-white border-r border-gray-200 p-6 flex flex-col gap-6 overflow-y-auto">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-2 bg-blue-50 rounded-lg">
            <Brain className="w-6 h-6 text-blue-600" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Helpdesk Agent</h1>
        </div>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2">
              <FileText className="w-3 h-3" />
              University Docs
            </h2>
            <label className="cursor-pointer p-1 hover:bg-gray-100 rounded-full transition-colors">
              <Upload className="w-4 h-4 text-blue-600" />
              <input type="file" className="hidden" accept=".pdf" onChange={handleFileUpload} disabled={isUploading} />
            </label>
          </div>

          <div className="space-y-2">
            {isUploading && (
              <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-xl animate-pulse">
                <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                <span className="text-sm text-blue-700">Uploading...</span>
              </div>
            )}
            {files.length === 0 && !isUploading && (
              <p className="text-sm text-gray-400 italic text-center py-4">No documents uploaded yet.</p>
            )}
            {files.map((file) => (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                key={file.filename} 
                className="group flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-transparent hover:border-gray-200 transition-all"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
                  <span className="text-sm font-medium truncate">{file.originalName}</span>
                </div>
                <button 
                  onClick={() => deleteFile(file.filename)}
                  className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-50 hover:text-red-600 rounded-lg transition-all"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </motion.div>
            ))}
          </div>
        </section>

        <section className="mt-auto pt-6 border-t border-gray-100">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 flex items-center gap-2">
              <History className="w-3 h-3" />
              Settings
            </h2>
          </div>
          <button 
            onClick={() => setIsVoiceEnabled(!isVoiceEnabled)}
            className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all ${
              isVoiceEnabled ? 'bg-blue-50 border-blue-100 text-blue-700' : 'bg-gray-50 border-gray-100 text-gray-500'
            }`}
          >
            <span className="text-sm font-medium">Voice Response</span>
            {isVoiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
        </section>
      </aside>

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col relative bg-white md:bg-[#F5F5F5]">
        {/* Chat Header */}
        <header className="bg-white border-b border-gray-200 p-4 md:hidden flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="w-5 h-5 text-blue-600" />
            <span className="font-semibold">Helpdesk Agent</span>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
          <div className="max-w-3xl mx-auto space-y-6">
            <AnimatePresence initial={false}>
              {messages.map((msg, idx) => (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div className={`max-w-[85%] md:max-w-[75%] p-4 rounded-2xl shadow-sm ${
                    msg.role === "user" 
                      ? "bg-blue-600 text-white rounded-tr-none" 
                      : "bg-white border border-gray-100 text-gray-800 rounded-tl-none"
                  }`}>
                    {msg.isThinking ? (
                      <div className="flex items-center gap-3 text-gray-400 italic text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {msg.text}
                      </div>
                    ) : (
                      <>
                        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                        {msg.sources && (
                          <div className="mt-3 pt-3 border-t border-gray-50 space-y-1">
                            <p className="text-[10px] uppercase font-bold text-gray-400 tracking-widest">Sources</p>
                            {msg.sources.map((url, i) => (
                              <a key={i} href={url} target="_blank" rel="noreferrer" className="block text-[11px] text-blue-500 hover:underline truncate">
                                {url}
                              </a>
                            ))}
                          </div>
                        )}
                        {msg.confidence && (
                          <div className="mt-2 flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Confidence: {(msg.confidence * 100).toFixed(0)}%</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* Input Area */}
        <div className="p-4 md:p-8 bg-gradient-to-t from-white md:from-[#F5F5F5] via-white md:via-[#F5F5F5] to-transparent">
          <div className="max-w-3xl mx-auto">
            {error && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-4 p-3 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-700 text-sm"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </motion.div>
            )}
            
            <div className="relative group">
              <div className="absolute inset-0 bg-blue-600/5 blur-xl rounded-full opacity-0 group-focus-within:opacity-100 transition-opacity" />
              <div className="relative flex items-center gap-2 bg-white p-2 rounded-2xl shadow-xl border border-gray-100">
                <button 
                  onClick={toggleRecording}
                  className={`p-3 rounded-xl transition-all ${
                    isRecording ? 'bg-red-50 text-red-600 animate-pulse' : 'hover:bg-gray-50 text-gray-400'
                  }`}
                >
                  <Mic className="w-5 h-5" />
                </button>
                <input 
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  placeholder="Ask about admissions, exams, or upload a PDF..."
                  className="flex-1 bg-transparent border-none focus:ring-0 text-[15px] py-2 px-1"
                />
                <button 
                  onClick={() => handleSend()}
                  disabled={!input.trim() || isProcessing}
                  className={`p-3 rounded-xl transition-all ${
                    input.trim() && !isProcessing 
                      ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' 
                      : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                </button>
              </div>
            </div>
            <p className="mt-3 text-center text-[11px] text-gray-400 uppercase tracking-widest font-medium">
              Agentic Multimodal Assistant • Powered by Gemini 3
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
