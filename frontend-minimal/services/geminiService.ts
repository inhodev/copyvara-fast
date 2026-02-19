import { AutoLinkSuggestion, Document, DocumentStatus, KnowledgeRelationSignal, QASession } from "../types";

type SourceType = 'chatgpt' | 'gemini' | 'claude' | 'manual';

type AnalyzeContextDoc = Pick<Document, 'id' | 'title' | 'topicTags' | 'summaryText'>;

interface ApiEnvelope<T> {
  data?: T;
  meta?: {
    requestId: string;
    modelUsed: 'gpt-5-nano' | 'gpt-5-mini';
    fallbackUsed: boolean;
    confidence: number;
    ambiguity: boolean;
    retryReason?: string;
  };
}

interface AnalyzeData extends Partial<Document> {
  relationSignals?: KnowledgeRelationSignal[];
  autoLinkSuggestions?: AutoLinkSuggestion[];
}

type SupabaseDocumentRow = {
  id: string;
  title: string;
  raw_text: string | null;
  summary: string | null;
  bullets: any | null;
  tags: any | null;
  viz_data: any | null;
  created_at: string;
};

const RAW_SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_URL = RAW_SUPABASE_URL
  ?.trim()
  .replace(/^https?:\/\/https?:\/\//i, 'https://')
  .replace(/\/$/, '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
let hasLoggedSupabaseEnv = false;

const callServerApi = async <T>(path: string, payload: unknown): Promise<T> => {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const bodyText = await res.text();
  let json: unknown = {};
  try {
    json = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const textForError = bodyText || JSON.stringify(json || {});
    throw new Error(`API ${path} failed (${res.status}): ${textForError}`);
  }

  return json as T;
};

const ensureConfig = () => {
  if (!hasLoggedSupabaseEnv) {
    console.log('[Supabase Debug] VITE_SUPABASE_URL =', SUPABASE_URL);
    console.log('[Supabase Debug] VITE_SUPABASE_ANON_KEY exists =', Boolean(SUPABASE_ANON_KEY));
    hasLoggedSupabaseEnv = true;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase 환경변수(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)가 설정되지 않았습니다.');
  }

  if (!/^https:\/\//i.test(SUPABASE_URL)) {
    throw new Error(`VITE_SUPABASE_URL 형식 오류: ${SUPABASE_URL}`);
  }
};

const callSupabaseRest = async <T>(pathWithQuery: string): Promise<T> => {
  ensureConfig();

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathWithQuery}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'X-Client-Version': 'copyvara-web-v0.3'
    }
  });

  const json = await res.json().catch(() => ([]));
  if (!res.ok) {
    const message = json?.error?.message || json?.message || 'Supabase REST 조회 실패';
    throw new Error(message);
  }
  return json as T;
};

const toSourceType = (value: unknown): Document['sourceType'] => {
  const v = String(value || '').toLowerCase();
  if (v === 'chatgpt' || v === 'gemini' || v === 'claude' || v === 'manual' || v === 'url') return v;
  return 'manual';
};

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];

export const fetchPersistedDocuments = async (limit = 200): Promise<Document[]> => {
  const rows = await callSupabaseRest<SupabaseDocumentRow[]>(
    `documents?select=id,title,raw_text,summary,bullets,tags,viz_data,created_at&order=created_at.desc&limit=${limit}`
  );

  return (rows || []).map((row) => {
    return {
      id: String(row.id),
      workspaceId: 'w1',
      sourceType: 'manual',
      title: String(row.title || '제목 없는 문서'),
      rawText: String(row.raw_text || ''),
      docType: 'text',
      status: DocumentStatus.Done,
      aiMeta: {
        modelUsed: 'gpt-4o-mini',
        confidence: 1
      },
      summaryText: String(row.summary || ''),
      summaryBullets: Array.isArray(row.bullets) ? row.bullets : [],
      knowledgeScore: 50,
      topicTags: Array.isArray(row.tags) ? row.tags : [],
      vizData: row.viz_data,
      createdAt: String(row.created_at || new Date().toISOString())
    } as any; // Cast for now until types are fully updated
  });
};

// Helper to determine source type from text/url
export const detectSourceType = (input: string): SourceType => {
  const text = input.trim();

  const chatgptShare = /^https?:\/\/chatgpt\.com\/share\/[a-z0-9-]+\/?$/i.test(text);
  const geminiShare = /^https?:\/\/gemini\.google\.com\/share\/[a-z0-9]+\/?$/i.test(text);
  const claudeShare = /^https?:\/\/claude\.ai\/share\/[a-f0-9-]+\/?$/i.test(text);

  if (chatgptShare || text.includes('chatgpt.com') || text.includes('openai.com')) return 'chatgpt';
  if (geminiShare || text.includes('gemini.google.com')) return 'gemini';
  if (claudeShare || text.includes('claude.ai')) return 'claude';
  return 'manual';
};

export const analyzeInput = async (text: string): Promise<AnalyzeData> => {
  const response = await callServerApi<any>('/api/summarize', {
    raw_text: text,
  });

  return {
    id: response.id || `temp-${Date.now()}`,
    title: response.title,
    rawText: text,
    summaryText: response.summary,
    summaryBullets: response.bullets,
    topicTags: response.tags,
    vizData: response.viz_data,
    status: DocumentStatus.Done,
    docType: 'text',
    knowledgeScore: 50,
    createdAt: new Date().toISOString()
  } as any;
};

export const askQuestion = async (question: string) => {
  const response = await callServerApi<{ answer: string }>('/api/ask', {
    question,
  });

  return {
    answer: response.answer,
  };
};

export const fetchQAHistory = async (limit = 100): Promise<QASession[]> => {
  const rows = await callSupabaseRest<any[]>(
    `qa_history?select=id,question,answer,created_at&order=created_at.desc&limit=${limit}`
  );

  return (rows || []).map((row) => ({
    id: String(row.id),
    question: String(row.question),
    answer: String(row.answer),
    evidence: [],
    createdAt: String(row.created_at || new Date().toISOString())
  }));
};

// generateRAGAnswer is deprecated in favor of askQuestion
